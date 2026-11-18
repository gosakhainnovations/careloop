// Tiny in-memory limiter for the login endpoint (single instance). Replace with a
// shared store if the service is ever scaled to multiple instances.
function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const rec = hits.get(k);
    if (!rec || rec.reset < now) {
      hits.set(k, { count: 1, reset: now + windowMs });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      res.set("Retry-After", String(Math.ceil((rec.reset - now) / 1000)));
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    next();
  };
}
module.exports = { rateLimit };
