// parse-schedule v9 - simpler prompt, fixes missing Main OR (SLEH) cases
const https = require("https");

function httpsPost(hostname, path, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(bodyStr) }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }

  try {
    const { pages, batchIndex } = JSON.parse(event.body);
    if (!pages || !Array.isArray(pages) || pages.length === 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "No pages" }) };
    }

    const totalSize = pages.reduce((s, p) => s + p.length, 0);
    console.log(`Batch ${batchIndex}: ${pages.length} pages, size: ${Math.round(totalSize/1024)}KB`);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "API key not configured" }) };
    }

    const prompt = `Extract every staffed OR room from this hospital surgery schedule. Each row has columns: Location, Room, Time, Length, Procedures, Anes Type, Providers. The Location column text wraps across multiple lines but you can read it.

Use the Location column to determine the room prefix. Apply this mapping:

- Location contains "SLEH" with "OR" (e.g. "SLEH OR") → Main OR
  Examples: "OR 02" → "Main OR 2", "OR 17" → "Main OR 17", "OR 25" → "Main OR 25"
  Special rooms at SLEH: "RM-IR MRI" → "MRI", "RM-IR General 1" → "IR 1", "RM-IR Neuro 1" → "NIR 1"

- Location contains "SLEH" with "ENDO" (e.g. "SLEH ENDO") → Main Endo
  Example: "ENDO 02" → "Main Endo 2"

- Location contains "BSLMC OPSC" → Jamail OR
  Examples: "OR 1" → "Jamail OR 1", "OR 2" → "Jamail OR 2", "OR 5" → "Jamail OR 5"
  Skip rows where Room is "YAG" (laser room, not staffed).

- Location contains "BSLMC MCNAIR" → McNair OR
  Examples: "Mc OR 1" → "McNair OR 1", "Mc OR 7" → "McNair OR 7"

- Location contains "BSLMC OTM" with "OR" (e.g. "BSLMC OTM OR") → OTM OR
  Examples: "OTM OR 2" → "OTM OR 2", "OTM OR 12" → "OTM OR 12"

- Location contains "BSLMC OTM" with "ENDO" (e.g. "BSLMC OTM ENDO") → OTM Endo
  Examples: "Endo 02" → "OTM Endo 2", "Endo 10" → "OTM Endo 10"
  Skip rows where Room is "Motility 1" or "OTM Rad Mod Sedation".

The same room number can exist at two hospitals on the same day (for example, OR 2 at SLEH is "Main OR 2" while OR 2 at BSLMC OPSC is "Jamail OR 2"). Both should be returned. The Location column is what distinguishes them.

Skip rows where Providers is "Virtual, Surgeon" UNLESS:
- Room is "RM-IR MRI" (always include MRI), OR
- Anes Type is "General" (a real case staffed by anesthesia, return surgeon as "Unknown")

Skip rows with Room "Rad Mod Sedation" or "OTM Rad Mod Sedation".

Output ONLY a JSON object — no preamble, no commentary, no markdown. Start with { and end with }. Format:
{
  "rooms": {
    "Main OR 17": { "surgeon": "Coye", "procedure": "GRAFT SKIN SPLIT THICKNESS", "time": "08:00" },
    "Jamail OR 2": { "surgeon": "Chancellor", "procedure": "VITRECTOMY MECHANICAL", "time": "07:15" }
  }
}

For surgeon: use only the LAST NAME. For procedure: short 2-5 word description. For time: convert "0730" to "07:30". If a room appears in multiple rows, return the EARLIEST time.

Be thorough. Return EVERY room from EVERY row, including all SLEH OR rooms (Main OR cases).`;

    const content = [{ type: "text", text: prompt }];
    for (const pageBase64 of pages) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: pageBase64 }
      });
    }

    const reqBody = JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      messages: [{ role: "user", content }]
    });

    console.log(`Sending request to Anthropic, body size: ${Math.round(reqBody.length/1024)}KB`);

    const apiResponse = await httpsPost(
      "api.anthropic.com",
      "/v1/messages",
      {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      reqBody
    );

    console.log(`Anthropic response status: ${apiResponse.status}`);

    if (apiResponse.status !== 200) {
      console.error("Anthropic error:", apiResponse.body);
      return { statusCode: apiResponse.status, headers: cors, body: JSON.stringify({ error: apiResponse.body }) };
    }

    const apiData = JSON.parse(apiResponse.body);
    const textContent = apiData.content?.[0]?.text || "";

    // Robust JSON extraction
    let jsonStr = textContent.trim();
    const firstBrace = jsonStr.indexOf("{");
    const lastBrace = jsonStr.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error("JSON parse error:", e.message);
      console.error("Raw response:", textContent.substring(0, 500));
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Could not parse AI response", raw: textContent.substring(0, 500) }) };
    }

    const rooms = parsed.rooms || {};

    // Drop any plain "OR N" entries — every room must have a hospital prefix.
    const cleaned = {};
    let droppedCount = 0;
    for (const [roomName, info] of Object.entries(rooms)) {
      if (/^OR\s*\d+$/i.test(roomName.trim())) {
        console.log(`DROPPED unprefixed room: "${roomName}"`);
        droppedCount++;
        continue;
      }
      cleaned[roomName] = info;
    }

    console.log(`Batch ${batchIndex}: returning ${Object.keys(cleaned).length} rooms (dropped ${droppedCount} unprefixed). Keys: ${Object.keys(cleaned).join(", ")}`);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ rooms: cleaned }) };

  } catch (err) {
    console.error("Function error:", err.message, err.stack);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
