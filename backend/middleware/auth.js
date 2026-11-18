// CareLoop tokens are issued by CareLoop's own login and signed with
// CARELOOP_JWT_SECRET, so a Sakha token can never be used here (and vice versa).
// The tenant (businessId) always comes from the verified token - never from the client.
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { permsFor, clRoleFor } = require("../lib/permissions");

const ISSUER = "sakha-careloop";
const secret = () => {
  if (!process.env.CARELOOP_JWT_SECRET) throw new Error("CARELOOP_JWT_SECRET is not set");
  return process.env.CARELOOP_JWT_SECRET;
};

function signToken(payload) {
  return jwt.sign(payload, secret(), { algorithm: "HS256", issuer: ISSUER, expiresIn: "8h" });
}

// Entitlement check on every request (cached briefly) so that switching a hospital
// off, or removing CareLoop from its plan, takes effect without waiting for tokens to expire.
const entCache = new Map();
async function tenantEntitled(businessId) {
  const ttl = Number(process.env.ENTITLEMENT_TTL_MS ?? 60000);
  const hit = entCache.get(businessId);
  if (ttl > 0 && hit && hit.exp > Date.now()) return hit.ok;
  const { data } = await db.from("businesses").select("is_active, products").eq("id", businessId).maybeSingle();
  const ok = !!data && data.is_active !== false && (data.products || []).includes("careloop");
  if (ttl > 0) entCache.set(businessId, { ok, exp: Date.now() + ttl });
  return ok;
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in required" });
  try {
    const t = jwt.verify(header.slice(7), secret(), { algorithms: ["HS256"], issuer: ISSUER });
    if (!t.businessId || !clRoleFor(t.role)) return res.status(403).json({ error: "No CareLoop access for this account" });
    req.user = {
      userId: t.userId, businessId: t.businessId, role: t.role, clRole: clRoleFor(t.role),
      name: t.name, isDemo: !!t.isDemo, perms: permsFor(t.role),
    };
  } catch (e) {
    return res.status(401).json({ error: "Session expired or invalid. Sign in again." });
  }
  try {
    if (!(await tenantEntitled(req.user.businessId))) {
      return res.status(403).json({ error: "CareLoop is not enabled for this organisation." });
    }
  } catch (e) {
    console.error("entitlement check failed", e.message);
    return res.status(503).json({ error: "Service temporarily unavailable." });
  }
  next();
}

const requirePerm = (perm) => (req, res, next) =>
  req.user.perms.includes(perm) ? next() : res.status(403).json({ error: "You do not have permission to do this." });

module.exports = { signToken, authenticate, requirePerm, ISSUER };
