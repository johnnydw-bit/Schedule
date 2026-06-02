import { fetchHandicapMap } from "./handicaps.js";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowed = origin === ALLOWED_ORIGIN ||
    /^https:\/\/bramley-schedule(-[a-z0-9]+)*\.vercel\.app$/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : ALLOWED_ORIGIN);

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const map = await fetchHandicapMap();
    const entries = [...map.entries()].slice(0, 20);
    return res.status(200).json({
      count: map.size,
      sample: entries.map(([surname, hcp]) => ({ surname, hcp })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
