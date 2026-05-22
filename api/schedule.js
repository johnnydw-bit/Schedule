import axios from "axios";
import * as cheerio from "cheerio";

const BASE_URL = "https://www.bramleygolfclub.co.uk";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 8000;

// Lock CORS to the deployed origin. Set ALLOWED_ORIGIN env var in Vercel if the
// deployment URL changes; falls back to localhost for local dev.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

function parseDateToISO(displayDate) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const daysLeftMatch = displayDate.match(/(\d+)\s+days?\s+left\s+to\s+play/i);
  if (daysLeftMatch) {
    const target = new Date(now);
    target.setDate(target.getDate() + parseInt(daysLeftMatch[1], 10));
    return target.toISOString().split("T")[0];
  }
  if (/awaiting\s+opponent/i.test(displayDate)) return "TBC";
  const monthNames = {
    january:0,jan:0,february:1,feb:1,march:2,mar:2,april:3,apr:3,may:4,
    june:5,jun:5,july:6,jul:6,august:7,aug:7,september:8,sep:8,
    october:9,oct:9,november:10,nov:10,december:11,dec:11
  };
  const cleanDate = displayDate.replace(/(\d+)(st|nd|rd|th)/gi, "$1").trim();
  const withYear = cleanDate.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  if (withYear) {
    const month = monthNames[withYear[2].toLowerCase()];
    if (month !== undefined)
      return new Date(parseInt(withYear[3],10), month, parseInt(withYear[1],10)).toISOString().split("T")[0];
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const withDayName = cleanDate.match(
    /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2})\s+(\w+)(?:\s+(\d{4}))?/i
  );
  if (withDayName) {
    const month = monthNames[withDayName[2].toLowerCase()];
    const year = withDayName[3] ? parseInt(withDayName[3],10) : currentYear;
    if (month !== undefined) {
      const d = new Date(year, month, parseInt(withDayName[1],10));
      if (d < today && !withDayName[3]) d.setFullYear(currentYear + 1);
      return d.toISOString().split("T")[0];
    }
  }
  const timeAndDay = cleanDate.match(
    /(\d{1,2}:\d{2})\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2})\s+(\w+)(?:\s+(\d{4}))?/i
  );
  if (timeAndDay) {
    const month = monthNames[timeAndDay[3].toLowerCase()];
    const year = timeAndDay[4] ? parseInt(timeAndDay[4],10) : currentYear;
    if (month !== undefined) {
      const d = new Date(year, month, parseInt(timeAndDay[2],10));
      if (d < today && !timeAndDay[4]) d.setFullYear(currentYear + 1);
      return d.toISOString().split("T")[0];
    }
  }
  return "TBC";
}

function extractDaysLeft(text) {
  const m = text.match(/(\d+)\s+days?\s+left/i);
  return m ? parseInt(m[1],10) : null;
}

function classifyType(title) {
  const l = title.toLowerCase();
  if (l.includes("knockout") || l.includes("k/o")) return "knockout";
  if (l.includes("match")) return "match";
  if (l.includes("roll up") || l.includes("rollup")) return "roll-up";
  return "competition";
}

function extractTime(display) {
  const m = display.match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : null;
}

function isoToSheetDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

// Fetch the day's tee sheet and return a map of "HH:MM" -> ["name", ...]
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
      // Zero-pad to HH:MM so "9:50" matches "09:50"
      const time = rawTime.replace(/^(\d):/, "0$1:");
      const names = [];

      // Roll-up rows: find the .rollup-entrants-list div that says "Signed up:"
      const signedUpDiv = $s(row).find(".rollup-info .rollup-entrants-list").filter((_i, el) =>
        /signed up/i.test($s(el).text())
      );
      if (signedUpDiv.length) {
        const compTitle = $s(row).find(".comp-name-text").first().text()
          .replace(/\s+'/, "'").trim() || null;
        signedUpDiv.find("i").first().text().split(",").forEach(n => {
          const name = n.trim();
          if (name) names.push(name);
        });
        if (names.length) sheet[time] = { names, title: compTitle };
      } else {
        // Regular tee time: player names in span.player-name > span
        $s(row).find("span.player-name").each((_j, el) => {
          const inner = $s(el).find("> span").first();
          const name = inner.clone().find(".junior-icon").remove().end().text().trim();
          if (name && !/^(anonymous|an other)$/i.test(name)) names.push(name);
        });
        if (names.length) sheet[time] = { names, title: null };
      }
    });
    return sheet;
  } catch {
    return null;
  }
}

async function scrapeAvailableFixtures(client, cookieHeader) {
  try {
    const resp = await client.get("/matchfixtures/", {
      headers: { Cookie: cookieHeader },
      timeout: REQUEST_TIMEOUT,
    });
    const $f = cheerio.load(resp.data);
    const fixtures = [];
    $f("table.fixtures tbody tr").each((_i, row) => {
      const cells = $f(row).find("td");
      if (cells.length < 6) return;
      if (!/\bavailable\b/i.test($f(cells[5]).text())) return;

      const dateText = $f(cells[0]).text().trim();
      const hlEl = $f(cells[1]);
      const hrEl = $f(cells[3]);
      const bramleyHome = hlEl.find("a[href*='matchresults']").length > 0;
      const bramleyAway = hrEl.find("a[href*='matchresults']").length > 0;
      if (!bramleyHome && !bramleyAway) return;

      const squadName = (bramleyHome ? hlEl : hrEl).text().trim();
      const opponent  = (bramleyHome ? hrEl : hlEl).text().trim();
      const title     = bramleyHome
        ? `${squadName} vs ${opponent}`
        : `${squadName} @ ${opponent}`;

      const detailHref = $f(cells[0]).find("a").attr("href") || null;
      const link = detailHref
        ? (detailHref.startsWith("http") ? detailHref : `${BASE_URL}/${detailHref.replace(/^\//,"")}`)
        : null;

      fixtures.push({ title, date: parseDateToISO(dateText), displayDate: dateText, link });
    });
    return fixtures;
  } catch {
    return [];
  }
}

async function scrapeSchedule(memberId, pin) {
  const cookieJar = {};
  function setCookies(header) {
    if (!header) return;
    const headers = Array.isArray(header) ? header : [header];
    for (const cookie of headers) {
      const [kv] = cookie.split(";");
      const eqIdx = kv.indexOf("=");
      if (eqIdx > 0) cookieJar[kv.slice(0,eqIdx).trim()] = kv.slice(eqIdx+1).trim();
    }
  }
  function getCookieHeader() {
    return Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join("; ");
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
    new URLSearchParams({ task:"login", topmenu:"1", memberid:memberId,
      pin, cachemid:"1", _csrf_token:csrf, Submit:"Login" }).toString(),
    { headers: { "Content-Type":"application/x-www-form-urlencoded",
        Cookie:getCookieHeader(), Referer:`${BASE_URL}/login.php` },
      maxRedirects:0, validateStatus:s=>s<400||s===302 }
  );
  setCookies(lr.headers["set-cookie"]);
  if (typeof lr.data==="string" && lr.data.includes("memberid") && lr.data.includes("pin"))
    throw new Error("INVALID_CREDENTIALS");

  const cr = await client.get("/ttbconsent.php?action=accept",
    { headers: { Cookie:getCookieHeader(), Referer:`${BASE_URL}/login.php` },
      maxRedirects:5, validateStatus:s=>s<500 });
  setCookies(cr.headers["set-cookie"]);

  const hr = await client.get("/",
    { headers: { Cookie:getCookieHeader(), Referer:`${BASE_URL}/ttbconsent.php` } });
  setCookies(hr.headers["set-cookie"]);
  const homeHtml = hr.data;

  if (typeof homeHtml==="string" && (homeHtml.includes('action="/login.php"') || homeHtml.includes("Please log in")))
    throw new Error("INVALID_CREDENTIALS");

  const $ = cheerio.load(homeHtml);

  // Sanity-check that the page looks like the member home we expect.
  // If the club updates their site structure this will throw a clear error
  // rather than silently returning empty results.
  if ($("table.myupcoming").length === 0 && $("h3").filter((_i,el) => $(el).text().toLowerCase().includes("my tee times")).length === 0) {
    throw new Error("UNEXPECTED_PAGE_STRUCTURE");
  }

  const items = [];
  let idCounter = 0;

  $("table.myupcoming").first().find("tr").each((_i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;
    const title = $(cells[0]).text().trim();
    const hasLinkCell = $(cells[cells.length-1]).find("a").length > 0;
    const lastDataIdx = hasLinkCell ? cells.length - 1 : cells.length;

    // Concatenate all middle cells — some rows have an extra column that shifts the date
    const dateText = Array.from({length: lastDataIdx - 1}, (_, i) =>
      $(cells[i + 1]).text().trim()
    ).filter(Boolean).join(" ");
    if (!title || !dateText) return;

    // Players/partner: only meaningful when there are 2+ middle cells
    const players = (lastDataIdx - 1) > 1 ? $(cells[2]).text().trim() || null : null;

    const href = $(cells[cells.length-1]).find("a").attr("href") || null;
    const link = href ? (href.startsWith("http") ? href : `${BASE_URL}/${href.replace(/^\//,"")}`) : null;
    const isPlayBy = /days?\s+left\s+to\s+play/i.test(dateText);
    const isDateTbc = /awaiting\s+opponent/i.test(dateText);
    const daysLeft = extractDaysLeft(dateText);
    let playByDate = null;
    if (isPlayBy && daysLeft !== null) {
      const t = new Date(); t.setDate(t.getDate()+daysLeft);
      playByDate = t.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric"});
    }
    items.push({ id:`item-${++idCounter}`, type:classifyType(title), title,
      date:parseDateToISO(dateText), displayDate:dateText, time:extractTime(dateText),
      link, players, daysLeft, playByDate, isPlayBy, isDateTbc });
  });

  const teeHeader = $("h3").filter((_i,el) => $(el).text().trim().toLowerCase().includes("my tee times"));
  if (teeHeader.length) {
    teeHeader.next("table").find("tr").each((_i, row) => {
      const cells = $(row).find("td");
      if (cells.length < 2) return;
      const dateText = $(cells[0]).text().trim();
      const timeText = $(cells[1]).text().trim();
      const playersText = cells.length > 2 ? $(cells[2]).text().trim() : null;
      if (!dateText) return;
      const href = cells.length > 3 ? $(cells[3]).find("a").attr("href") || null : null;
      const link = href ? (href.startsWith("http") ? href : `${BASE_URL}/${href.replace(/^\//,"")}`) : null;
      const displayDate = timeText ? `${timeText} ${dateText}` : dateText;
      const slotType = /roll.?up/i.test(displayDate) ? "roll-up" : "tee-time";
      items.push({ id:`item-${++idCounter}`, type:slotType, title:slotType==="roll-up"?"Roll Up":"Tee Time",
        date:parseDateToISO(displayDate), displayDate, time:extractTime(displayDate)||null,
        link, players:playersText, daysLeft:null, playByDate:null, isPlayBy:false, isDateTbc:false });
    });
  }

  // Fetch tee sheets and available fixtures in parallel
  const cookieSnapshot = getCookieHeader();
  const teeDates = [...new Set(
    items
      .filter(i => (i.type === "tee-time" || i.type === "roll-up") && i.date && i.date !== "TBC" && i.time)
      .map(i => i.date)
  )];
  const [sheetEntries, availableFixtures] = await Promise.all([
    Promise.all(teeDates.map(async d => [d, await fetchTeeSheet(client, cookieSnapshot, d)])),
    scrapeAvailableFixtures(client, cookieSnapshot),
  ]);
  const sheets = Object.fromEntries(sheetEntries);

  items.filter(i => (i.type === "tee-time" || i.type === "roll-up") && i.time).forEach(item => {
    const sheet = sheets[item.date];
    if (!sheet) return;
    const rawT = extractTime(item.time) || item.time;
    const t = rawT.replace(/^(\d):/, "0$1:");
    const entry = sheet[t];
    if (!entry) return;
    if (entry.names && entry.names.length) item.players = entry.names.join(", ");
    if (entry.title && item.type === "roll-up") item.title = entry.title;
  });

  availableFixtures.forEach(f => {
    items.push({ id:`item-${++idCounter}`, type:"available", title:f.title,
      date:f.date, displayDate:f.displayDate, time:null, link:f.link,
      players:null, daysLeft:null, playByDate:null, isPlayBy:false, isDateTbc:false });
  });

  const today = new Date().toISOString().split("T")[0];
  return {
    items: items
      .filter(i => i.isDateTbc || i.isPlayBy || i.date==="TBC" || i.date>=today)
      .sort((a,b) => {
        if (a.isDateTbc && !b.isDateTbc) return 1;
        if (!a.isDateTbc && b.isDateTbc) return -1;
        if (a.date==="TBC" && b.date!=="TBC") return 1;
        if (a.date!=="TBC" && b.date==="TBC") return -1;
        return a.date.localeCompare(b.date);
      }),
    fetchedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  // Allow the configured origin and any Vercel preview deployments for this project
  const allowed = origin === ALLOWED_ORIGIN || /^https:\/\/bramley-schedule(-[a-z0-9]+)*\.vercel\.app$/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  const { member_id, pin } = req.body || {};
  if (!member_id || !pin) return res.status(400).json({ error: "member_id and pin required" });

  try {
    const result = await scrapeSchedule(member_id.trim(), pin.trim());
    return res.status(200).json({ status: "done", ...result });
  } catch(err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "INVALID_CREDENTIALS")
      return res.status(401).json({ status: "error", message: "Invalid credentials — check your Member ID and PIN." });
    if (message === "UNEXPECTED_PAGE_STRUCTURE")
      return res.status(502).json({ status: "error", message: "The club website structure has changed — the schedule scraper needs updating." });
    return res.status(502).json({ status: "error", message: "Failed to fetch schedule. Please try again." });
  }
}
