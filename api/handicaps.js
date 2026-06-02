import axios from "axios";
import crypto from "crypto";

const SPREADSHEET_ID = "1sZyBu8ksrYQxN8zIbkdh9QIGwm5dnbTR";
const SHEET_GID      = "276854640";

// ── Service-account JWT helpers ──────────────────────────────────────────────

function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function createJWT(creds) {
  const now    = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss:   creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  })).toString("base64url");

  const signing  = `${header}.${payload}`;
  const signer   = crypto.createSign("RSA-SHA256");
  signer.update(signing);
  const sig = signer.sign(creds.private_key, "base64url");
  return `${signing}.${sig}`;
}

async function getAccessToken(creds) {
  const resp = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  createJWT(creds),
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000 }
  );
  return resp.data.access_token;
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const cols = [];
  let cur = "";
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === "," && !inQuote) { cols.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Returns Map<surname_lower -> handicap_string>
export async function fetchHandicapMap() {
  try {
    const creds = getCredentials();
    if (!creds) {
      console.warn("GOOGLE_SERVICE_ACCOUNT env var not set — handicaps unavailable");
      return new Map();
    }

    const token = await getAccessToken(creds);

    // Step 1: find the sheet name for our gid
    const metaResp = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );
    const sheetMeta = metaResp.data.sheets || [];
    const sheetName = sheetMeta.find(s => String(s.properties.sheetId) === SHEET_GID)
      ?.properties.title;
    if (!sheetName) throw new Error(`Sheet with gid ${SHEET_GID} not found`);

    // Step 2: fetch columns A and G
    const range = encodeURIComponent(`${sheetName}!A:G`);
    const valResp = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );

    const map = new Map();
    for (const row of valResp.data.values || []) {
      const surname  = (row[0] || "").trim();
      const handicap = (row[6] || "").trim();
      if (surname && handicap && /^[+\-]?\d/.test(handicap)) {
        map.set(surname.toLowerCase(), handicap);
      }
    }
    return map;
  } catch (err) {
    console.error("fetchHandicapMap error:", err.message);
    return new Map();
  }
}

// Best-effort surname match against the first token of a player name.
// Returns handicap string or null.
export function matchHandicap(playerName, handicapMap) {
  if (!handicapMap.size) return null;
  const token = playerName.trim().split(/\s+/)[0].toLowerCase();
  if (!token) return null;

  // 1. Exact
  if (handicapMap.has(token)) return handicapMap.get(token);

  // 2. Best prefix match (longest shared prefix wins)
  let best = null;
  let bestLen = 0;
  for (const [surname, hcp] of handicapMap) {
    if (surname.startsWith(token) || token.startsWith(surname)) {
      const len = Math.min(surname.length, token.length);
      if (len > bestLen) { bestLen = len; best = hcp; }
    }
  }
  return best;
}

// Enrich a raw string[] of player names → [{name, handicap}]
export function enrichNames(rawNames, handicapMap) {
  if (!rawNames) return null;
  return rawNames.map(name => ({
    name,
    handicap: matchHandicap(name, handicapMap),
  }));
}
