const https = require("https");

// Parse OCR text from Epic schedule
// Lines look like: "OR 3 BSLMC OPSC 070 33 INSERTION, Monitor Anesthesia Care Chang, Peter T."
function parseScheduleText(text) {
  const results = {};
  const lines = text.split(/[\r\n]+/);

  // Dept keywords -> location type
  const deptMap = [
    { pattern: /BSLMC\s+OPSC/i,        type: "jamail"    },
    { pattern: /BSLMC\s+MCNAIR/i,      type: "mcnair"    },
    { pattern: /BSLMC\s+OTM\s+ENDOSC/i,type: "otm_endo"  },
    { pattern: /BSLMC\s+OTM\s+PERI/i,  type: "otm_or"    },
    { pattern: /SLEH\s+ENDOSC/i,       type: "main_endo" },
    { pattern: /SLEH\s+COOLEY/i,       type: "skip"      },
    { pattern: /SLEH\s+PERI/i,         type: "main_or"   },
    { pattern: /SLEH/i,                type: "main_or"   },
  ];

  // Room prefixes to match at start of line
  const roomRe = /^(OTM\s+OR\s*\d{1,2}|Mc\s*OR\s*\d{1,2}|OTM\s+IR\s*\d|OTM\s+Endo\s*\d{1,2}|ENDO\s+\d{1,2}|Endo\s+\d{1,2}|OR\s*\d{1,2}|IR\s+\d|NIR\s*\d|MRI|CT)\b/i;

  // Surgeon pattern: "LastName, FirstName" at end of line
  const surgeonRe = /([A-Z][A-Za-z'\-]+),\s+[A-Z][a-z]/;

  // Procedure: first ALL-CAPS word(s) after the length number
  const procRe = /\d{2,4}\s+\d+\s+([A-Z][A-Z,\s\-\/]{3,40})/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 15) continue;

    // Skip non-surgical lines
    if (/Motility|RAD\s+MOD|SEDATION|Virtual.*Surgeon/i.test(trimmed)) continue;
    if (/^(PERIOP|ENDOSC|SERVICES|E SERVICES)/i.test(trimmed)) continue;

    // Match room at start of line
    const roomMatch = trimmed.match(roomRe);
    if (!roomMatch) continue;

    const roomRaw = roomMatch[1].trim();

    // Detect dept
    let deptType = null;
    for (const { pattern, type } of deptMap) {
      if (pattern.test(trimmed)) { deptType = type; break; }
    }
    if (!deptType || deptType === "skip") continue;

    // Get surgeon
    const surgeonMatch = trimmed.match(surgeonRe);
    if (!surgeonMatch) continue;
    const surgeon = surgeonMatch[1];
    if (/Virtual|Surgeon|Anesthesia/i.test(surgeon)) continue;

    // Get procedure (first keyword)
    const procMatch = trimmed.match(procRe);
    const procedure = procMatch ? procMatch[1].replace(/,\s*$/, "").trim().slice(0, 40) : "";

    // Normalize room name
    let roomNorm = null;
    let m;
    if (deptType === "jamail") {
      m = roomRaw.match(/OR\s*(\d+)/i);
      if (m) roomNorm = "Jamail OR " + parseInt(m[1]);
    } else if (deptType === "mcnair") {
      m = roomRaw.match(/(?:Mc\s*)?OR\s*(\d+)/i);
      if (m) roomNorm = "McNair OR " + parseInt(m[1]);
    } else if (deptType === "otm_or") {
      m = roomRaw.match(/OTM\s+OR\s*(\d+)/i);
      if (m) roomNorm = "OTM OR " + parseInt(m[1]);
    } else if (deptType === "otm_endo") {
      m = roomRaw.match(/(?:OTM\s+)?Endo\s*(\d+)/i);
      if (m) roomNorm = "OTM Endo " + parseInt(m[1]);
    } else if (deptType === "main_endo") {
      m = roomRaw.match(/ENDO\s*(\d+)/i);
      if (m) roomNorm = "Main Endo " + parseInt(m[1]);
    } else if (deptType === "main_or") {
      m = roomRaw.match(/OR\s*(\d+)/i);
      if (m) roomNorm = "Main OR " + parseInt(m[1]);
    } else if (deptType === "ir") {
      m = roomRaw.match(/IR\s*(\d)/i);
      if (m) roomNorm = "IR " + parseInt(m[1]);
    }

    if (roomNorm && !results[roomNorm]) {
      results[roomNorm] = { surgeon, procedure };
    }
  }

  return results;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let ocrText;
  try {
    const body = JSON.parse(event.body);
    ocrText = body.ocrText;
    if (!ocrText || ocrText.length < 100) throw new Error("No OCR text provided");
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request: " + e.message }) };
  }

  console.log(`Received OCR text: ${ocrText.length} chars, ${ocrText.split('\n').length} lines`);

  const rooms = parseScheduleText(ocrText);
  console.log(`Rooms found: ${Object.keys(rooms).length}`);
  console.log("Rooms:", JSON.stringify(Object.keys(rooms)));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rooms })
  };
};
