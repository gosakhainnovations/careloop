const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, createApp, baseSeed, A, B, jwt } = require("./helpers/setup");
const request = require("supertest");
const bcrypt = require("bcryptjs");

const app = createApp();
const seedUsers = () => {
  const s = baseSeed();
  const hash = bcrypt.hashSync("Correct-Horse-9", 4);
  s.business_users.forEach((u) => (u.password_hash = hash));
  s.businesses.push({ id: "cccccccc-0000-4000-8000-00000000000c", business_name: "FrontDesk Only", is_active: true, products: ["frontdesk"], is_demo: false });
  s.businesses.push({ id: "dddddddd-0000-4000-8000-00000000000d", business_name: "Disabled Hospital", is_active: false, products: ["careloop"], is_demo: false });
  s.business_users.push(
    { id: "e0000000-0000-4000-8000-0000000000e1", business_id: "cccccccc-0000-4000-8000-00000000000c", email: "fd@c.test", role: "admin", password_hash: hash },
    { id: "e0000000-0000-4000-8000-0000000000e2", business_id: "dddddddd-0000-4000-8000-00000000000d", email: "x@d.test", role: "admin", password_hash: hash },
    { id: "e0000000-0000-4000-8000-0000000000e3", business_id: A, email: "super@a.test", role: "super_admin", password_hash: hash },
    { id: "e0000000-0000-4000-8000-0000000000e4", business_id: null, email: "nobiz@a.test", role: "admin", password_hash: hash },
  );
  return s;
};
const login = (email, password = "Correct-Horse-9") => request(app).post("/api/auth/login").send({ email, password });

test("valid login returns a token, role, permissions and tenant (no password data)", async () => {
  fake.reset(seedUsers());
  const res = await login("dr.a@a.test");
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, "clinician");
  assert.ok(res.body.user.permissions.includes("case.close"));
  assert.equal(res.body.user.business.id, A);
  assert.ok(!JSON.stringify(res.body).includes("password"));
  const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${res.body.token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.business.name, "Hospital A");
});

test("wrong password and unknown email give the same generic error", async () => {
  fake.reset(seedUsers());
  const a = await login("dr.a@a.test", "wrong"), b = await login("nobody@a.test", "whatever");
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
});

test("a tenant without the CareLoop product, or an inactive tenant, cannot sign in", async () => {
  fake.reset(seedUsers());
  assert.equal((await login("fd@c.test")).status, 403);
  assert.equal((await login("x@d.test")).status, 403);
});

test("accounts with no CareLoop role or no hospital are refused", async () => {
  fake.reset(seedUsers());
  assert.equal((await login("super@a.test")).status, 403);
  assert.equal((await login("nobiz@a.test")).status, 403);
});

test("tokens signed with another secret (e.g. a Sakha token) are rejected", async () => {
  fake.reset(seedUsers());
  const sakhaStyle = jwt.sign({ userId: "u", businessId: A, role: "admin" }, "sakha-secret", { expiresIn: "1h" });
  const noIssuer = jwt.sign({ userId: "u", businessId: A, role: "admin" }, process.env.CARELOOP_JWT_SECRET, { expiresIn: "1h" });
  for (const t of [sakhaStyle, noIssuer, "garbage"]) {
    assert.equal((await request(app).get("/api/cases").set("Authorization", `Bearer ${t}`)).status, 401);
  }
  assert.equal((await request(app).get("/api/cases")).status, 401);
});

test("login is rate limited", async () => {
  fake.reset(seedUsers());
  let last;
  for (let i = 0; i < 12; i++) last = await login("ratelimit@a.test", "bad");
  assert.equal(last.status, 429);
});

test("CareLoop is switched off for a tenant immediately on /me", async () => {
  fake.reset(seedUsers());
  const { body } = await login("dr.a@a.test");
  fake.table("businesses").find((b) => b.id === A).products = ["frontdesk"];
  assert.equal((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${body.token}`)).status, 403);
});

test("a switched-off tenant is locked out of data routes even with a valid token", async () => {
  fake.reset(seedUsers());
  const { body } = await login("dr.a@a.test");
  assert.equal((await request(app).get("/api/cases").set("Authorization", `Bearer ${body.token}`)).status, 200);
  fake.table("businesses").find((b) => b.id === A).is_active = false;
  assert.equal((await request(app).get("/api/cases").set("Authorization", `Bearer ${body.token}`)).status, 403);
});
