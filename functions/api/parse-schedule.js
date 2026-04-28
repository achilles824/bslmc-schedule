// parse-schedule v11 - Cloudflare Pages Function for new PDF format with "Location" column

export async function onRequestPost(context) {
  const apiKey = context.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  let pages, batchIndex;
  try {
    const body = await context.request.json();
    pages = body.pages;
    batchIndex = body.batchIndex ?? 0;
    if (!pages || !pages.length) throw new Error("No pages provided");
  } catch (e) {
    return new Response(JSON.stringify({ error: "Bad request: " + e.message }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const totalSize = pages.reduce((s, p) => s + p.length, 0);
  console.log(`Batch ${batchIndex}: ${pages.length} pages, size: ${Math.round(totalSize / 1024)}KB`);

  const promptText = `Extract every staffed OR room from this hospital surgery schedule. Each row has columns: Location, Room, Time, Length, Procedures, Anes Type, Providers. The Location column text wraps across multiple lines but you can read it.

Use the Location column to determine the room prefix. Apply this mapping:

- Location contains "SLEH" with "OR" (e.g. "SLEH OR") → Main OR
  Examples: "OR 02" → "Main OR 2", "OR 17" → "Main OR 17", "OR 25" → "Main OR 25"
  Special rooms at SLEH: "RM-IR MRI" → "MRI", "RM-IR General 1" → "IR 1", "RM-IR Neuro 1" → "NIR 1"

- Location contains "SLEH" with "ENDO" (e.g. "SLEH ENDO") → Main Endo
  Example: "ENDO 02" → "Main Endo 2"

- Location contains "BSLMC OPSC" → Jamail OR
  Examples: "OR 1" → "Jamail OR 1", "OR 2" → "Jamail OR 2", "OR 5" → "Jamail OR 5"
  Skip rows where Room is "YAG" (laser room, not staffed).

- Location contains "BSLMC MCNAIR" → McNair OR
  Examples: "Mc OR 1" → "McNair OR 1", "Mc OR 7" → "McNair OR 7"

- Location contains "BSLMC OTM" with "OR" (e.g. "BSLMC OTM OR") → OTM OR
  Examples: "OTM OR 2" → "OTM OR 2", "OTM OR 12" → "OTM OR 12"

- Location contains "BSLMC OTM" with "ENDO" (e.g. "BSLMC OTM ENDO") → OTM Endo
  Examples: "Endo 02" → "OTM Endo 2", "Endo 10" → "OTM Endo 10"
  Skip rows where Room is "Motility 1" or "OTM Rad Mod Sedation".

The same room number can exist at two hospitals on the same day (for example, OR 2 at SLEH is "Main OR 2" while OR 2 at BSLMC OPSC is "Jamail OR 2"). Both should be returned. The Location column is what distinguishes them.

Skip rows where Providers is "Virtual, Surgeon" UNLESS:
- Room is "RM-IR MRI" (always include MRI), OR
- Anes Type is "General" (a real case staffed by anesthesia, return surgeon as "Unknown")

Skip rows with Room "Rad Mod Sedation" or "OTM Rad Mod Sedation".

Output ONLY a JSON object — no preamble, no commentary, no markdown. Start with { and end with }. Format:
{
  "rooms": {
    "Main OR 17": { "surgeon": "Coye", "procedure": "GRAFT SKIN", "time": "08:00" },
    "Jamail OR 2": { "surgeon": "Chancellor", "procedure": "VITRECTOMY", "time": "07:15" }
  }
}

For surgeon: use only the LAST NAME. For procedure: short 2-4 word description (keep these brief to save space). For time: convert "0730" to "07:30". If a room appears in multiple rows, return the EARLIEST time.

Be thorough. Return EVERY room from EVERY row, including all SLEH OR rooms (Main OR cases) and all OTM Endo rooms.`;

  // Build content array: prompt text first, then images
  const content = [{ type: "text", text: promptText }];
  for (const b64 of pages) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: b64 }
    });
  }

  try {
    const reqBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      messages: [{ role: "user", content }]
    });

    console.log(`Batch ${batchIndex}: sending request, body size ${Math.round(reqBody.length / 1024)}KB`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: reqBody
    });

    const result = await response.json();
    console.log(`Batch ${batchIndex}: Anthropic response status ${response.status}, stop_reason=${result.stop_reason}, output_tokens=${result.usage?.output_tokens}`);

    if (result.error) {
      console.error(`Batch ${batchIndex}: Anthropic error:`, result.error.message);
      return new Response(JSON.stringify({ error: result.error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (result.stop_reason === "max_tokens") {
      console.error(`Batch ${batchIndex}: TRUNCATED — hit max_tokens. Will attempt salvage.`);
    }

    const responseText = result.content[0].text.trim();

    // Extract JSON: strip code fences, find outermost braces
    let raw = responseText.replace(/```json|```/g, "").trim();
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      raw = raw.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error(`Batch ${batchIndex}: JSON parse failed:`, parseErr.message);
      console.error(`Batch ${batchIndex}: raw start:`, responseText.substring(0, 300));
      console.error(`Batch ${batchIndex}: raw end:`, responseText.substring(Math.max(0, responseText.length - 300)));

      // SALVAGE: regex-extract any complete room entries from a truncated JSON
      const salvaged = {};
      const roomRegex = /"([^"]+?)"\s*:\s*\{\s*"surgeon"\s*:\s*"([^"]*)"\s*,\s*"procedure"\s*:\s*"([^"]*)"\s*,\s*"time"\s*:\s*"([^"]*)"\s*\}/g;
      let m;
      while ((m = roomRegex.exec(raw)) !== null) {
        salvaged[m[1]] = { surgeon: m[2], procedure: m[3], time: m[4] };
      }
      if (Object.keys(salvaged).length > 0) {
        console.log(`Batch ${batchIndex}: salvaged ${Object.keys(salvaged).length} rooms from truncated response`);
        parsed = { rooms: salvaged };
      } else {
        return new Response(JSON.stringify({ error: "Could not parse AI response", raw: responseText.substring(0, 500) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    const rooms = parsed.rooms || {};

    // Safety net: drop any plain "OR N" entries with no hospital prefix
    const cleaned = {};
    let droppedCount = 0;
    for (const [name, info] of Object.entries(rooms)) {
      if (/^OR\s*\d+$/i.test(name.trim())) {
        console.log(`Batch ${batchIndex}: DROPPED unprefixed "${name}"`);
        droppedCount++;
        continue;
      }
      cleaned[name] = info;
    }

    console.log(`Batch ${batchIndex}: returning ${Object.keys(cleaned).length} rooms (dropped ${droppedCount}). Keys: ${Object.keys(cleaned).join(", ")}`);

    return new Response(JSON.stringify({ rooms: cleaned }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    console.error("Function error:", e.message, e.stack);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
