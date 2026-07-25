import axios from "axios";
import * as cheerio from "cheerio";

const BASE_URL   = "https://www.bramleygolfclub.co.uk";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_TEE_TIME = "10:00";

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayIso() {
  // Use UK local date so the cron (which runs in UTC) gets the right day in BST
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

function isoToBramley(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function friendlyDate(iso) {
  return new Date(iso + "T12:00:00Z")
    .toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

// ── Bramley login ─────────────────────────────────────────────────────────────

async function createSession(memberId, pin) {
  const cookieJar = {};
  function setCookies(header) {
    if (!header) return;
    for (const c of (Array.isArray(header) ? header : [header])) {
      const [kv] = c.split(";");
      const eq = kv.indexOf("=");
      if (eq > 0) cookieJar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
  }
  function cookieHeader() {
    return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const client = axios.create({
    baseURL: BASE_URL, timeout: 12000,
    headers: { "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.5" },
    withCredentials: true, maxRedirects: 5, validateStatus: s => s < 500,
  });

  const lp = await client.get("/login.php", { headers: { Cookie: cookieHeader() } });
  setCookies(lp.headers["set-cookie"]);
  const $l = cheerio.load(lp.data);
  const csrf = $l('input[name="_csrf_token"]').val();
  if (!csrf) throw new Error("No CSRF token on login page");

  const lr = await client.post("/login.php",
    new URLSearchParams({ task: "login", topmenu: "1", memberid: memberId,
      pin, cachemid: "1", _csrf_token: csrf, Submit: "Login" }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(), Referer: `${BASE_URL}/login.php` },
      maxRedirects: 0, validateStatus: s => s < 400 || s === 302 });
  setCookies(lr.headers["set-cookie"]);

  if (typeof lr.data === "string" && lr.data.includes("memberid") && lr.data.includes("pin"))
    throw new Error("INVALID_CREDENTIALS");

  const cr = await client.get("/ttbconsent.php?action=accept",
    { headers: { Cookie: cookieHeader(), Referer: `${BASE_URL}/login.php` },
      maxRedirects: 5, validateStatus: s => s < 500 });
  setCookies(cr.headers["set-cookie"]);

  return { client, cookieHeader };
}

// ── Tee sheet: find Moths slot + entered players ──────────────────────────────

async function getMothsSlot(client, cookieHeader, dateIso) {
  const resp = await client.get("/memberbooking/",
    { params: { date: isoToBramley(dateIso), course: "1", group: "1" },
      headers: { Cookie: cookieHeader() }, timeout: 12000 });

  const $ = cheerio.load(resp.data);
  let result = null;

  $("table#member_teetimes tbody tr").each((_i, row) => {
    if (result) return; // already found
    const rawTime = $(row).find("th.slot-time").text().trim();
    if (!rawTime) return;
    const compTitle = $(row).find(".comp-name-text").first().text().trim();
    if (!compTitle || !/moth/i.test(compTitle)) return;

    const time = rawTime.replace(/^(\d):/, "0$1:");

    // Collect entered player names from the signed-up list
    const signedUpDiv = $(row).find(".rollup-info .rollup-entrants-list").filter((_j, el) =>
      /signed up/i.test($(el).text())
    );
    const players = signedUpDiv.length
      ? signedUpDiv.find("i").first().text().split(",").map(n => n.trim()).filter(Boolean)
      : [];

    result = { time, title: compTitle, players };
  });

  return result; // null if no Moths slot this day
}

// ── Directory: look up mobile number for a player name ───────────────────────

async function lookupPhone(client, cookieHeader, playerName) {
  // Search by surname (last word, or last two words for compound surnames)
  const parts = playerName.trim().split(/\s+/);
  const searches = [];
  if (parts.length >= 2) searches.push(parts.slice(-2).join(" "));
  searches.push(parts[parts.length - 1]);

  for (const term of searches) {
    try {
      const resp = await client.get("/directory.php",
        { params: { search: term, action: "search" },
          headers: { Cookie: cookieHeader() }, timeout: 10000 });

      const $ = cheerio.load(resp.data);
      const html = resp.data;

      // Prefer a mobile (07xxx) near the player's name; fall back to any UK number
      const mobileRe = /\b(07\d{3}\s?\d{6}|\+44\s?7\d{3}\s?\d{6})\b/g;
      const anyUkRe  = /\b(0[12378]\d{2,4}\s?\d{4,6}|\+44\s?\d{2,4}\s?\d{3,4}\s?\d{4})\b/g;

      // Try to find a number in a table row / list item that also contains the name
      let phone = null;
      $("tr, li, div.member, div.directory-row, p").each((_i, el) => {
        if (phone) return;
        const text = $(el).text();
        const namePart = parts[parts.length - 1].toLowerCase();
        if (!text.toLowerCase().includes(namePart)) return;
        const m = text.match(mobileRe) || text.match(anyUkRe);
        if (m) phone = m[0];
      });

      // Fallback: first mobile in entire page
      if (!phone) {
        const m = html.match(mobileRe);
        if (m) phone = m[0];
      }

      if (phone) {
        // Normalise to E.164
        phone = phone.replace(/\s/g, "");
        if (phone.startsWith("0")) phone = "+44" + phone.slice(1);
        return phone;
      }
    } catch { /* try next search term */ }
  }
  return null;
}

// ── Twilio: SMS + WhatsApp ────────────────────────────────────────────────────

async function sendTwilio(to, body, channel = "sms") {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = channel === "whatsapp"
    ? (process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_FROM_NUMBER)
    : process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from)
    throw new Error(`Twilio ${channel} env vars not set`);

  const toAddr   = channel === "whatsapp" ? `whatsapp:${to}` : to;
  const fromAddr = channel === "whatsapp"
    ? (from.startsWith("whatsapp:") ? from : `whatsapp:${from}`)
    : from;

  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    new URLSearchParams({ To: toAddr, From: fromAddr, Body: body }).toString(),
    { auth: { username: sid, password: token },
      headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
}

async function notify(phone, message) {
  const results = {};
  try {
    await sendTwilio(phone, message, "sms");
    results.sms = "sent";
  } catch (e) {
    results.sms = `failed: ${e.message}`;
  }
  try {
    await sendTwilio(phone, message, "whatsapp");
    results.whatsapp = "sent";
  } catch (e) {
    results.whatsapp = `failed: ${e.message}`;
  }
  return results;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Auth: Vercel cron sends Authorization: Bearer <CRON_SECRET>
  // Manual callers can pass ?secret=xxx for convenience
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/, "");
    const qsSecret = req.query?.secret || "";
    if (bearer !== cronSecret && qsSecret !== cronSecret) {
      return res.status(401).json({ error: "Unauthorised" });
    }
  }

  const dateIso = req.query?.testDate || todayIso();
  const log     = [`Date: ${dateIso}`];

  try {
    const memberId = process.env.NOTIFY_MEMBER_ID;
    const pin      = process.env.NOTIFY_PIN;
    if (!memberId || !pin) throw new Error("NOTIFY_MEMBER_ID / NOTIFY_PIN not set");

    const { client, cookieHeader } = await createSession(memberId, pin);
    log.push("Logged in ✓");

    const slot = await getMothsSlot(client, cookieHeader, dateIso);

    if (!slot) {
      log.push("No Moths roll-up today — nothing to do.");
      return res.status(200).json({ status: "no-rollup", log });
    }

    log.push(`Moths slot found: ${slot.time} — "${slot.title}"`);
    log.push(`Entered players (${slot.players.length}): ${slot.players.join(", ")}`);

    if (slot.time === DEFAULT_TEE_TIME) {
      log.push(`Tee time is ${DEFAULT_TEE_TIME} (default) — no notification needed.`);
      return res.status(200).json({ status: "on-time", teeTime: slot.time, log });
    }

    log.push(`Tee time changed to ${slot.time} — sending notifications…`);

    const day     = friendlyDate(dateIso);
    const message = `Hi, just to let you know the MOTHs Roll-Up tee time on ${day} has changed to ${slot.time}. See you on the course!`;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const playerResults = [];

    for (const name of slot.players) {
      const phone = await lookupPhone(client, cookieHeader, name);
      if (!phone) {
        log.push(`  ${name}: no phone found in directory`);
        playerResults.push({ name, phone: null, sms: "skipped", whatsapp: "skipped" });
        await sleep(300);
        continue;
      }
      log.push(`  ${name}: ${phone} — sending…`);
      const sent = await notify(phone, message);
      log.push(`    SMS: ${sent.sms}  WhatsApp: ${sent.whatsapp}`);
      playerResults.push({ name, phone, ...sent });
      await sleep(500); // be polite to both Bramley and Twilio
    }

    return res.status(200).json({
      status: "notified",
      date: dateIso,
      teeTime: slot.time,
      message,
      players: playerResults,
      log,
    });

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return res.status(500).json({ status: "error", error: err.message, log });
  }
}
