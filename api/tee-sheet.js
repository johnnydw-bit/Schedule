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

  const lp = await client.get("/login.php", { headers: { Cookie: getCookieHeader() } });
  setCookies(lp.headers["set-cookie"]);
  const csrfMatch = lp.data.match(/name="_csrf_token"\s+value="([^"]+)"/);
  if (!csrfMatch) throw new Error("Could not find CSRF token");
  const csrf = csrfMatch[1];

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

  const sheetDate = isoToSheetDate(date);
  const resp = await client.get(`/memberbooking/?date=${sheetDate}`, {
    headers: { Cookie: getCookieHeader(), Referer: `${BASE_URL}/` },
    timeout: REQUEST_TIMEOUT,
  });

  if (typeof resp.data === "string" && resp.data.includes('action="/login.php"'))
    throw new Error("INVALID_CREDENTIALS");

  return resp.data;
}

// Build a clean, minimal HTML page showing only the Moths section of the tee sheet.
function buildViewer(html) {
  const $ = cheerio.load(html);

  // ── Remove action buttons ───────────────────────────────────────────────────
  $('.rollupSignupContainer').remove();
  $('a').filter((_i, el) =>
    /removefromcomp/i.test($(el).attr('href') || '')
  ).remove();
  $('.slot-actions').empty();

  // ── Find the Moths competition ID ───────────────────────────────────────────
  let mothsId = null;
  $('.comp-name-text').each((_i, el) => {
    if (/moth/i.test($(el).text())) {
      const m = ($(el).closest('tr').attr('class') || '').match(/rollup-(\d+)/);
      if (m) { mothsId = m[1]; return false; }
    }
  });

  // ── Pre-expand the Moths roll-up (same as clicking "Show tee times") ────────
  // The expand button just toggles an "expanded" CSS class — no AJAX needed.
  if (mothsId) {
    $(`.event-expand-btn[data-eventid="rollup-${mothsId}"]`).addClass('expanded');
    $(`tr.rollup-${mothsId}`).addClass('expanded');
  }

  // ── Trim table rows to Moths block ± 3 context rows ─────────────────────────
  const allRows = $('table#member_teetimes tbody tr').toArray();
  if (mothsId && allRows.length) {
    let firstIdx = -1, lastIdx = -1;
    allRows.forEach((row, i) => {
      if ($(row).hasClass(`rollup-${mothsId}`)) {
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      }
    });
    if (firstIdx >= 0) {
      const keepFrom = Math.max(0, firstIdx - 3);
      const keepTo   = Math.min(allRows.length - 1, lastIdx + 2);
      allRows.forEach((row, i) => {
        if (i < keepFrom || i > keepTo) $(row).remove();
      });
    }
  }

  // ── Collect stylesheet URLs from the original page ──────────────────────────
  const cssLinks = [];
  $('link[rel="stylesheet"]').each((_i, el) => {
    let href = $(el).attr('href') || '';
    if (!href) return;
    if (!href.startsWith('http'))
      href = `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
    cssLinks.push(`<link rel="stylesheet" href="${href}">`);
  });

  // ── Build minimal wrapper page ──────────────────────────────────────────────
  const tableHtml = $('table#member_teetimes').toString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${cssLinks.join('\n')}
<style>
  body { margin: 0; padding: 6px 8px 10px; background: #fff; }
  table { width: 100%; border-collapse: collapse; }
  thead.tableFloatingHeader th { position: static !important; }
  .slot-actions { display: none !important; }
  .row-expand-btn { display: none !important; }
  .teenote { border-bottom: none !important; }
  /* Ensure all event rows are visible (expansion already applied server-side) */
  tr[data-event="1"] { display: table-row !important; }
</style>
</head>
<body>
${tableHtml}
</body>
</html>`;
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
    const viewer = buildViewer(html);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(viewer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "INVALID_CREDENTIALS")
      return res.status(401).send("<!DOCTYPE html><body style='padding:20px;color:#c0392b'>Invalid credentials — please reload.</body>");
    return res.status(502).send("<!DOCTYPE html><body style='padding:20px;color:#c0392b'>Failed to load tee sheet. Please try again.</body>");
  }
}
