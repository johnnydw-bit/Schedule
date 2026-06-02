import axios from "axios";

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1sZyBu8ksrYQxN8zIbkdh9QIGwm5dnbTR/export?format=csv&gid=276854640";

function parseCSVLine(line) {
  const cols = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === "," && !inQuote) { cols.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

// Returns Map<surname_lower -> handicap_string>
export async function fetchHandicapMap() {
  try {
    const resp = await axios.get(SHEET_CSV_URL, { timeout: 8000, responseType: "text" });
    const map = new Map();
    for (const line of resp.data.split(/\r?\n/)) {
      const cols = parseCSVLine(line);
      if (cols.length < 7) continue;
      const surname  = cols[0].trim();
      const handicap = cols[6].trim();
      if (surname && handicap && /^-?\d/.test(handicap)) {
        map.set(surname.toLowerCase(), handicap);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// Best-effort match: first token of playerName against sheet surnames.
// Returns handicap string or null.
export function matchHandicap(playerName, handicapMap) {
  if (!handicapMap.size) return null;
  const token = playerName.trim().split(/\s+/)[0].toLowerCase();
  if (!token) return null;

  // 1. Exact
  if (handicapMap.has(token)) return handicapMap.get(token);

  // 2. Sheet surname starts-with token (e.g. token="Mac" matches "MacDonald")
  //    or token starts-with surname (e.g. surname="Mac" matches token="MacDonald")
  let best = null;
  let bestLen = 0;
  for (const [surname, hcp] of handicapMap) {
    if (surname.startsWith(token) || token.startsWith(surname)) {
      const matchLen = Math.min(surname.length, token.length);
      if (matchLen > bestLen) { bestLen = matchLen; best = hcp; }
    }
  }
  return best;
}

// Enrich a raw string[] of player names with handicaps.
// Returns [{name, handicap}]
export function enrichNames(rawNames, handicapMap) {
  if (!rawNames) return null;
  return rawNames.map(name => ({
    name,
    handicap: matchHandicap(name, handicapMap),
  }));
}
