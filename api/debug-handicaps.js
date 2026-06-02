import axios from "axios";
import crypto from "crypto";

const SPREADSHEET_ID = "1sZyBu8ksrYQxN8zIbkdh9QIGwm5dnbTR";
const SHEET_GID      = "276854640";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const steps = [];

  try {
    // Step 1: check env var
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
    steps.push({ step: "env_var", present: !!raw, length: raw ? raw.length : 0 });
    if (!raw) return res.status(200).json({ steps, error: "GOOGLE_SERVICE_ACCOUNT not set" });

    // Step 2: parse JSON
    let creds;
    try { creds = JSON.parse(raw); steps.push({ step: "json_parse", ok: true, email: creds.client_email }); }
    catch (e) { return res.status(200).json({ steps, error: "JSON parse failed: " + e.message }); }

    // Step 3: build JWT
    const now     = Math.floor(Date.now() / 1000);
    const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: creds.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    })).toString("base64url");
    const signing = `${header}.${payload}`;
    const signer  = crypto.createSign("RSA-SHA256");
    signer.update(signing);
    const sig = signer.sign(creds.private_key, "base64url");
    const jwt = `${signing}.${sig}`;
    steps.push({ step: "jwt_created", ok: true });

    // Step 4: exchange for token
    let token;
    try {
      const tr = await axios.post("https://oauth2.googleapis.com/token",
        new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000 });
      token = tr.data.access_token;
      steps.push({ step: "token_exchange", ok: true, token_prefix: token?.slice(0, 20) });
    } catch (e) {
      steps.push({ step: "token_exchange", ok: false, status: e.response?.status, body: e.response?.data });
      return res.status(200).json({ steps });
    }

    // Step 5: download xlsx via Drive API
    try {
      const dr = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${SPREADSHEET_ID}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000, responseType: "arraybuffer" }
      );
      steps.push({ step: "drive_download", ok: true, bytes: dr.data.byteLength });

      // Step 6: parse xlsx
      const { default: XLSX } = await import("xlsx");
      const wb = XLSX.read(dr.data, { type: "buffer" });
      steps.push({ step: "xlsx_parse", ok: true, sheets: wb.SheetNames });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(0, 5);
      steps.push({ step: "first_5_rows", rows });
    } catch (e) {
      steps.push({ step: "drive_download", ok: false, status: e.response?.status, msg: e.message, body: String(e.response?.data || "").slice(0, 300) });
    }

    return res.status(200).json({ steps });
  } catch (e) {
    return res.status(200).json({ steps, fatal: e.message });
  }
}
