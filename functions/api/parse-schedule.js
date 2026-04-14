export async function onRequestPost(context) {
  const apiKey = context.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), { status: 500 });
  }

  let pages, batchIndex;
  try {
    const body = await context.request.json();
    pages = body.pages;
    batchIndex = body.batchIndex || 0;
    if (!pages || !pages.length) throw new Error("No pages provided");
  } catch(e) {
    return new Response(JSON.stringify({ error: "Bad request: " + e.message }), { status: 400 });
  }

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
   - Plain "OR N" (no prefix) should ONLY be returned for SLEH PERIOPERATIVE rooms.
   - If the dept is NOT SLEH, do NOT return a plain "OR N" — use the correct prefix.

3. Pt Dept contains "BSLMC MCNAIR OR PERIOPERATIVE" → McNair OR
   - Return room as-is: "Mc OR 1", "Mc OR 3"
   - CRITICAL: McNair rooms in Epic show as "Mc OR 1", "Mc OR 2" etc.
   - NEVER return a McNair room as plain "OR 1" or "OR 2" — always keep the "Mc OR" prefix
   - If you see a room labeled just "OR 1" with BSLMC MCNAIR dept, return it as "Mc OR 1"

4. Pt Dept contains "BSLMC OTM PERIOPERATIVE" → OTM OR
   - Return room as-is: "OTM OR 5", "OTM OR 11"

5. Pt Dept contains "BSLMC OTM ENDOSCOPY" + mixed-case room "Endo 01" → return "Endo 01"

6. Pt Dept contains "SLEH ENDOSCOPY" + ALL-CAPS room "ENDO 01" → return "ENDO 01"

7. NIR / Neuro IR rooms → return "NIR 1" or "NIR 2"
   - Room may appear as "RM-IR Neuro 1", "NIR 1", "Neuro IR 1", or similar
   - Always return as "NIR 1" or "NIR 2"

8. IR / General IR rooms → return "IR 1" or "IR 2"
   - Room may appear as "RM-IR General 1", "IR 1", or similar
   - Always return as "IR 1" or "IR 2"

9. MRI room → return "MRI"
   - Room may appear as "RM-IR MRI" or "MRI"

SPECIAL UNCONDITIONAL RULE:
- If the Room column contains "MRI" or "RM-IR MRI" → ALWAYS include this row, no exceptions
- Return as "MRI" with surgeon "Unknown" and the time from that row
- Do NOT skip MRI rows even if Providers says "Virtual, Surgeon"

SKIP RULES — skip a row entirely if ALL of these are true:
- Providers column says "Virtual, Surgeon"
- AND the Anes. Type column does NOT say "General" (Moderate Sedation, NA, etc. → skip)
- AND the Room is not an MRI room

In other words:
- "Virtual, Surgeon" + "Moderate Sedation" → SKIP
- "Virtual, Surgeon" + "NA" → SKIP  
- "Virtual, Surgeon" + "General" → INCLUDE
- "Virtual, Surgeon" + "General" on any room → INCLUDE

Also always skip regardless of anes type:
- Rows where Room column says "Motility" or "Rad Mod Sedation" or "OTM Rad Mod Sedation"
- ICU rows

EXAMPLES of rows that MUST be included (Virtual/Surgeon + General anesthesia):
  Room: RM-IR MRI, Anes Type: General, Providers: Virtual, Surgeon → return as "MRI", surgeon "Unknown"
  Room: RM-IR Neuro 1, Anes Type: General, Providers: Virtual, Surgeon → return as "NIR 1", surgeon "Unknown"
  Room: RM-IR General 1, Anes Type: General, Providers: Virtual, Surgeon → return as "IR 1", surgeon "Unknown"
  Room: RM-IR Neuro 2, Anes Type: General, Providers: Virtual, Surgeon → return as "NIR 2", surgeon "Unknown"
  Room: RM-IR General 2, Anes Type: General, Providers: Virtual, Surgeon → return as "IR 2", surgeon "Unknown"

For each unique room (first occurrence only), return:
- surgeon: last name from Providers column (or "Unknown" if Virtual/Surgeon)
- procedure: first procedure, max 40 chars
- time: start time formatted HH:MM (e.g. "07:30"). Time column shows "073 0" = 07:30, "130 0" = 13:00.

CRITICAL: Return ONLY the raw JSON object. Do not explain, do not reason, do not write any text before or after the JSON. Start your response with { and end with }. No markdown, no preamble:
{"rooms":{"OR 04":{"surgeon":"Lerner","procedure":"NEPHRECTOMY","time":"07:30"},"Jamail OR 2":{"surgeon":"Weng","procedure":"REPAIR RETINAL DETACHMENT","time":"09:30"}}}`
  });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, messages: [{ role: "user", content }] })
    });

    const result = await response.json();

    if (result.error) {
      return new Response(JSON.stringify({ error: result.error.message }), { status: 500 });
    }

    const responseText = result.content[0].text.trim();
    let raw = responseText.replace(/```json|```/g, "").trim();
    if (!raw.startsWith("{")) {
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1) {
        raw = raw.slice(jsonStart, jsonEnd + 1);
      }
    }

    const parsed = JSON.parse(raw);

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
