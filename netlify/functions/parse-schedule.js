const https = require("https");

function httpsPost(hostname, path, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: "POST",
      headers: {
        ...headers,
        "Content-Length": Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error("Invalid JSON: " + data.slice(0, 300))); }
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

  let pages;
  try {
    const body = JSON.parse(event.body);
    pages = body.pages;
    if (!pages || !pages.length) throw new Error("No pages provided");
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request: " + e.message }) };
  }

  console.log(`Received ${pages.length} pages, total base64 size: ${Math.round(pages.reduce((s,p) => s+p.length, 0)/1024)}KB`);

  // Process in batches of 3 pages to stay under API limits
  // then merge the results
  const BATCH_SIZE = 3;
  const allRooms = {};

  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    const batch = pages.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i/BATCH_SIZE) + 1;
    console.log(`Processing batch ${batchNum}: pages ${i+1}-${Math.min(i+BATCH_SIZE, pages.length)}`);

    const content = batch.map(b64 => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: b64 }
    }));

    content.push({
      type: "text",
      text: `This is part of an Epic OR surgery schedule. Extract every room with a surgical case.
For each room, return the exact room name from the Room column and the surgeon last name from Providers column.
This schedule has a "Pt Dept" column that identifies the location. Use it to determine the correct room name:
This schedule has a "Pt Dept" column. Use it to determine the correct room name format:

ROOM MAPPING RULES (use Pt Dept to determine location):
- Pt Dept "SLEH PERIOPERATIVE SERVICES" → Main OR. Return room as-is (e.g. "OR 3", "OR 14")
- Pt Dept "BSLMC OPSC PERIOPERATIVE SERVICES" → Jamail OR. Prefix room with "Jamail" (e.g. "OR 3" → "Jamail OR 3")
- Pt Dept "BSLMC MCNAIR OR PERIOPERATIVE SERVICES" → McNair OR. Return room as-is (e.g. "Mc OR 1")
- Pt Dept "BSLMC OTM PERIOPERATIVE SERVICES" → OTM OR. Return room as-is (e.g. "OTM OR 11")
- Pt Dept "BSLMC OTM ENDOSCOPY SERVICES" + Room "Endo 01" → return "Endo 01" (mixed case = OTM Endo)
- Pt Dept "SLEH ENDOSCOPY SERVICES" + Room "ENDO 01" → return "ENDO 01" (ALL CAPS = Main Endo)
- Skip rows where Room says "Motility 1", "Motility 2", or Pt Dept contains "ICU"
- Skip rows where Providers says "Virtual, Surgeon"
- Skip rows where Pt Dept contains "RAD" or "SEDATION"

Return the room name EXACTLY as specified above (preserve capitalization — it matters for Endo rooms).
Return ONLY valid JSON, nothing else:
{"rooms": {"OR 22": "Ongkasuwan", "OTM OR 10": "Ahmed", "Endo 01": "Keihanian", "ENDO 01": "Abidi", "Mc OR 1": "Martin", "Jamail OR 3": "Chang"}}`
    });

    const reqBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content }]
    });

    try {
      const result = await httpsPost(
        "api.anthropic.com",
        "/v1/messages",
        {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        reqBody
      );

      if (result.body.error) {
        console.error(`Batch ${batchNum} error:`, result.body.error.message);
        continue;
      }

      const raw = result.body.content[0].text.trim().replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      const batchRooms = parsed.rooms || {};
      console.log(`Batch ${batchNum} found ${Object.keys(batchRooms).length} rooms`);

      // Merge — don't overwrite existing surgeon assignments
      for (const [room, surgeon] of Object.entries(batchRooms)) {
        if (!allRooms[room]) allRooms[room] = surgeon;
      }
    } catch(e) {
      console.error(`Batch ${batchNum} failed:`, e.message);
    }
  }

  console.log(`Total rooms found: ${Object.keys(allRooms).length}`);
  console.log("Rooms:", JSON.stringify(allRooms));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rooms: allRooms })
  };
};
