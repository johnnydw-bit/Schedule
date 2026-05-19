const BASE = 'https://www.bramleygolfclub.co.uk';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${{ 1:'st', 2:'nd', 3:'rd' }[n % 10] || 'th'}`;
}
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function fmtDate(d) {
  return `${DAYS[d.getDay()]} ${ordinal(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function parseIGDate(text) {
  if (!text) return { date: null, isDeadline: false };
  text = text.trim();
  const today = new Date(); today.setHours(0,0,0,0);
  const dm = text.match(/(\d+)\s+days?\s+left/i);
  if (dm) {
    const d = new Date(today); d.setDate(d.getDate() + parseInt(dm[1]));
    return { date: d, isDeadline: true };
  }
  const cleaned = text.replace(/(\d+)(st|nd|rd|th)/gi, '$1').trim();
  for (const pat of [
    /^(?:\w+\s+)?(\d{1,2})\s+(\w+)\s+(\d{4})$/,
    /^(?:\w+\s+)?(\d{1,2})\s+(\w+)$/,
  ]) {
    const m = cleaned.match(pat);
    if (m) {
      const day = parseInt(m[1]);
      const mi  = MONTHS_SHORT.indexOf(m[2].toLowerCase().slice(0,3));
      if (mi === -1) continue;
      const year = m[3] ? parseInt(m[3]) : today.getFullYear();
      let d = new Date(year, mi, day);
      if (!m[3] && d < today) d.setFullYear(d.getFullYear() + 1);
      return { date: d, isDeadline: false };
    }
  }
  return { date: null, isDeadline: false };
}

async function fetchPage(cookieJar, url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    redirect: 'follow',
    headers: {
      ...HEADERS,
      ...(options.headers || {}),
      ...(cookieJar.header ? { Cookie: cookieJar.header } : {}),
    },
  });
  const sc = resp.headers.get('set-cookie');
  if (sc) {
    sc.split(/,(?=[^ ].*?=)/).forEach(c => {
      const [k, v] = c.split(';')[0].trim().split('=');
      if (k) cookieJar.cookies[k.trim()] = v || '';
    });
    cookieJar.header = Object.entries(cookieJar.cookies).map(([k,v]) => `${k}=${v}`).join('; ');
  }
  return { url: resp.url, text: await resp.text(), status: resp.status };
}

async function scrape(memberId, pin) {
  const jar = { cookies: {}, header: '' };
  const loginPage = await fetchPage(jar, `${BASE}/login.php`);
  const csrfM = loginPage.text.match(/name="_csrf_token"[^>]+value="([^"]+)"/);
  if (!csrfM) throw new Error('Could not find CSRF token.');
  const resp = await fetchPage(jar, `${BASE}/login.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      task: 'login', topmenu: '1',
      memberid: memberId.trim(), pin: pin.trim(),
      cachemid: '1', _csrf_token: csrfM[1], Submit: 'Login',
    }).toString(),
  });
  if (resp.url.endsWith('login.php')) throw new Error('Login failed — check your Member ID and PIN.');
  if (resp.url.includes('ttbconsent')) await fetchPage(jar, `${BASE}/ttbconsent.php?action=accept`);
  let home = await fetchPage(jar, `${BASE}/`);
  if (home.url.includes('ttbconsent')) {
    await fetchPage(jar, `${BASE}/ttbconsent.php?action=accept`);
    home = await fetchPage(jar, `${BASE}/`);
  }
  if (home.url.toLowerCase().includes('login')) throw new Error('Session expired.');
  return home.text;
}

function parseHTML(html) {
  const entries = [];
  const stripTags = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Competitions
  const ct = html.match(/class="[^"]*myupcoming[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (ct) {
    for (const row of ct[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => stripTags(c[1]));
      if (cells.length < 2 || !cells[0]) continue;
      const timeM = cells[1].match(/\b(\d{1,2}:\d{2})\b/);
      const teeTime = timeM ? timeM[1] : '';
      const dateText = cells[1].replace(/\d{1,2}:\d{2}\s*/g, '').trim();
      const { date: sd, isDeadline } = parseIGDate(dateText);
      let displayDate = sd
        ? (isDeadline ? `PLAY BY ${fmtDate(sd)}` : fmtDate(sd) + (teeTime ? ` at ${teeTime}` : ''))
        : (dateText || 'Date TBC');
      const linkM = row[1].match(/href="([^"]+)"/);
      let link = '';
      if (linkM) link = linkM[1].startsWith('http') ? linkM[1] : `${BASE}/${linkM[1].replace(/^\//,'')}`;
      const nl = cells[0].toLowerCase();
      const [etype, colour] = nl.includes('match') || nl.includes(' vs') ? ['Match','#1a5276']
        : nl.includes('knockout') || nl.includes('cup') || nl.includes('pairs') ? ['Knockout','#6c3483']
        : ['Competition','#1e8449'];
      entries.push({ sort_key: sd ? sd.toISOString().slice(0,10) : '9999-12-31',
        display_date: displayDate, name: cells[0], link, link_label: link ? 'Details/Result' : '',
        etype, colour, clash: false });
    }
  }

  // Tee times
  const tt = html.match(/My Tee Times[\s\S]*?(<table[\s\S]*?<\/table>)/i);
  if (tt) {
    for (const row of tt[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => stripTags(c[1]));
      if (cells.length < 2 || !cells[0] || cells[0].toLowerCase().includes('book a tee time')) continue;
      const { date: sd } = parseIGDate(cells[0]);
      if (!sd) continue;
      const allText = cells.join(' ').toLowerCase();
      const isRollup = allText.includes('rollup') || allText.includes('roll up');
      const viewM = row[1].match(/href="([^"]+)"[^>]*>\s*View\s*</i);
      let link = '';
      if (viewM) link = viewM[1].startsWith('http') ? viewM[1] : `${BASE}/${viewM[1].replace(/^\//,'')}`;
      const players = cells[2] && !cells[2].toLowerCase().includes('withdraw') ? cells[2] : 'Tee Time';
      entries.push({ sort_key: sd.toISOString().slice(0,10),
        display_date: fmtDate(sd) + (cells[1] ? ` at ${cells[1]}` : ''),
        name: players, link, link_label: link ? 'View' : '',
        etype: isRollup ? 'Roll Up' : 'Tee Time',
        colour: isRollup ? '#b7770d' : '#117a65', clash: false });
    }
  }

  entries.sort((a,b) => {
    if (a.sort_key === '9999-12-31' && b.sort_key !== '9999-12-31') return 1;
    if (b.sort_key === '9999-12-31' && a.sort_key !== '9999-12-31') return -1;
    return a.sort_key.localeCompare(b.sort_key);
  });

  const byDate = {};
  entries.forEach(e => { if (e.sort_key !== '9999-12-31') byDate[e.sort_key] = (byDate[e.sort_key]||0)+1; });
  entries.forEach(e => { e.clash = e.sort_key !== '9999-12-31' && (byDate[e.sort_key]||0) > 1; });
  return entries;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const { member_id, pin } = req.body || {};
  if (!member_id || !pin) return res.status(400).json({ error: 'member_id and pin required' });

  try {
    const html    = await scrape(member_id, pin);
    const entries = parseHTML(html);
    const today   = new Date();
    return res.status(200).json({
      status: 'done',
      entries,
      as_of:      today.toISOString().slice(0,10),
      comp_count: entries.filter(e => ['Competition','Knockout','Match'].includes(e.etype)).length,
      tee_count:  entries.filter(e => ['Tee Time','Roll Up'].includes(e.etype)).length,
    });
  } catch(err) {
    return res.status(200).json({ status: 'error', message: err.message });
  }
}
