"""
/api/poll?job_id=xxx  — GET
Returns the current status of a scrape job from Upstash Redis.
"""
import os, json
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from upstash_redis import Redis


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        job_id = params.get('job_id', [None])[0]

        if not job_id:
            self._json(400, {'error': 'job_id required'})
            return

        try:
            redis = Redis(
                url=os.environ['UPSTASH_REDIS_REST_URL'],
                token=os.environ['UPSTASH_REDIS_REST_TOKEN'],
            )
            raw = redis.get(f'job:{job_id}')
            if raw is None:
                self._json(200, {'status': 'pending'})
            else:
                self._json(200, json.loads(raw))
        except Exception as e:
            self._json(500, {'status': 'error', 'message': str(e)})

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')

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
