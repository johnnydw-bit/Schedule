import axios from "axios";
import * as cheerio from "cheerio";

const BASE_URL = "https://www.bramleygolfclub.co.uk";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 8000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

function isoToSheetDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function toDisplayDate(iso) {
  const d = new Date(iso + "T12:00:00Z");
  const days   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

// Returns map of "HH:MM" -> { title } for roll-up slots only
async function fetchTeeSheet(client, cookieHeader, isoDate) {
  try {
    const resp = await client.get(`/memberbooking/?date=${isoToSheetDate(isoDate)}`, {
      headers: { Cookie: cookieHeader },
      timeout: REQUEST_TIMEOUT,
    });
    const $s = cheerio.load(resp.data);
    const sheet = {};
    $s("table#member_teetimes tbody tr").each((_i, row) => {
      const rawTime = $s(row).find("th.slot-time").text().trim();
      if (!rawTime) return;
      const time = rawTime.replace(/^(\d):/, "0$1:");
      const signedUpDiv = $s(row).find(".rollup-info .rollup-entrants-list").filter((_i, el) =>
        /signed up/i.test($s(el).text())
      );
      if (signedUpDiv.length) {
        const compTitle = $s(row).find(".comp-name-text").first().text()
          .replace(/\s+'/, "'").trim() || null;
        sheet[time] = { title: compTitle };
      }
    });
    return sheet;
  } catch {
    return null;
  }
}

// Returns the booked time of the Moths roll-up on this sheet.
// Matches "MOTH's Rollup", "Moths Roll Up", "MOTHS" etc.
// Returns undefined if the fetch failed, null if no Moths slot found.
function findMothsTime(sheet) {
  if (!sheet) return undefined;
  for (const [time, data] of Object.entries(sheet)) {
    if (data.title && /moth/i.test(data.title)) return time;
  }
  return null;
}

// "tick" | "cross" | "HH:MM" (moved time) | "error"
function slotStatus(sheet, mothsTime) {
  if (mothsTime === undefined) return "error";
  if (mothsTime === null)      return "cross";
  if (mothsTime === "10:00")   return "tick";
  return mothsTime;
}

// Generate Mon+Thu pairs from Monday-of-current-week for ~3 months
function buildWeeks(todayIso) {
  const from = new Date(todayIso + "T12:00:00Z");
  const day = from.getUTCDay();
  const daysToMon = day === 0 ? -6 : 1 - day;
  from.setUTCDate(from.getUTCDate() + daysToMon);

  const to = new Date(todayIso + "T12:00:00Z");
  to.setUTCMonth(to.getUTCMonth() + 3);

  const weeks = [];
  while (from <= to) {
    const mon = from.toISOString().split("T")[0];
    const thuDate = new Date(from);
    thuDate.setUTCDate(thuDate.getUTCDate() + 3);
    const thu = thuDate.toISOString().split("T")[0];
    weeks.push({ mon, thu });
    from.setUTCDate(from.getUTCDate() + 7);
  }
  return weeks;
}

async function scrapeMothsRollUps(memberId, pin) {
  const cookieJar = {};
  function setCookies(header) {
    if (!header) return;
    const headers = Array.isArray(header) ? header : [header];
    for (const cookie of headers) {
      const [kv] = cookie.split(";");
      const eqIdx = kv.indexOf("=");
      if (eqIdx > 0) cookieJar[kv.slice(0, eqIdx).trim()] = kv.slice(eqIdx + 1).trim();
    }
  }
  function getCookieHeader() {
    return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const client = axios.create({
    baseURL: BASE_URL,
    timeout: REQUEST_TIMEOUT,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.5",
    },
    withCredentials: true,
    maxRedirects: 5,
    validateStatus: s => s < 500,
  });

  const lp = await client.get("/login.php", { headers: { Cookie: getCookieHeader() } });
  setCookies(lp.headers["set-cookie"]);
  const $l = cheerio.load(lp.data);
  const csrf = $l('input[name="_csrf_token"]').val();
  if (!csrf) throw new Error("Could not find CSRF token on login page");

  const lr = await client.post("/login.php",
    new URLSearchParams({ task: "login", topmenu: "1", memberid: memberId,
      pin, cachemid: "1", _csrf_token: csrf, Submit: "Login" }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded",
        Cookie: getCookieHeader(), Referer: `${BASE_URL}/login.php` },
      maxRedirects: 0, validateStatus: s => s < 400 || s === 302 }
  );
  setCookies(lr.headers["set-cookie"]);
  if (typeof lr.data === "string" && lr.data.includes("memberid") && lr.data.includes("pin"))
    throw new Error("INVALID_CREDENTIALS");

  const cr = await client.get("/ttbconsent.php?action=accept",
    { headers: { Cookie: getCookieHeader(), Referer: `${BASE_URL}/login.php` },
      maxRedirects: 5, validateStatus: s => s < 500 });
  setCookies(cr.headers["set-cookie"]);

  const hr = await client.get("/",
    { headers: { Cookie: getCookieHeader(), Referer: `${BASE_URL}/ttbconsent.php` } });
  setCookies(hr.headers["set-cookie"]);
  if (typeof hr.data === "string" && (hr.data.includes('action="/login.php"') || hr.data.includes("Please log in")))
    throw new Error("INVALID_CREDENTIALS");

  const cookieSnapshot = getCookieHeader();
  const todayIso = new Date().toISOString().split("T")[0];
  const weeks = buildWeeks(todayIso);
  const allDates = weeks.flatMap(w => [w.mon, w.thu]);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Fetch in batches of 4 to avoid overwhelming the club's server
  const BATCH = 4;
  const entries = [];
  for (let i = 0; i < allDates.length; i += BATCH) {
    const batch = allDates.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async d => {
        let sheet = await fetchTeeSheet(client, cookieSnapshot, d);
        if (sheet === null) {
          await sleep(600);
          sheet = await fetchTeeSheet(client, cookieSnapshot, d);
        }
        return [d, sheet];
      })
    );
    entries.push(...batchResults);
    if (i + BATCH < allDates.length) await sleep(300);
  }
  const results = entries;
  const sheetMap = Object.fromEntries(results);

  const rows = weeks.map(({ mon, thu }) => {
    const monMothsTime = findMothsTime(sheetMap[mon]);
    const thuMothsTime = findMothsTime(sheetMap[thu]);
    return {
      monIso: mon,
      monDisplay: toDisplayDate(mon),
      monStatus: slotStatus(sheetMap[mon], monMothsTime),
      thuIso: thu,
      thuDisplay: toDisplayDate(thu),
      thuStatus: slotStatus(sheetMap[thu], thuMothsTime),
    };
  });

  return { rows, fetchedAt: new Date().toISOString() };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowed = origin === ALLOWED_ORIGIN ||
    /^https:\/\/bramley-schedule(-[a-z0-9]+)*\.vercel\.app$/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  const { member_id, pin } = req.body || {};
  if (!member_id || !pin) return res.status(400).json({ error: "member_id and pin required" });

  try {
    const result = await scrapeMothsRollUps(member_id.trim(), pin.trim());
    return res.status(200).json({ status: "done", ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "INVALID_CREDENTIALS")
      return res.status(401).json({ status: "error", message: "Invalid credentials — check your Member ID and PIN." });
    return res.status(502).json({ status: "error", message: "Failed to fetch data. Please try again." });
  }
}
