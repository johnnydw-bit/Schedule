import axios from "axios";
import * as cheerio from "cheerio";
import { fetchHandicapMap, enrichNames } from "./handicaps.js";

const BASE_URL = "https://www.bramleygolfclub.co.uk";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT = 8000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoToSheetDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

// Parse enter/withdraw action details from a roll-up row element.
function parseRollUpActions($s, row) {
  const $row = $s(row);
  let enterAction = null;
  let withdrawAction = null;

  // Check <a> links
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

  // Check <form> elements
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

    const fields = {};
    $form.find("input").each((_j, inp) => {
      const type = ($s(inp).attr("type") || "text").toLowerCase();
      const name = $s(inp).attr("name");
      const value = $s(inp).attr("value") || "";
      if (name && type !== "submit") fields[name] = value;
    });

    const submitText = $form.find('input[type="submit"],button[type="submit"],button:not([type])').text().trim() ||
      $form.find('input[type="submit"]').attr("value") || "";

    const formAction = { method, url, fields };
    if (/withdraw|remove/i.test(submitText)) {
      withdrawAction = withdrawAction || formAction;
    } else if (/sign.{0,3}up|join|enter|book|add/i.test(submitText)) {
      enterAction = enterAction || formAction;
    }
  });

  let isEntered = null;
  if (withdrawAction !== null) isEntered = true;
  else if (enterAction !== null) isEntered = false;

  return { isEntered, actions: { enter: enterAction, withdraw: withdrawAction } };
}

// Fetch tee sheet and return map of "HH:MM" -> { title, isEntered, actions }
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
        // Count signed-up players
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

// Find the Moths roll-up slot in a sheet. Returns time string or null/undefined.
function findMothsSlot(sheet) {
  if (!sheet) return undefined;
  for (const [time, data] of Object.entries(sheet)) {
    if (data.title && /moth/i.test(data.title)) return time;
  }
  return null;
}

// ── Login sequence ────────────────────────────────────────────────────────────

async function login(memberId, pin) {
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

  return { client, getCookieHeader };
}

// ── Execute a single action ───────────────────────────────────────────────────

async function executeOneAction(memberId, pin, date, actionType) {
  // 1. Login
  const { client, getCookieHeader } = await login(memberId, pin);
  const cookieHeader = getCookieHeader();

  // 2. Fetch tee sheet
  let sheet = await fetchTeeSheet(client, cookieHeader, date);
  if (sheet === null) {
    await new Promise(r => setTimeout(r, 600));
    sheet = await fetchTeeSheet(client, cookieHeader, date);
  }
  if (sheet === null) {
    return { date, action: actionType, success: false, message: "Could not fetch tee sheet" };
  }

  // 3. Find Moths slot
  const mothsTime = findMothsSlot(sheet);
  if (mothsTime === undefined || mothsTime === null) {
    return { date, action: actionType, success: false, message: "No Moths roll-up slot found for this date" };
  }

  const slot = sheet[mothsTime];

  // 4. Get action details
  const actionDetails = slot.actions[actionType];
  if (!actionDetails) {
    // Determine a sensible message
    if (actionType === "enter" && slot.isEntered === true) {
      return { date, action: actionType, success: false, message: "Already entered — withdraw first if you want to re-enter" };
    }
    if (actionType === "withdraw" && slot.isEntered === false) {
      return { date, action: actionType, success: false, message: "Not entered — nothing to withdraw" };
    }
    return { date, action: actionType, success: false, message: `No ${actionType} action available for this slot` };
  }

  // 5. Execute
  try {
    if (actionDetails.method === "get") {
      // Disable automatic redirect following so we can manually re-send cookies
      // on the redirect follow. Axios may strip the Cookie header on automatic
      // redirects, which causes the server's counter decrement to be skipped
      // even though the player name is removed.
      const withdrawResp = await client.get(actionDetails.url, {
        headers: { Cookie: cookieHeader, Referer: `${BASE_URL}/memberbooking/?date=${isoToSheetDate(date)}` },
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 0,
        validateStatus: s => s < 400 || s === 302,
      });
      // Manually follow the redirect with cookies, matching browser behaviour
      if (withdrawResp.status === 302 && withdrawResp.headers.location) {
        let loc = withdrawResp.headers.location;
        if (!loc.startsWith("http"))
          loc = `${BASE_URL}${loc.startsWith("/") ? "" : "/"}${loc}`;
        await client.get(loc, {
          headers: { Cookie: cookieHeader, Referer: actionDetails.url },
          timeout: REQUEST_TIMEOUT,
        });
      }
    } else {
      // POST with form-encoded fields
      await client.post(actionDetails.url,
        new URLSearchParams(actionDetails.fields).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookieHeader,
            Referer: `${BASE_URL}/memberbooking/?date=${isoToSheetDate(date)}`,
          },
          timeout: REQUEST_TIMEOUT,
        }
      );
    }
    // Re-fetch the sheet to get the updated player count/names
    let playerCount = null;
    let playerNames = null;
    try {
      const [freshSheet, handicapMap] = await Promise.all([
        fetchTeeSheet(client, cookieHeader, date),
        fetchHandicapMap(),
      ]);
      const freshTime = findMothsSlot(freshSheet);
      if (freshSheet && freshTime) {
        playerCount = freshSheet[freshTime].playerCount ?? null;
        playerNames = enrichNames(freshSheet[freshTime].playerNames ?? null, handicapMap);
      }
    } catch { /* non-critical */ }

    return { date, action: actionType, success: true,
      message: `Successfully ${actionType === "enter" ? "entered" : "withdrew from"} Moths roll-up on ${date}`,
      playerCount, playerNames };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { date, action: actionType, success: false, message: `Request failed: ${msg}` };
  }
}

// ── Vercel handler ────────────────────────────────────────────────────────────

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

  const { member_id, pin, actions } = req.body || {};
  if (!member_id || !pin) return res.status(400).json({ error: "member_id and pin required" });
  if (!Array.isArray(actions) || actions.length === 0)
    return res.status(400).json({ error: "actions array required" });

  // Validate each action item
  for (const item of actions) {
    if (!item.date || !/^\d{4}-\d{2}-\d{2}$/.test(item.date))
      return res.status(400).json({ error: `Invalid date: ${item.date}` });
    if (item.action !== "enter" && item.action !== "withdraw")
      return res.status(400).json({ error: `action must be "enter" or "withdraw", got: ${item.action}` });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const BATCH = 3;
  const results = [];

  try {
    for (let i = 0; i < actions.length; i += BATCH) {
      const batch = actions.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map(({ date, action }) =>
          executeOneAction(member_id.trim(), pin.trim(), date, action)
            .catch(err => {
              const message = err instanceof Error ? err.message : String(err);
              if (message === "INVALID_CREDENTIALS")
                return { date, action, success: false, message: "Invalid credentials" };
              return { date, action, success: false, message: `Unexpected error: ${message}` };
            })
        )
      );
      results.push(...batchResults);
      if (i + BATCH < actions.length) await sleep(300);
    }
    return res.status(200).json({ status: "done", results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "INVALID_CREDENTIALS")
      return res.status(401).json({ status: "error", message: "Invalid credentials — check your Member ID and PIN." });
    return res.status(502).json({ status: "error", message: "Failed to process actions. Please try again." });
  }
}
