// parse-schedule v4
const https = require("https");

function httpsPost(hostname, path, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname, path, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(bodyStr) }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error("Invalid JSON: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }) };
  }

  let pages, batchIndex;
  try {
    const body = JSON.parse(event.body);
    pages = body.pages;
    batchIndex = body.batchIndex || 0;
    if (!pages || !pages.length) throw new Error("No pages provided");
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request: " + e.message }) };
  }

  console.log("Batch " + batchIndex + ": " + pages.length + " pages, size: " + Math.round(pages.reduce((s,p)=>s+p.length,0)/1024) + "KB");

  const content = pages.map(b64 => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: b64 }
  }));

  content.push({
    type: "text",
    text: `This is part of an Epic OR surgery schedule. It has a "Room" column and a "Pt Dept" column.

CRITICAL ROOM MAPPING RULES - use BOTH columns together:
1. "SLEH PERIOPERATIVE" dept → Main OR. Return room exactly e.g. "OR 04", "OR 16"
2. "BSLMC OPSC PERIOPERATIVE" dept → Jamail OR. ALWAYS prefix with "Jamail": "OR 2" → "Jamail OR 2", "OR 3" → "Jamail OR 3". NEVER return OPSC rooms as plain "OR N"
3. "BSLMC MCNAIR OR PERIOPERATIVE" dept → McNair OR. Return as-is e.g. "Mc OR 1"
4. "BSLMC OTM PERIOPERATIVE" dept → OTM OR. Return as-is e.g. "OTM OR 5"
5. "BSLMC OTM ENDOSCOPY" dept + mixed-case room "Endo 01" → return "Endo 01"
6. "SLEH ENDOSCOPY" dept + ALL-CAPS room "ENDO 01" → return "ENDO 01"
7. MRI room (may appear as "RM-IR MRI", "MRI", or similar) → return "MRI"
8. NIR room (Neuro IR) → return "NIR 1" or "NIR 2"
9. IR room → return "IR 1" or "IR 2"
10. SKIP: Motility rooms, ICU, RAD/SEDATION rows, "Virtual, Surgeon" providers, OTM Rad Mod Sedation

IMPORTANT: A room labeled "OR 2" or "OR 3" with BSLMC OPSC dept is a JAMAIL room, NOT a Main OR. Always check the Pt Dept column.

For each unique room (first case only), return the surgeon last name and first procedure (max 40 chars).
Return ONLY valid JSON, no markdown:
{"rooms":{"OR 04":{"surgeon":"Lerner","procedure":"NEPHRECTOMY"},"Jamail OR 3":{"surgeon":"Chang","procedure":"AQUEOUS DRAINAGE"},"MRI":{"surgeon":"Smith","procedure":"MRI GUIDED PROCEDURE"},"NIR 1":{"surgeon":"Jones","procedure":"EMBOLIZATION"}}}`
  });

  try {
    const result = await httpsPost(
      "api.anthropic.com", "/v1/messages",
      {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, messages: [{ role: "user", content }] })
    );

    console.log("API status: " + result.status);

    if (result.body.error) {
      console.error("API error: " + result.body.error.message);
      return { statusCode: 500, body: JSON.stringify({ error: result.body.error.message }) };
    }

    const raw = result.body.content[0].text.trim().replace(/```json|```/g, "").trim();
    console.log("Response: " + raw.slice(0, 300));
    const parsed = JSON.parse(raw);
    console.log("Rooms: " + Object.keys(parsed.rooms || {}).length);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed)
    };
  } catch(e) {
    console.error("Error: " + e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
