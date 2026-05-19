"""
/api/schedule  — POST with {member_id, pin}
Scrapes the Bramley IG home page and stores the result in Upstash Redis.
Returns a job_id the client can poll against.
"""
import os, json, re, secrets
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler

import httpx
from bs4 import BeautifulSoup
from upstash_redis import Redis

BASE_URL    = "https://www.bramleygolfclub.co.uk"
LOGIN_URL   = f"{BASE_URL}/login.php"
CONSENT_URL = f"{BASE_URL}/ttbconsent.php"
HOME_URL    = f"{BASE_URL}/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}

# ── Date helpers ──────────────────────────────────────────────────────────────

def ordinal(n):
    if 11 <= (n % 100) <= 13:
        return f"{n}th"
    return f"{n}{['th','st','nd','rd','th'][min(n % 10, 4)]}"

def fmt_date(d):
    return f"{d.strftime('%A')} {ordinal(d.day)} {d.strftime('%B %Y')}"

def parse_ig_date(text):
    if not text:
        return None, False
    text = text.strip()
    today = date.today()
    m = re.search(r'(\d+)\s+days?\s+left', text, re.I)
    if m:
        return today + timedelta(days=int(m.group(1))), True
    cleaned = re.sub(r'(\d+)(st|nd|rd|th)', r'\1', text, flags=re.I).strip()
    for fmt in ('%A %d %B %Y', '%a %d %B %Y', '%d %B %Y', '%A %d %b %Y', '%a %d %b %Y'):
        try:
            return datetime.strptime(cleaned, fmt).date(), False
        except ValueError:
            pass
    for fmt in ('%A %d %B', '%a %d %B', '%d %B', '%A %d %b', '%a %d %b'):
        try:
            d = datetime.strptime(cleaned, fmt).date().replace(year=today.year)
            if d < today:
                d = d.replace(year=today.year + 1)
            return d, False
        except ValueError:
            pass
    return None, False

def get_link(cells):
    for cell in cells:
        a = cell.find('a', href=True)
        if a:
            href = a['href']
            if not href.startswith('http'):
                href = BASE_URL + '/' + href.lstrip('/')
            return href, a.get_text(strip=True) or 'Details'
    return '', ''

# ── Scraper ───────────────────────────────────────────────────────────────────

def scrape(member_id, pin):
    with httpx.Client(headers=HEADERS, follow_redirects=True, timeout=25.0) as client:
        # Login
        resp = client.get(LOGIN_URL)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, 'html.parser')
        csrf = soup.find('input', {'name': '_csrf_token'})
        if not csrf:
            raise Exception('Could not find CSRF token.')
        resp = client.post(LOGIN_URL, data={
            'task': 'login', 'topmenu': '1',
            'memberid': member_id.strip(), 'pin': pin.strip(),
            'cachemid': '1', '_csrf_token': csrf.get('value', ''), 'Submit': 'Login',
        })
        resp.raise_for_status()
        if str(resp.url).endswith('login.php'):
            raise Exception('Login failed — check your Member ID and PIN.')
        if 'ttbconsent' in str(resp.url):
            client.get(f'{CONSENT_URL}?action=accept')

        # Home page
        resp = client.get(HOME_URL)
        resp.raise_for_status()
        if 'ttbconsent' in str(resp.url):
            client.get(f'{CONSENT_URL}?action=accept')
            resp = client.get(HOME_URL)
        if 'login' in str(resp.url).lower():
            raise Exception('Session expired after login.')

        return BeautifulSoup(resp.text, 'html.parser')


def parse_competitions(soup):
    entries = []
    table = soup.find('table', class_='myupcoming')
    if not table:
        return entries
    for row in table.find_all('tr'):
        cells = row.find_all('td')
        if len(cells) < 2:
            continue
        name = cells[0].get_text(' ', strip=True)
        if not name:
            continue
        cell1 = cells[1].get_text(' ', strip=True)
        time_m = re.search(r'\b(\d{1,2}:\d{2})\b', cell1)
        tee_time = time_m.group(1) if time_m else ''
        date_text = re.sub(r'\d{1,2}:\d{2}\s*', '', cell1).strip()
        sort_date, is_deadline = parse_ig_date(date_text)
        if sort_date and is_deadline:
            display_date = f'PLAY BY {fmt_date(sort_date)}'
        elif sort_date:
            display_date = fmt_date(sort_date)
            if tee_time:
                display_date += f' at {tee_time}'
        else:
            display_date = date_text if date_text and len(date_text) > 2 else 'Date TBC'
        link, _ = get_link(cells)
        link_label = 'Details/Result' if link else ''
        nl = name.lower()
        if 'match' in nl or ' vs' in nl or ' v ' in nl:
            etype, colour = 'Match', '#1a5276'
        elif 'knockout' in nl or 'cup' in nl or 'pairs' in nl:
            etype, colour = 'Knockout', '#6c3483'
        else:
            etype, colour = 'Competition', '#1e8449'
        sort_key = sort_date.isoformat() if sort_date else '9999-12-31'
        entries.append({
            'sort_key': sort_key,
            'display_date': display_date,
            'name': name,
            'link': link,
            'link_label': link_label,
            'etype': etype,
            'colour': colour,
        })
    return entries


def parse_tee_times(soup):
    entries = []
    heading = soup.find(lambda t: t.name == 'h3' and 'tee times' in t.get_text().lower())
    if not heading:
        return entries
    table = None
    for sib in heading.find_next_siblings():
        if sib.name == 'table':
            table = sib
            break
        t = sib.find('table')
        if t:
            table = t
            break
    if not table:
        return entries
    for row in table.find_all('tr'):
        cells = row.find_all('td')
        if len(cells) < 2:
            continue
        date_text = cells[0].get_text(' ', strip=True)
        if not date_text or 'book a tee time' in date_text.lower():
            continue
        sort_date, _ = parse_ig_date(date_text)
        if not sort_date:
            continue
        tee_time      = cells[1].get_text(strip=True) if len(cells) > 1 else ''
        players_label = cells[2].get_text(strip=True) if len(cells) > 2 else ''
        all_text      = ' '.join(c.get_text(strip=True) for c in cells)
        is_rollup     = 'rollup' in all_text.lower()
        etype         = 'Roll Up' if is_rollup else 'Tee Time'
        colour        = '#b7770d' if is_rollup else '#117a65'
        link, link_label = get_link(cells)
        if link_label.lower() == 'withdraw':
            link, link_label = '', ''
        display_date = fmt_date(sort_date)
        if tee_time:
            display_date += f' at {tee_time}'
        name = players_label if players_label and 'withdraw' not in players_label.lower() else 'Tee Time'
        entries.append({
            'sort_key':     sort_date.isoformat(),
            'display_date': display_date,
            'name':         name,
            'link':         link,
            'link_label':   link_label or 'View',
            'etype':        etype,
            'colour':       colour,
        })
    return entries


# ── Vercel handler ────────────────────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body   = json.loads(self.rfile.read(length))
        member_id = body.get('member_id', '').strip()
        pin       = body.get('pin', '').strip()

        if not member_id or not pin:
            self._json(400, {'error': 'member_id and pin are required'})
            return

        job_id = secrets.token_urlsafe(16)

        try:
            redis = Redis(
                url=os.environ['UPSTASH_REDIS_REST_URL'],
                token=os.environ['UPSTASH_REDIS_REST_TOKEN'],
            )
            # Mark job as started
            redis.set(f'job:{job_id}', json.dumps({'status': 'running'}), ex=120)

            # Scrape
            soup       = scrape(member_id, pin)
            comps      = parse_competitions(soup)
            tees       = parse_tee_times(soup)
            all_entries = sorted(comps + tees, key=lambda e: (e['sort_key'] == '9999-12-31', e['sort_key']))

            # Clash detection
            from collections import defaultdict
            by_date = defaultdict(list)
            for e in all_entries:
                if e['sort_key'] != '9999-12-31':
                    by_date[e['sort_key']].append(e)
            for e in all_entries:
                e['clash'] = (e['sort_key'] != '9999-12-31' and len(by_date[e['sort_key']]) > 1)

            result = {
                'status':  'done',
                'entries': all_entries,
                'as_of':   date.today().isoformat(),
                'comp_count': sum(1 for e in all_entries if e['etype'] in ('Competition','Knockout','Match')),
                'tee_count':  sum(1 for e in all_entries if e['etype'] in ('Tee Time','Roll Up')),
            }
            redis.set(f'job:{job_id}', json.dumps(result), ex=300)
            self._json(200, {'job_id': job_id})

        except Exception as e:
            try:
                redis.set(f'job:{job_id}', json.dumps({'status': 'error', 'message': str(e)}), ex=60)
            except Exception:
                pass
            self._json(200, {'job_id': job_id})

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass
