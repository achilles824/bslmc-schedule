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

const ALLOWED_ORIGINS = [
  'https://achilles824.github.io',
  'https://bslmc-schedule.pages.dev'
];

function getCorsHeaders(event) {
  const origin = (event.headers && event.headers.origin) || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: getCorsHeaders(event), body: '' };
  }

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

IMPORTANT: There are TWO separate physical hospital
