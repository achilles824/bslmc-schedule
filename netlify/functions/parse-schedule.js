// parse-schedule v3
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
          text: "This is part of an Epic OR surgery schedule with a Pt Dept column. Extract every room with a surgical case.\n\nROOM MAPPING RULES (use Pt Dept column):\n- SLEH PERIOPERATIVE -> Main OR, return room as-is e.g. OR 3\n- BSLMC OPSC PERIOPERATIVE -> Jamail OR, prefix room e.g. OR 3 -> Jamail OR 3\n- BSLMC MCNAIR OR PERIOPERATIVE -> McNair OR, return as-is e.g. Mc OR 1\n- BSLMC OTM PERIOPERATIVE -> OTM OR, return as-is e.g. OTM OR 11\n- BSLMC OTM ENDOSCOPY + mixed case Endo 01 -> return Endo 01\n- SLEH ENDOSCOPY + ALL CAPS ENDO 01 -> return ENDO 01\n- SKIP: Motility rooms, ICU, RAD/SEDATION, Virtual Surgeon providers\n\nFor each unique room return surgeon last name and first procedure max 40 chars.\nReturn ONLY valid JSON:\n{\"rooms\":{\"OR 4\":{\"surgeon\":\"Lerner\",\"procedure\":\"NEPHRECTOMY\"},\"Mc OR 1\":{\"surgeon\":\"Martin\",\"procedure\":\"ARTHROPLASTY KNEE\"}}}"
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
          console.log("Response: " + raw.slice(0, 200));
          const parsed = JSON.parse(raw);
          console.log("Rooms: " + Object.keys(parsed.rooms||{}).length);

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
