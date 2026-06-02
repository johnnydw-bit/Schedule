import axios from "axios";
import crypto from "crypto";
import * as XLSX from "xlsx";

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
    scope: "https://www.googleapis.com/auth/drive.readonly",
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

    // Download the xlsx via Drive API
    const driveResp = await axios.get(
      `https://www.googleapis.com/drive/v3/files/${SPREADSHEET_ID}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000, responseType: "arraybuffer" }
    );

    // Parse with SheetJS — find the tab by gid
    const workbook  = XLSX.read(driveResp.data, { type: "buffer" });
    // SheetJS doesn't expose gid directly; match by sheet index or name.
    // Try to find the right sheet: gid 276854640 → check each sheet's !ref
    // Fall back to first sheet if we can't identify it.
    let sheetData = null;
    for (const name of workbook.SheetNames) {
      const ws = workbook.Sheets[name];
      // SheetJS stores gid in ws['!id'] for xlsx files
      if (ws["!id"] && String(ws["!id"]) === SHEET_GID) {
        sheetData = XLSX.utils.sheet_to_json(ws, { header: 1 });
        break;
      }
    }
    if (!sheetData) {
      // Fall back: use the sheet whose name hints at handicaps, else first sheet
      const hcpSheet = workbook.SheetNames.find(n => /handicap/i.test(n));
      const ws = workbook.Sheets[hcpSheet || workbook.SheetNames[0]];
      sheetData = XLSX.utils.sheet_to_json(ws, { header: 1 });
    }

    const map = new Map();
    for (const row of sheetData) {
      const surname  = String(row[0] || "").trim();
      const handicap = String(row[6] || "").trim();
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

// Best-effort surname match.
// Scraper names are "Firstname Lastname", "First Middle Last", or "First Smith-Jones".
// Sheet has surname only.  Try candidates in order:
//   1. Last whitespace-token (the surname)
//   2. Each hyphen-part of that token (for "Smith-Jones" try "smith" and "jones")
//   3. Prefix best-match fallback
export function matchHandicap(playerName, handicapMap) {
  if (!handicapMap.size) return null;
  const parts = playerName.trim().split(/\s+/);
  if (!parts.length) return null;

  // Build candidates: last token, last 2 tokens, last 3 tokens, hyphen parts
  const candidates = [];
  for (let n = 1; n <= Math.min(3, parts.length - 1); n++) {
    candidates.push(parts.slice(parts.length - n).join(" ").toLowerCase());
  }
  // Also add hyphen parts of the last token
  const lastToken = parts[parts.length - 1].toLowerCase();
  lastToken.split("-").filter(p => p.length > 1).forEach(p => candidates.push(p));

  // 1. Exact match on any candidate (longest first so "De Wit" beats "Wit")
  for (const c of candidates) {
    if (handicapMap.has(c)) return handicapMap.get(c);
  }

  // 2. Prefix best-match on last token
  let best = null;
  let bestLen = 0;
  for (const [surname, hcp] of handicapMap) {
    if (surname.startsWith(lastToken) || lastToken.startsWith(surname)) {
      const len = Math.min(surname.length, lastToken.length);
      if (len > bestLen) { bestLen = len; best = hcp; }
    }
  }
  return best;
}

// ── WHS / playing handicap ────────────────────────────────────────────────────

// Bramley yellow tees: Par 70, Slope 110, Course Rating 69
const YELLOW_PAR   = 70;
const YELLOW_SLOPE = 110;
const YELLOW_CR    = 69;

export function calculatePlayingHandicap(whsIndex) {
  return Math.round(parseFloat(whsIndex) * (YELLOW_SLOPE / 113) + (YELLOW_CR - YELLOW_PAR));
}

// Scrape WHS indices from Bramley's handicap list page.
// Requires an already-authenticated axios client + cookie header.
// Returns Map<fullname_lower -> whsIndex (float)>
export async function fetchWhsIndices(client, cookieHeader) {
  try {
    const resp = await client.get("/hcaplist.php", {
      params:  { action: "masterhcap", filter: "", sort: "0" },
      headers: { Cookie: cookieHeader },
      timeout: 8000,
    });
    const cheerio = await import("cheerio");
    const $  = cheerio.load(resp.data);
    const map = new Map();
    $("table.table tr").each((_i, row) => {
      const nameEl = $(row).find("td:first-child a");
      const idxEl  = $(row).find("td:last-child");
      if (!nameEl.length || !idxEl.length) return;
      const name = nameEl.text().trim();
      const idx  = parseFloat(idxEl.text().trim());
      if (name && !isNaN(idx)) map.set(name.toLowerCase(), idx);
    });
    return map;
  } catch (err) {
    console.error("fetchWhsIndices error:", err.message);
    return new Map();
  }
}

// ── Enrichment ────────────────────────────────────────────────────────────────

// Match a player name against the WHS index map (full-name fuzzy match).
// Returns { whsIndex, playingHandicap } or null.
function matchWhs(playerName, whsMap) {
  if (!whsMap.size) return null;
  const key = playerName.trim().toLowerCase();

  // 1. Exact full-name match
  if (whsMap.has(key)) {
    const idx = whsMap.get(key);
    return { whsIndex: idx, playingHandicap: calculatePlayingHandicap(idx) };
  }

  // 2. Partial match — all tokens of player name appear in a WHS entry
  const tokens = key.split(/\s+/);
  for (const [whsName, idx] of whsMap) {
    if (tokens.every(t => whsName.includes(t))) {
      return { whsIndex: idx, playingHandicap: calculatePlayingHandicap(idx) };
    }
  }

  return null;
}

// Enrich a raw string[] of player names → [{name, handicap, calculated}]
// handicap    — from Google Sheet (priority)
// calculated  — true if playing handicap was derived from WHS index (fallback)
export function enrichNames(rawNames, handicapMap, whsMap = new Map()) {
  if (!rawNames) return null;
  return rawNames.map(name => {
    const sheetHcp = matchHandicap(name, handicapMap);
    if (sheetHcp !== null) {
      return { name, handicap: sheetHcp, calculated: false };
    }
    // Fallback: WHS index → playing handicap for yellow tees
    const whs = matchWhs(name, whsMap);
    if (whs) {
      return { name, handicap: String(whs.playingHandicap), calculated: true };
    }
    return { name, handicap: null, calculated: false };
  });
}
