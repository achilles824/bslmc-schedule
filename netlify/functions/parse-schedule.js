// parse-schedule v6
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
    text: `This is part of an Epic OR surgery schedule with "Room", "Pt Dept", "Anes. Type", and "Providers" columns.

DEPARTMENT RULES (use Pt Dept column to determine location):
- Pt Dept contains "BSLMC OPSC" → ALWAYS Jamail OR. Prefix room with "Jamail": "OR 2" → "Jamail OR 2", "OR 3" → "Jamail OR 3". No exceptions.
- Pt Dept contains "SLEH PERIOPERATIVE" → ALWAYS Main OR. Return room as-is: "OR 04", "OR 16". No exceptions.
- Pt Dept contains "BSLMC MCNAIR OR PERIOPERATIVE" → McNair OR, return as-is: "Mc OR 1"
- Pt Dept contains "BSLMC OTM PERIOPERATIVE" → OTM OR, return as-is: "OTM OR 5"
- Pt Dept contains "BSLMC OTM ENDOSCOPY" + mixed-case room "Endo 01" → return "Endo 01" (OTM Endo)
- Pt Dept contains "SLEH ENDOSCOPY" + ALL-CAPS room "ENDO 01" → return "ENDO 01" (Main Endo)
- NIR rooms → return "NIR 1" or "NIR 2"
- IR rooms → return "IR 1" or "IR 2"
- MRI room (may appear as "RM-IR MRI") → return "MRI"

SKIP RULES — skip a row if ALL of these are true:
- Providers column says "Virtual, Surgeon" AND
- The room is NOT an MRI room AND
- Anes. Type is NOT "General"

Also always skip: Motility rooms, ICU rows, Rad Mod Sedation rows, OTM Rad Mod Sedation rows.

For each unique room (first occurrence only), return:
- surgeon: last name from Providers column (or "Unknown" if Virtual/Surgeon)
- procedure: first procedure name, max 40 chars
- time: the start time of the first case formatted as HH:MM (e.g. "07:30", "08:00"). The Time column shows times like "073 0" meaning 07:30, "080 0" meaning 08:00, "130 0" meaning 13:00.
Return ONLY valid JSON, no markdown:
{"rooms":{"OR 04":{"surgeon":"Lerner","procedure":"NEPHRECTOMY","time":"07:30"},"Jamail OR 2":{"surgeon":"Weng","procedure":"REPAIR RETINAL DETACHMENT","time":"09:30"},"MRI":{"surgeon":"Unknown","procedure":"MRI PROCEDURE","time":"13:00"}}}`
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
