const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../config/db");
const { signToken, authenticate } = require("../middleware/auth");
const { clRoleFor, permsFor, CL_ROLE_LABELS } = require("../lib/permissions");
const { rateLimit } = require("../lib/rateLimit");
const { audit } = require("../lib/audit");

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  key: (req) => `${req.ip}|${String((req.body && req.body.email) || "").toLowerCase()}`,
});

// Compared against when the email is unknown, so timing does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);
const displayName = (email) => String(email || "").split("@")[0].replace(/[._-]+/g, " ");

router.post("/login", loginLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const password = String((req.body && req.body.password) || "");
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });

  const { data: user } = await db.from("business_users").select("id, business_id, email, password_hash, role").eq("email", email).maybeSingle();
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: "Incorrect email or password." });

  if (!user.business_id) return res.status(403).json({ error: "Sign in with a hospital account." });
  const { data: biz } = await db.from("businesses").select("id, business_name, is_active, products, is_demo").eq("id", user.business_id).maybeSingle();
  if (!biz || biz.is_active === false || !(biz.products || []).includes("careloop")) {
    return res.status(403).json({ error: "CareLoop is not enabled for this organisation." });
  }
  if (!clRoleFor(user.role)) return res.status(403).json({ error: "This account does not have CareLoop access." });

  const name = displayName(user.email);
  const token = signToken({ userId: user.id, businessId: user.business_id, role: user.role, name, isDemo: !!biz.is_demo });
  await audit({ businessId: user.business_id, userId: user.id, role: user.role }, "auth.login", "user", user.id, {}, req.ip);
  res.json({ token, user: userPayload({ userId: user.id, role: user.role, name }, biz) });
});

function userPayload(u, biz) {
  const clRole = clRoleFor(u.role);
  return {
    id: u.userId, name: u.name, role: clRole, role_label: CL_ROLE_LABELS[clRole],
    permissions: permsFor(u.role),
    business: { id: biz.id, name: biz.business_name, is_demo: !!biz.is_demo },
  };
}

router.get("/me", authenticate, async (req, res) => {
  const { data: biz } = await db.from("businesses").select("id, business_name, is_demo, is_active, products").eq("id", req.user.businessId).maybeSingle();
  if (!biz || biz.is_active === false || !(biz.products || []).includes("careloop")) {
    return res.status(403).json({ error: "CareLoop is not enabled for this organisation." });
  }
  res.json({ user: userPayload(req.user, biz) });
});

module.exports = router;
