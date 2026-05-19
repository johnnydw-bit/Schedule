import axios from "axios";
import * as cheerio from "cheerio";

const BASE_URL = "https://www.bramleygolfclub.co.uk";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Date parsing ──────────────────────────────────────────────────────────────
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

  const withDayName = cleanDate.match(
    /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2})\s+(\w+)(?:\s+(\d{4}))?/i
  );
  if (withDayName) {
    const month = monthNames[withDayName[2].toLowerCase()];
    const year = withDayName[3] ? parseInt(withDayName[3],10) : currentYear;
    if (month !== undefined) {
      const d = new Date(year, month, parseInt(withDayName[1],10));
      if (d < now && !withDayName[3]) d.setFullYear(currentYear + 1);
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
      if (d < now && !timeAndDay[4]) d.setFullYear(currentYear + 1);
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

// ── Scraper ───────────────────────────────────────────────────────────────────
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
    headers: { "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.5" },
    withCredentials: true,
    maxRedirects: 5,
    validateStatus: s => s < 500,
  });

  // Step 1: GET login page for CSRF
  const lp = await client.get("/login.php", { headers: { Cookie: getCookieHeader() } });
  setCookies(lp.headers["set-cookie"]);
  const $l = cheerio.load(lp.data);
  const csrf = $l('input[name="_csrf_token"]').val();
  if (!csrf) throw new Error("Could not find CSRF token on login page");

  // Step 2: POST login
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

  // Step 3: consent
  const cr = await client.get("/ttbconsent.php?action=accept",
    { headers: { Cookie:getCookieHeader(), Referer:`${BASE_URL}/login.php` },
      maxRedirects:5, validateStatus:s=>s<500 });
  setCookies(cr.headers["set-cookie"]);

  // Step 4: home page
  const hr = await client.get("/",
    { headers: { Cookie:getCookieHeader(), Referer:`${BASE_URL}/ttbconsent.php` } });
  setCookies(hr.headers["set-cookie"]);
  const homeHtml = hr.data;
  if (typeof homeHtml==="string" && (homeHtml.includes('action="/login.php"') || homeHtml.includes("Please log in")))
    throw new Error("INVALID_CREDENTIALS");

  const $ = cheerio.load(homeHtml);
  const items = [];
  let idCounter = 0;

  // Competitions
  $("table.myupcoming").first().find("tr").each((_i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;
    const title = $(cells[0]).text().trim();
    const dateText = $(cells[1]).text().trim();
    if (!title || !dateText) return;
    const lastCell = $(cells[cells.length-1]);
    const href = lastCell.find("a").attr("href") || null;
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
      link, players:null, daysLeft, playByDate, isPlayBy, isDateTbc });
  });

  // Tee times
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
      items.push({ id:`item-${++idCounter}`, type:"tee-time", title:"Tee Time",
        date:parseDateToISO(displayDate), displayDate, time:timeText||null,
        link, players:playersText, daysLeft:null, playByDate:null, isPlayBy:false, isDateTbc:false });
    });
  }

  const now = new Date();
  const today = now.toISOString().split("T")[0];

  const filtered = items
    .filter(item => item.isDateTbc || item.isPlayBy || item.date==="TBC" || item.date>=today)
    .sort((a,b) => {
      if (a.isDateTbc && !b.isDateTbc) return 1;
      if (!a.isDateTbc && b.isDateTbc) return -1;
      if (a.date==="TBC" && b.date!=="TBC") return 1;
      if (a.date!=="TBC" && b.date==="TBC") return -1;
      return a.date.localeCompare(b.date);
    });

  return { items: filtered, fetchedAt: new Date().toISOString() };
}

// ── Redis helpers ─────────────────────────────────────────────────────────────
async function rset(key, value, ex) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?EX=${ex}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Vercel handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  const { member_id, pin } = req.body || {};
  if (!member_id || !pin) return res.status(400).json({ error: "member_id and pin required" });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  await rset(`job:${jobId}`, { status:"running" }, 120);

  // Return job ID immediately
  res.status(200).json({ job_id: jobId });

  // Scrape in background after response sent
  try {
    const result = await scrapeSchedule(member_id.trim(), pin.trim());
    await rset(`job:${jobId}`, { status:"done", ...result }, 300);
  } catch(err) {
    const message = err instanceof Error ? err.message : String(err);
    await rset(`job:${jobId}`, {
      status: "error",
      message: message === "INVALID_CREDENTIALS"
        ? "Invalid credentials — check your Member ID and PIN."
        : "Failed to fetch schedule. Please try again."
    }, 60);
  }
}
