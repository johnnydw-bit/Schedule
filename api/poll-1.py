import os, json
from urllib.parse import parse_qs, urlparse
from upstash_redis import Redis


def app(environ, start_response):
    cors = [
        ('Access-Control-Allow-Origin', '*'),
        ('Content-Type', 'application/json'),
    ]

    qs     = parse_qs(environ.get('QUERY_STRING', ''))
    job_id = qs.get('job_id', [None])[0]

    if not job_id:
        start_response('400 Bad Request', cors)
        return [json.dumps({'error': 'job_id required'}).encode()]

    try:
        redis = Redis(
            url=os.environ['UPSTASH_REDIS_REST_URL'],
            token=os.environ['UPSTASH_REDIS_REST_TOKEN'],
        )
        raw = redis.get(f'job:{job_id}')
        data = json.loads(raw) if raw else {'status': 'pending'}
        start_response('200 OK', cors)
        return [json.dumps(data).encode()]

    except Exception as e:
        start_response('500 Internal Server Error', cors)
        return [json.dumps({'status': 'error', 'message': str(e)}).encode()]
