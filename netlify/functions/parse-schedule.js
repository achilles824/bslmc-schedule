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

  console.log(`Received ${pages.length} pages, total size: ${Math.round(pages.reduce((s,p) => s+p.length,0)/1024)}KB`);

  // Send all pages in a single API call — much faster than batching
  const content = pages.map(b64 => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: b64 }
  }));

  content.push({
    type: "text",
    text: `This is an Epic OR surgery schedule with a "Pt Dept" column. Extract every room with a surgical case across ALL pages.

ROOM MAPPING RULES — use Pt Dept to determine location:
- Pt Dept "SLEH PERIOPERATIVE SERVICES" → Main OR. Return room as-is (e.g. "OR 3")
- Pt Dept "BSLMC OPSC PERIOPERATIVE SERVICES" → Jamail OR. Prefix with "Jamail" (e.g. "OR 3" → "Jamail OR 3")
- Pt Dept "BSLMC MCNAIR OR PERIOPERATIVE SERVICES" → McNair OR. Return room as-is (e.g. "Mc OR 1")
- Pt Dept "BSLMC OTM PERIOPERATIVE SERVICES" → OTM OR. Return room as-is (e.g. "OTM OR 11")
- Pt Dept "BSLMC OTM ENDOSCOPY SERVICES" + Room "Endo 01" (mixed case) → return "Endo 01"
- Pt Dept "SLEH ENDOSCOPY SERVICES" + Room "ENDO 01" (ALL CAPS) → return "ENDO 01"
- Skip: "Motility 1", "Motility 2", any Pt Dept with "ICU", "RAD", "SEDATION"
- Skip: Providers column says "Virtual, Surgeon"

For each unique room (first occurrence only), also return the surgeon last name and first procedure (max 40 chars).

Return ONLY valid JSON, no markdown:
{"rooms": {"OR 22": {"surgeon": "Ongkasuwan", "procedure": "MICROLARYNGOSCOPY"}, "OTM OR 10": {"surgeon": "Ahmed", "procedure": "ARTHROSCOPY SHOULDER"}, "Jamail OR 3": {"surgeon": "Chang", "procedure": "AQUEOUS DRAINAGE DEVICE"}, "ENDO 01": {"surgeon": "Abidi", "procedure": "COLONOSCOPY"}}}`
  });

  try {
    const reqBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{ role: "user", content }]
    });

    console.log(`Single API call, body size: ${Math.round(reqBody.length/1024)}KB`);

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

    console.log("Anthropic response status:", result.status);

    if (result.body.error) {
      console.error("Anthropic error:", result.body.error.message);
      return { statusCode: 500, body: JSON.stringify({ error: result.body.error.message }) };
    }

    const raw = result.body.content[0].text.trim().replace(/```json|```/g, "").trim();
    console.log("Raw response preview:", raw.slice(0, 300));

    const parsed = JSON.parse(raw);
    console.log(`Rooms found: ${Object.keys(parsed.rooms || {}).length}`);
    console.log("Rooms:", JSON.stringify(Object.keys(parsed.rooms || {})));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed)
    };

  } catch(e) {
    console.error("Function error:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
