import axios from "axios";

const BASE_URL = "https://www.bramleygolfclub.co.uk";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 8000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

function isoToSheetDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

async function fetchSheet(memberId, pin, date) {
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

  // 1. Get CSRF token
  const lp = await client.get("/login.php", { headers: { Cookie: getCookieHeader() } });
  setCookies(lp.headers["set-cookie"]);
  const csrfMatch = lp.data.match(/name="_csrf_token"\s+value="([^"]+)"/);
  if (!csrfMatch) throw new Error("Could not find CSRF token");
  const csrf = csrfMatch[1];

  // 2. Login
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

  // 3. Accept consent
  const cr = await client.get("/ttbconsent.php?action=accept",
    { headers: { Cookie: getCookieHeader(), Referer: `${BASE_URL}/login.php` },
      maxRedirects: 5, validateStatus: s => s < 500 });
  setCookies(cr.headers["set-cookie"]);

  // 4. Fetch booking page
  const sheetDate = isoToSheetDate(date);
  const resp = await client.get(`/memberbooking/?date=${sheetDate}`, {
    headers: { Cookie: getCookieHeader(), Referer: `${BASE_URL}/` },
    timeout: REQUEST_TIMEOUT,
  });

  if (typeof resp.data === "string" && resp.data.includes('action="/login.php"'))
    throw new Error("INVALID_CREDENTIALS");

  return resp.data;
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

  const { member_id, pin, date } = req.body || {};
  if (!member_id || !pin || !date)
    return res.status(400).json({ error: "member_id, pin and date required" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: "Invalid date format" });

  try {
    const html = await fetchSheet(member_id.trim(), pin.trim(), date);

    // Inject <base> so all relative URLs resolve against the real site,
    // plus a helper the parent frame calls to scroll to a given time.
    const patched = html.replace(
      /(<head[^>]*>)/i,
      `$1<base href="${BASE_URL}/memberbooking/">` +
      `<style>body{padding-top:0!important}</style>`
    );

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Allow embedding as srcdoc (no X-Frame-Options needed for srcdoc)
    return res.status(200).send(patched);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "INVALID_CREDENTIALS")
      return res.status(401).send("<!DOCTYPE html><body><p style='padding:20px;color:#c0392b'>Invalid credentials — please reload and try again.</p></body>");
    return res.status(502).send("<!DOCTYPE html><body><p style='padding:20px;color:#c0392b'>Failed to load tee sheet. Please try again.</p></body>");
  }
}
