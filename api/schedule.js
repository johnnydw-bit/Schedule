const https = require('https');
const http = require('http');

// ── Upstash Redis helper (no npm needed — raw REST calls) ─────────────────
async function redisSet(key, value, ex) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const body = JSON.stringify(['SET', key, value, 'EX', ex]);
  return fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, value, 'EX', String(ex)]]),
  });
}

// ── Date helpers ──────────────────────────────────────────────────────────
function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const MONTHS_SHORT = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function fmtDate(d) {
  return `${DAYS[d.getDay()]} ${ordinal(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function parseIGDate(text) {
  if (!text) return { date: null, isDeadline: false };
  text = text.trim();
  const today = new Date(); today.setHours(0,0,0,0);

  // N days left to play
  const dm = text.match(/(\d+)\s+days?\s+left/i);
  if (dm) {
    const d = new Date(today); d.setDate(d.getDate() + parseInt(dm[1]));
    return { date: d, isDeadline: true };
  }

  // Remove ordinal suffixes
  const cleaned = text.replace(/(\d+)(st|nd|rd|th)/gi, '$1').trim();

  // Try parsing — with and without year, long and short month
  const patterns = [
    /^(?:\w+\s+)?(\d{1,2})\s+(\w+)\s+(\d{4})$/,  // "Monday 25 May 2026"
    /^(?:\w+\s+)?(\d{1,2})\s+(\w+)$/,             // "Monday 25 May"
  ];

  for (const pat of patterns) {
    const m = cleaned.match(pat);
    if (m) {
      const day = parseInt(m[1]);
      const monthStr = m[2].toLowerCase().slice(0, 3);
      const monthIdx = MONTHS_SHORT.indexOf(monthStr);
      if (monthIdx === -1) continue;
      const year = m[3] ? parseInt(m[3]) : today.getFullYear();
      let d = new Date(year, monthIdx, day);
      if (!m[3] && d < today) d.setFullYear(d.getFullYear() + 1);
      return { date: d, isDeadline: false };
    }
  }

  return { date: null, isDeadline: false };
}

// ── Fetch a URL with redirect following ──────────────────────────────────
async function fetchUrl(client, url, options = {}) {
  // Use node-fetch style — we'll use the global fetch available in Node 18+
  const resp = await fetch(url, {
    ...options,
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
      ...(options.headers || {}),
      ...(client.cookieHeader ? { Cookie: client.cookieHeader } : {}),
    },
  });
  // Store cookies
  const setCookie = resp.headers.get('set-cookie');
  if (setCookie) {
    const cookies = setCookie.split(/,(?=[^ ].*?=)/).map(c => c.split(';')[0].trim());
    client.cookies = client.cookies || {};
    cookies.forEach(c => {
      const [k, v] = c.split('='); if (k) client.cookies[k.trim()] = v || '';
    });
    client.cookieHeader = Object.entries(client.cookies).map(([k,v]) => `${k}=${v}`).join('; ');
  }
  return { url: resp.url, text: await resp.text(), status: resp.status };
}

// ── Scraper ───────────────────────────────────────────────────────────────
async function scrape(memberId, pin) {
  const BASE = 'https://www.bramleygolfclub.co.uk';
  const client = { cookies: {}, cookieHeader: '' };

  // GET login page for CSRF
  const loginPage = await fetchUrl(client, `${BASE}/login.php`);
  const csrfMatch = loginPage.text.match(/name="_csrf_token"[^>]+value="([^"]+)"/);
  if (!csrfMatch) throw new Error('Could not find CSRF token on login page.');
  const csrfToken = csrfMatch[1];

  // POST login
  const formData = new URLSearchParams({
    task: 'login', topmenu: '1',
    memberid: memberId.trim(), pin: pin.trim(),
    cachemid: '1', _csrf_token: csrfToken, Submit: 'Login',
  });
  const loginResp = await fetchUrl(client, `${BASE}/login.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
  });

  if (loginResp.url.endsWith('login.php')) {
    throw new Error('Login failed — check your Member ID and PIN.');
  }
  if (loginResp.url.includes('ttbconsent')) {
    await fetchUrl(client, `${BASE}/ttbconsent.php?action=accept`);
  }

  // GET home page
  let homeResp = await fetchUrl(client, `${BASE}/`);
  if (homeResp.url.includes('ttbconsent')) {
    await fetchUrl(client, `${BASE}/ttbconsent.php?action=accept`);
    homeResp = await fetchUrl(client, `${BASE}/`);
  }
  if (homeResp.url.toLowerCase().includes('login')) {
    throw new Error('Session expired after login.');
  }

  return homeResp.text;
}

// ── HTML parser (no cheerio — use regex for simplicity) ──────────────────
function parseHTML(html) {
  const entries = [];

  // ── Competitions: table with class="myupcoming" ────────────────────────
  const compTableMatch = html.match(/class="[^"]*myupcoming[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (compTableMatch) {
    const rows = compTableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(c => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      if (cells.length < 2 || !cells[0]) continue;

      const name  = cells[0];
      const cell1 = cells[1];
      const timeM = cell1.match(/\b(\d{1,2}:\d{2})\b/);
      const teeTime = timeM ? timeM[1] : '';
      const dateText = cell1.replace(/\d{1,2}:\d{2}\s*/g, '').trim();
      const { date: sortDate, isDeadline } = parseIGDate(dateText);

      let displayDate;
      if (sortDate && isDeadline) {
        displayDate = `PLAY BY ${fmtDate(sortDate)}`;
      } else if (sortDate) {
        displayDate = fmtDate(sortDate);
        if (teeTime) displayDate += ` at ${teeTime}`;
      } else {
        displayDate = dateText || 'Date TBC';
      }

      // Extract link
      const linkM = row[1].match(/href="([^"]+)"[^>]*>([^<]+)</);
      let link = '', linkLabel = '';
      if (linkM) {
        link = linkM[1].startsWith('http') ? linkM[1] : `https://www.bramleygolfclub.co.uk/${linkM[1].replace(/^\//, '')}`;
        linkLabel = 'Details/Result';
      }

      const nl = name.toLowerCase();
      let etype, colour;
      if (nl.includes('match') || nl.includes(' vs') || nl.includes(' v ')) {
        etype = 'Match'; colour = '#1a5276';
      } else if (nl.includes('knockout') || nl.includes('cup') || nl.includes('pairs')) {
        etype = 'Knockout'; colour = '#6c3483';
      } else {
        etype = 'Competition'; colour = '#1e8449';
      }

      entries.push({
        sort_key: sortDate ? sortDate.toISOString().slice(0,10) : '9999-12-31',
        display_date: displayDate, name, link, link_label: linkLabel,
        etype, colour, clash: false,
      });
    }
  }

  // ── Tee times: table after <h3>My Tee Times</h3> ─────────────────────
  const teeSection = html.match(/My Tee Times[\s\S]*?(<table[\s\S]*?<\/table>)/i);
  if (teeSection) {
    const rows = teeSection[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(c => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      if (cells.length < 2 || !cells[0]) continue;
      if (cells[0].toLowerCase().includes('book a tee time')) continue;

      const { date: sortDate } = parseIGDate(cells[0]);
      if (!sortDate) continue;

      const teeTime      = cells[1] || '';
      const playersLabel = cells[2] || '';
      const allText      = cells.join(' ').toLowerCase();
      const isRollup     = allText.includes('rollup') || allText.includes('roll up');

      const etype  = isRollup ? 'Roll Up' : 'Tee Time';
      const colour = isRollup ? '#b7770d' : '#117a65';

      // Extract View link (not Withdraw)
      let link = '', linkLabel = 'View';
      const linkM = row[1].match(/href="([^"]+)"[^>]*>\s*View\s*</i);
      if (linkM) {
        link = linkM[1].startsWith('http') ? linkM[1] : `https://www.bramleygolfclub.co.uk/${linkM[1].replace(/^\//, '')}`;
      }

      let displayDate = fmtDate(sortDate);
      if (teeTime) displayDate += ` at ${teeTime}`;

      const name = (playersLabel && !playersLabel.toLowerCase().includes('withdraw'))
        ? playersLabel : 'Tee Time';

      entries.push({
        sort_key: sortDate.toISOString().slice(0,10),
        display_date: displayDate, name, link, link_label: linkLabel,
        etype, colour, clash: false,
      });
    }
  }

  // Sort
  entries.sort((a, b) => {
    if (a.sort_key === '9999-12-31' && b.sort_key !== '9999-12-31') return 1;
    if (b.sort_key === '9999-12-31' && a.sort_key !== '9999-12-31') return -1;
    return a.sort_key.localeCompare(b.sort_key);
  });

  // Clash detection
  const byDate = {};
  entries.forEach(e => {
    if (e.sort_key !== '9999-12-31') {
      byDate[e.sort_key] = (byDate[e.sort_key] || 0) + 1;
    }
  });
  entries.forEach(e => {
    e.clash = e.sort_key !== '9999-12-31' && (byDate[e.sort_key] || 0) > 1;
  });

  return entries;
}

// ── Vercel handler ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const { member_id, pin } = req.body || {};
  if (!member_id || !pin) return res.status(400).json({ error: 'member_id and pin required' });

  const jobId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Store initial status
  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  async function rset(key, val, ex) {
    await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(val), 'EX', String(ex)]]),
    });
  }

  await rset(`job:${jobId}`, { status: 'running' }, 120);

  // Run scrape (we're within the 10s Vercel limit for a single page fetch)
  try {
    const html    = await scrape(member_id, pin);
    const entries = parseHTML(html);
    const today   = new Date();

    await rset(`job:${jobId}`, {
      status:     'done',
      entries,
      as_of:      today.toISOString().slice(0,10),
      comp_count: entries.filter(e => ['Competition','Knockout','Match'].includes(e.etype)).length,
      tee_count:  entries.filter(e => ['Tee Time','Roll Up'].includes(e.etype)).length,
    }, 300);

  } catch (err) {
    await rset(`job:${jobId}`, { status: 'error', message: err.message }, 60);
  }

  return res.status(200).json({ job_id: jobId });
}
