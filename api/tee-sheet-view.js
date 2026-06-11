import axios from "axios";
import * as cheerio from "cheerio";

const BASE_URL   = "https://www.bramleygolfclub.co.uk";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

function isoToSheetDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

export default async function handler(req, res) {
  const origin  = req.headers.origin || "";
  const allowed = origin === ALLOWED_ORIGIN ||
    /^https:\/\/bramley-schedule(-[a-z0-9]+)*\.vercel\.app$/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).end();

  const { member_id, pin, date } = req.body || {};
  if (!member_id || !pin || !date)
    return res.status(400).json({ error: "member_id, pin and date required" });

  const cookieJar = {};
  function setCookies(header) {
    if (!header) return;
    for (const cookie of (Array.isArray(header) ? header : [header])) {
      const [kv] = cookie.split(";");
      const eq = kv.indexOf("=");
      if (eq > 0) cookieJar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
  }
  function getCookieHeader() {
    return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const client = axios.create({
    baseURL: BASE_URL,
    timeout: 10000,
    headers: { "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.5" },
    withCredentials: true,
    maxRedirects: 5,
    validateStatus: s => s < 500,
  });

  try {
    // Login
    const lp = await client.get("/login.php", { headers: { Cookie: getCookieHeader() } });
    setCookies(lp.headers["set-cookie"]);
    const $l   = cheerio.load(lp.data);
    const csrf = $l('input[name="_csrf_token"]').val();
    if (!csrf) throw new Error("No CSRF token");

    const lr = await client.post("/login.php",
      new URLSearchParams({ task: "login", topmenu: "1", memberid: member_id,
        pin, cachemid: "1", _csrf_token: csrf, Submit: "Login" }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded",
          Cookie: getCookieHeader(), Referer: `${BASE_URL}/login.php` },
        maxRedirects: 0, validateStatus: s => s < 400 || s === 302 });
    setCookies(lr.headers["set-cookie"]);
    if (typeof lr.data === "string" && lr.data.includes("memberid") && lr.data.includes("pin"))
      throw new Error("INVALID_CREDENTIALS");

    // Accept consent if needed
    await client.get("/ttbconsent.php?action=accept",
      { headers: { Cookie: getCookieHeader(), Referer: `${BASE_URL}/login.php` },
        maxRedirects: 5, validateStatus: s => s < 500 });

    // Fetch the booking page
    const br = await client.get("/memberbooking/",
      { params: { date: isoToSheetDate(date), course: "1", group: "1" },
        headers: { Cookie: getCookieHeader() } });

    // Inject <base> tag so relative URLs resolve against Bramley
    let html = br.data;
    html = html.replace(/<head([^>]*)>/i,
      `<head$1><base href="${BASE_URL}/">`);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);

  } catch (err) {
    const msg = err.message === "INVALID_CREDENTIALS"
      ? "Invalid credentials"
      : "Could not load tee sheet — please try again";
    return res.status(502).send(`<html><body style="font-family:sans-serif;padding:40px">
      <h2>⚠️ ${msg}</h2><p><a href="javascript:window.close()">Close this tab</a></p>
    </body></html>`);
  }
}
