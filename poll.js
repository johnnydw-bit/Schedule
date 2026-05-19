export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const jobId = req.query.job_id;
  if (!jobId) return res.status(400).json({ error: 'job_id required' });

  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(`job:${jobId}`)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!data.result) return res.status(200).json({ status: 'pending' });
    return res.status(200).json(JSON.parse(data.result));
  } catch(err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
}
