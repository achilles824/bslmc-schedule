exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { pages } = JSON.parse(event.body);

    const content = pages.map(b64 => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: b64 }
    }));

    content.push({
      type: "text",
      text: `This is an Epic OR surgery schedule printout. Extract every room that has a surgical case scheduled.
For each room, get the room name exactly as shown in the Room column, and the surgeon last name from the Providers column (format is "LastName, FirstName" — just return the last name).
Ignore rows for "Rad Mod Sedation", "OTM Rad Mod Sedation", or any non-operating room settings. Ignore "Virtual, Surgeon" providers.
Return ONLY valid JSON, no markdown, no explanation:
{"rooms": {"OR 22": "Ongkasuwan", "OTM OR 10": "Ahmed", "Endo 05": "Mansour"}}`
    });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content }]
      })
    });

    const data = await response.json();
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
