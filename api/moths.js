import axios from "axios";
import * as cheerio from "cheerio";
import { fetchHandicapMap, fetchWhsIndices, enrichNames } from "./handicaps.js";

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
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

// Parse action details (enter or withdraw) from a row element.
// Returns { enter: {method,url,fields} | null, withdraw: {method,url,fields} | null, isEntered: bool | null }
function parseRollUpActions($s, row) {
  const $row = $s(row);
  let enterAction = null;
  let withdrawAction = null;

  // --- Check <a> links ---
  $row.find("a").each((_i, el) => {
    const text = $s(el).text().trim();
    const href = $s(el).attr("href") || "";
    const fullUrl = href && href !== "#"
      ? (href.startsWith("http") ? href : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`)
      : null;
    const action = { method: "get", url: fullUrl, fields: {} };
    if (/withdraw|remove/i.test(text)) {
      withdrawAction = withdrawAction || action;
    } else if (/sign.{0,3}up|join|enter|book|add/i.test(text)) {
      enterAction = enterAction || action;
    }
  });

  // --- Check <form> elements ---
  $row.find("form").each((_i, formEl) => {
    const $form = $s(formEl);
    const method = ($form.attr("method") || "get").toLowerCase();
    const rawAction = $form.attr("action") || "";
    const url = rawAction.startsWith("http")
      ? rawAction
      : rawAction.startsWith("/")
        ? `${BASE_URL}${rawAction}`
        : rawAction.startsWith("?")
          ? `${BASE_URL}/memberbooking/${rawAction}`
          : `${BASE_URL}/${rawAction}`;

    // Collect all hidden fields + any non-submit named inputs
    const fields = {};
    $form.find("input").each((_j, inp) => {
      const type = ($s(inp).attr("type") || "text").toLowerCase();
      const name = $s(inp).attr("name");
      const value = $s(inp).attr("value") || "";
      if (name && type !== "submit") fields[name] = value;
    });

    // Identify intent from submit button text
    const submitText = $form.find('input[type="submit"],button[type="submit"],button:not([type])').text().trim() ||
      $form.find('input[type="submit"]').attr("value") || "";

    const formAction = { method, url, fields };
    if (/withdraw|remove/i.test(submitText)) {
      withdrawAction = withdrawAction || formAction;
    } else if (/sign.{0,3}up|join|enter|book|add/i.test(submitText)) {
      enterAction = enterAction || formAction;
    }
  });

  // Determine isEntered
  let isEntered = null;
  if (withdrawAction !== null) isEntered = true;
  else if (enterAction !== null) isEntered = false;

  return { isEntered, actions: { enter: enterAction, withdraw: withdrawAction } };
}

// Returns map of "HH:MM" -> { title, isEntered, actions } for roll-up slots only
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
      const compNameEl = $s(row).find(".comp-name-text").first();
      if (compNameEl.length) {
        const compTitle = compNameEl.text().replace(/\s+'/, "'").trim() || null;
        const { isEntered, actions } = parseRollUpActions($s, row);
        // Count signed-up players from the entrants list
        const signedUpDiv = $s(row).find(".rollup-info .rollup-entrants-list").filter((_i, el) =>
          /signed up/i.test($s(el).text())
        );
        let playerCount = null;
        let playerNames = null;
        if (signedUpDiv.length) {
          const names = signedUpDiv.find("i").first().text()
            .split(",").map(n => n.trim()).filter(Boolean);
          playerCount = names.length;
          playerNames = names;
        }
        sheet[time] = { title: compTitle, isEntered, actions, playerCount, playerNames };
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

// "cross" | "HH:MM" | "error"  — always return the actual time when booked
function slotStatus(sheet, mothsTime) {
  if (mothsTime === undefined) return "error";
  if (mothsTime === null)      return "cross";
  return mothsTime;
}

// Returns ISO date of the first day of the next calendar quarter after isoDate
function getNextQuarterStart(isoDate) {
  const d = new Date(isoDate + "T12:00:00Z");
  const nextQMonth = (Math.floor(d.getUTCMonth() / 3) + 1) * 3; // 3, 6, 9, or 12
  const year = nextQMonth >= 12 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  const month = nextQMonth >= 12 ? 0 : nextQMonth;
  return new Date(Date.UTC(year, month, 1)).toISOString().split("T")[0];
}

// Generate Mon+Thu pairs starting from the current or next week for ~2 months.
// Once this week's Thursday has passed, advance to next Monday so the
// list always leads with upcoming games rather than already-played ones.
function buildWeeks(todayIso) {
  const from = new Date(todayIso + "T12:00:00Z");
  const day = from.getUTCDay();
  const daysToMon = day === 0 ? -6 : 1 - day;
  from.setUTCDate(from.getUTCDate() + daysToMon);

  // If this week's Thursday is already in the past, start from next Monday
  const thisThu = new Date(from);
  thisThu.setUTCDate(thisThu.getUTCDate() + 3);
  if (thisThu.toISOString().split("T")[0] < todayIso) {
    from.setUTCDate(from.getUTCDate() + 7);
  }

  const to = new Date(todayIso + "T12:00:00Z");
  to.setUTCMonth(to.getUTCMonth() + 2);

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
  const handicapMap = await fetchHandicapMap();  // Google Sheet (fetched in parallel with login below)
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

  // Fetch WHS indices from Bramley (reuse logged-in session) in parallel with date setup
  const whsMap = await fetchWhsIndices(client, cookieSnapshot);

  const todayIso = new Date().toISOString().split("T")[0];
  const weeks = buildWeeks(todayIso);

  // Fetch tee sheets up to 8 weeks out
  const cutoff = new Date(todayIso + "T12:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() + 56);
  const cutoffIso = cutoff.toISOString().split("T")[0];
  const fetchDates = weeks.flatMap(w => [w.mon, w.thu]).filter(d => d <= cutoffIso);

  // Early-stop: once both slots of the first week of the next quarter are
  // empty (cross), the booking system hasn't opened that quarter yet — no
  // point fetching further.
  const nextQStart = getNextQuarterStart(todayIso);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Fetch in batches of 5 with 300ms gaps
  const BATCH = 5;
  const entries = [];
  let consecutiveCross = 0;
  let earlyStop = false;

  for (let i = 0; i < fetchDates.length; i += BATCH) {
    if (earlyStop) break;
    const batch = fetchDates.slice(i, i + BATCH);
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

    // Check for early stop — two consecutive cross slots in the next quarter
    for (const [d, sheet] of batchResults) {
      if (d >= nextQStart && sheet !== null) {
        if (findMothsTime(sheet) === null) {
          consecutiveCross++;
          if (consecutiveCross >= 2) { earlyStop = true; break; }
        } else {
          consecutiveCross = 0; // a booking exists — keep scanning
        }
      }
    }

    if (!earlyStop && i + BATCH < fetchDates.length) await sleep(300);
  }
  const sheetMap = Object.fromEntries(entries);

  // If we stopped early, trim weeks to only those actually fetched
  const displayWeeks = earlyStop
    ? weeks.filter(w => w.mon in sheetMap || w.thu in sheetMap)
    : weeks;

  function slotData(iso) {
    if (!(iso in sheetMap)) {
      // Beyond the fetch window — booking site won't have it open yet
      return { status: "future", entered: null, playerCount: null, playerNames: null };
    }
    const sheet = sheetMap[iso];  // null if both fetch attempts failed
    const mothsTime = findMothsTime(sheet);
    const slot = (sheet && mothsTime) ? sheet[mothsTime] : null;
    return {
      status:      slotStatus(sheet, mothsTime),
      entered:     slot ? slot.isEntered   : null,
      playerCount: slot ? slot.playerCount : null,
      playerNames: slot ? enrichNames(slot.playerNames, handicapMap, whsMap) : null,
    };
  }

  const rows = displayWeeks.map(({ mon, thu }) => {
    const m = slotData(mon);
    const t = slotData(thu);
    return {
      monIso: mon, monDisplay: toDisplayDate(mon),
      monStatus: m.status, monEntered: m.entered, monCount: m.playerCount, monNames: m.playerNames,
      thuIso: thu, thuDisplay: toDisplayDate(thu),
      thuStatus: t.status, thuEntered: t.entered, thuCount: t.playerCount, thuNames: t.playerNames,
    };
  });

  return { rows, earlyStop, fetchedAt: new Date().toISOString() };
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
