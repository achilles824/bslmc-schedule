// parse-schedule v7
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
    text: `This is an Epic OR surgery schedule. It has "Room" and "Pt Dept" columns.

IMPORTANT: There are TWO separate physical hospitals with rooms that share the same numbers.
The Pt Dept column tells you which hospital each case belongs to. Read it carefully for EVERY row.

HOSPITAL MAPPING — determined ONLY by Pt Dept:

1. Pt Dept contains "BSLMC OPSC" → JAMAIL OR (different hospital from Main OR)
   - Room "OR 1" with BSLMC OPSC → return "Jamail OR 1"
   - Room "OR 2" with BSLMC OPSC → return "Jamail OR 2"
   - Room "OR 3" with BSLMC OPSC → return "Jamail OR 3"
   - NEVER return a BSLMC OPSC room as "Main OR". Always prefix with "Jamail".

2. Pt Dept contains "SLEH PERIOPERATIVE" → MAIN OR (St. Luke's Episcopal Hospital)
   - Room "OR 1" with SLEH → return "OR 01" (as-is, it becomes Main OR 1)
   - Room "OR 3" with SLEH → return "OR 03" (as-is, it becomes Main OR 3)
   - Room "OR 16" with SLEH → return "OR 16"
   - NEVER prefix SLEH rooms with "Jamail".

3. Pt Dept contains "BSLMC MCNAIR OR PERIOPERATIVE" → McNair OR
   - Return room as-is: "Mc OR 1", "Mc OR 3"

4. Pt Dept contains "BSLMC OTM PERIOPERATIVE" → OTM OR
   - Return room as-is: "OTM OR 5", "OTM OR 11"

5. Pt Dept contains "BSLMC OTM ENDOSCOPY" + mixed-case room "Endo 01" → return "Endo 01"

6. Pt Dept contains "SLEH ENDOSCOPY" + ALL-CAPS room "ENDO 01" → return "ENDO 01"

7. NIR rooms (Neuro IR) → return "NIR 1" or "NIR 2"

8. IR rooms → return "IR 1" or "IR 2"

9. MRI room (may appear as "RM-IR MRI") → return "MRI"

SKIP RULES — skip a row entirely if:
- Providers column says "Virtual, Surgeon" AND room is NOT MRI AND Anes. Type is NOT "General"
- Motility rooms
- ICU rows
- Rad Mod Sedation / OTM Rad Mod Sedation

For each unique room (first occurrence only), return:
- surgeon: last name from Providers column (or "Unknown" if Virtual/Surgeon)
- procedure: first procedure, max 40 chars
- time: start time formatted HH:MM (e.g. "07:30"). Time column shows "073 0" = 07:30, "130 0" = 13:00.

Return ONLY valid JSON, no markdown:
{"rooms":{"OR 04":{"surgeon":"Lerner","procedure":"NEPHRECTOMY","time":"07:30"},"Jamail OR 2":{"surgeon":"Weng","procedure":"REPAIR RETINAL DETACHMENT","time":"09:30"},"Jamail OR 3":{"surgeon":"Chang","procedure":"AQUEOUS DRAINAGE","time":"07:00"},"OR 03":{"surgeon":"Smith","procedure":"LITHOTRIPSY","time":"08:00"}}}`
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

    // Post-process: if "Jamail OR N" exists, remove any plain "OR N" in the same batch
    // (Claude sometimes returns both when seeing the same OPSC room multiple times)
    const rooms = parsed.rooms || {};
    for (const key of Object.keys(rooms)) {
      const m = key.match(/^Jamail OR (\d+)$/i);
      if (m) {
        const plainKey = "OR " + m[1];
        const paddedKey = "OR 0" + m[1];
        delete rooms[plainKey];
        delete rooms[paddedKey];
      }
    }
    parsed.rooms = rooms;
    console.log("Rooms found: " + Object.keys(parsed.rooms).length);

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
