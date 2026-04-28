// parse-schedule v8 - rewritten for new PDF format with "Location" column
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

    const prompt = `You are extracting OR room assignments from a hospital surgery schedule. Each row in this schedule has these columns: Location, Room, Time, Length, Procedures, Anes. Type, Providers.

You must read the **Location** column to determine which hospital/department the room belongs to. The Location text may wrap across multiple lines. Match these Location values EXACTLY:

LOCATION → ROOM PREFIX MAPPING (this is the most important rule):

1. Location = "BSLMC OPSC OR" → ALWAYS Jamail OR
   - Room "OR 1" with Location "BSLMC OPSC OR" → return as "Jamail OR 1"
   - Room "OR 2" with Location "BSLMC OPSC OR" → return as "Jamail OR 2"
   - Room "OR 3" with Location "BSLMC OPSC OR" → return as "Jamail OR 3"
   - Room "OR 5" with Location "BSLMC OPSC OR" → return as "Jamail OR 5"
   - Room "OR 6" with Location "BSLMC OPSC OR" → return as "Jamail OR 6"
   - Room "YAG" with Location "BSLMC OPSC OR" → SKIP (laser room, not staffed)

2. Location = "SLEH OR" → ALWAYS Main OR
   - Room "OR 02" with Location "SLEH OR" → return as "Main OR 2"
   - Room "OR 17" with Location "SLEH OR" → return as "Main OR 17"
   - Room "OR 25" with Location "SLEH OR" → return as "Main OR 25"
   - Room "RM-IR MRI" with Location "SLEH OR" → return as "MRI"
   - Room "RM-IR General 1" with Location "SLEH OR" → return as "IR 1"
   - Room "RM-IR General 2" with Location "SLEH OR" → return as "IR 2"
   - Room "RM-IR Neuro 1" with Location "SLEH OR" → return as "NIR 1"
   - Room "RM-IR Neuro 2" with Location "SLEH OR" → return as "NIR 2"
   - Room "Rad Mod Sedation" with Location "SLEH OR" → SKIP

3. Location = "BSLMC MCNAIR OR OPERATING ROOM" (often wraps as "BSLMC / MCNAIR / OR / OPERAT / ING / ROOM") → ALWAYS McNair OR
   - Room "Mc OR 1" or "McOR1" → return as "McNair OR 1"
   - Room "Mc OR 7" → return as "McNair OR 7"

4. Location = "BSLMC OTM OR" → ALWAYS OTM OR
   - Room "OTM OR 2" → return as "OTM OR 2"
   - Room "OTM OR 12" → return as "OTM OR 12"

5. Location = "BSLMC OTM ENDO" → ALWAYS OTM Endo
   - Room "Endo 02" (mixed case) → return as "OTM Endo 2"
   - Room "Endo 10" → return as "OTM Endo 10"
   - Room "Motility 1" → SKIP
   - Room "OTM Rad Mod Sedation" → SKIP

6. Location = "SLEH ENDO" → ALWAYS Main Endo
   - Room "ENDO 02" (uppercase) → return as "Main Endo 2"
   - Room "ENDO 03" → return as "Main Endo 3"

ABSOLUTE RULES — NEVER VIOLATE:
- The Location column is the ONLY way to disambiguate. OR 2 at "BSLMC OPSC OR" is Jamail; OR 2 at "SLEH OR" is Main OR. They are different physical rooms in different hospitals and BOTH can appear on the same day.
- NEVER return "Main OR N" for a row whose Location starts with "BSLMC OPSC".
- NEVER return "Jamail OR N" for a row whose Location starts with "SLEH".
- NEVER return plain "OR N" without a prefix. Every room MUST have a prefix (Main OR, Jamail OR, McNair OR, OTM OR, OTM Endo, Main Endo, NIR, IR, or MRI).
- If you cannot determine the Location for a row, SKIP it rather than guessing.

PROVIDER FILTERING:
- If Providers = "Virtual, Surgeon" AND Anes Type = "Moderate Sedation" → SKIP (Rad Mod Sedation, not staffed)
- If Providers = "Virtual, Surgeon" AND Anes Type = "Local" → SKIP (YAG laser, not staffed)
- If Providers = "Virtual, Surgeon" AND Anes Type = "General" → INCLUDE (use surgeon name "Unknown")
- For RM-IR MRI specifically: ALWAYS INCLUDE regardless of provider/anes type

OUTPUT FORMAT:
Return ONLY a JSON object — no preamble, no explanation, no markdown fences. Start your response with { and end with }. Use this exact structure:
{
  "rooms": {
    "Main OR 17": { "surgeon": "Coye", "procedure": "GRAFT SKIN", "time": "08:00" },
    "Jamail OR 2": { "surgeon": "Chancellor", "procedure": "VITRECTOMY", "time": "07:15" },
    "McNair OR 1": { "surgeon": "Harrington", "procedure": "ARTHROPLASTY KNEE", "time": "07:30" }
  }
}

For surgeon: use only the LAST NAME (e.g. "Harrington" not "Harrington, Melvyn A Jr.").
For procedure: use a short 2-4 word description (e.g. "ARTHROPLASTY KNEE" not the full text).
For time: convert military time like "0730" to "07:30" format. Use the FIRST/EARLIEST case time for each room if multiple cases exist.
If a room appears in multiple rows, return ONLY ONE entry per room with the EARLIEST time.`;

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

    // Robust JSON extraction — find first { and last }
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

    // SAFETY NET: Drop any plain "OR N" entries — every room must have a hospital prefix.
    // This catches cases where Claude forgot to prefix a room.
    const cleaned = {};
    for (const [roomName, info] of Object.entries(rooms)) {
      if (/^OR\s*\d+$/i.test(roomName.trim())) {
        console.log(`DROPPED unprefixed room: "${roomName}"`);
        continue;
      }
      cleaned[roomName] = info;
    }

    console.log(`Returning ${Object.keys(cleaned).length} rooms for batch ${batchIndex}`);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ rooms: cleaned }) };

  } catch (err) {
    console.error("Function error:", err.message, err.stack);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
