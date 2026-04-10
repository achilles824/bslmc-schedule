const https = require("https");

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
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
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Invalid JSON response: " + data.slice(0, 200))); }
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
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY environment variable not set" })
    };
  }

  let pages;
  try {
    const body = JSON.parse(event.body);
    pages = body.pages;
    if (!pages || !pages.length) throw new Error("No pages provided");
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request: " + e.message }) };
  }

  try {
    const content = pages.map(b64 => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: b64 }
    }));

    content.push({
      type: "text",
      text: `This is an Epic OR surgery schedule printout. Extract every room that has a surgical case scheduled.
For each room, get the room name exactly as shown in the Room column, and the surgeon last name from the Providers column (format is "LastName, FirstName" - just return the last name).
Ignore rows for "Rad Mod Sedation", "OTM Rad Mod Sedation", or any non-operating room settings. Ignore "Virtual, Surgeon" providers.
Return ONLY valid JSON, no markdown, no explanation:
{"rooms": {"OR 22": "Ongkasuwan", "OTM OR 10": "Ahmed", "Endo 05": "Mansour"}}`
    });

    const data = await httpsPost(
      "https://api.anthropic.com/v1/messages",
      {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content }]
      }
    );

    if (data.error) {
      return { statusCode: 500, body: JSON.stringify({ error: "Anthropic API error: " + data.error.message }) };
    }

    const raw = data.content[0].text.trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed)
    };

  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};
