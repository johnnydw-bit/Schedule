export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const jobId = req.query.job_id;
  if (!jobId) return res.status(400).json({ error: 'job_id required' });

  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    const resp = await fetch(`${redisUrl}/get/job:${jobId}`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    });
    const data = await resp.json();
    if (!data.result) return res.status(200).json({ status: 'pending' });
    return res.status(200).json(JSON.parse(data.result));
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
}
