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

  // Check total size - Netlify limit is ~6MB
  const totalSize = pages.reduce((sum, p) => sum + p.length, 0);
  console.log(`Received ${pages.length} pages, total base64 size: ${Math.round(totalSize/1024)}KB`);

  // Only send first 3 pages to stay under limits (room schedule is usually on first few pages)
  const pagesToSend = pages.slice(0, 3);

  try {
    const content = pagesToSend.map(b64 => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: b64 }
    }));

    content.push({
      type: "text",
      text: `This is an Epic OR surgery schedule. Extract every room with a surgical case.
For each room, return the exact room name from the Room column and the surgeon last name from Providers column.
Skip: "Rad Mod Sedation", "OTM Rad Mod Sedation", non-OR rooms, "Virtual, Surgeon" providers.
Return ONLY this JSON format, nothing else:
{"rooms": {"OR 22": "Ongkasuwan", "OTM OR 10": "Ahmed", "Endo 05": "Mansour"}}`
    });

    const reqBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content }]
    });

    console.log(`Sending request to Anthropic, body size: ${Math.round(reqBody.length/1024)}KB`);

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
      console.error("Anthropic error:", JSON.stringify(result.body.error));
      return { statusCode: 500, body: JSON.stringify({ error: result.body.error.message }) };
    }

    const raw = result.body.content[0].text.trim().replace(/```json|```/g, "").trim();
    console.log("Raw response:", raw.slice(0, 200));

    const parsed = JSON.parse(raw);
    console.log("Rooms found:", Object.keys(parsed.rooms || {}).length);

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
