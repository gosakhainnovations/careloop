const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, createApp } = require("./helpers/setup");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const { seedDemo } = require("../scripts/seed-demo");
const sm = require("../lib/stateMachine");

const app = createApp();

test("demo seed creates a labelled, simulated hospital with consistent data", async () => {
  fake.reset({});
  const r = await seedDemo(fake, { password: "Demo-Pass-123!" });
  assert.equal(r.created, true);
  const biz = fake.table("businesses")[0];
  assert.deepEqual([biz.is_demo, biz.products], [true, ["careloop"]]);
  assert.match(biz.business_name, /Simulated/);
  assert.ok(fake.table("cl_cases").length >= 8);
  assert.ok(fake.table("cl_cases").every((c) => c.data_origin === "simulated" && c.business_id === biz.id));
  assert.ok(fake.table("cl_patients").every((p) => p.data_origin === "simulated"));
  assert.ok(fake.table("business_users").every((u) => u.email.endsWith(".invalid") && bcrypt.compareSync("Demo-Pass-123!", u.password_hash)));
  assert.ok(fake.table("cl_case_events").filter((e) => e.actor_type === "ai").every((e) => e.metadata.simulated === true), "every AI event is marked simulated");
});

test("every seeded case follows the real lifecycle rules and ends in its stored status", async () => {
  fake.reset({});
  await seedDemo(fake, { password: "Demo-Pass-123!" });
  for (const c of fake.table("cl_cases")) {
    const evs = fake.table("cl_case_events").filter((e) => e.case_id === c.id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    assert.equal(evs[0].event_type, "case_registered", c.case_ref);
    let cur = "pending_clinical_release";
    for (const e of evs.filter((x) => x.to_status && x.from_status)) {
      assert.equal(e.from_status, cur, `${c.case_ref} chain continuity`);
      assert.ok(sm.TRANSITIONS[e.from_status][e.to_status], `${c.case_ref}: ${e.from_status}->${e.to_status} is a legal transition`);
      cur = e.to_status;
    }
    assert.equal(cur, c.status, `${c.case_ref} final status matches`);
    if (c.status === "closed") assert.ok(c.closure_reason && c.closure_evidence.length >= 10 && c.closed_by && c.consult_completed_at);
    if (["urgent", "critical"].includes(c.urgency)) assert.equal(c.ai_contact_allowed, false);
  }
});

test("seed is idempotent", async () => {
  fake.reset({});
  await seedDemo(fake, { password: "x1" });
  const n = fake.table("cl_cases").length;
  const again = await seedDemo(fake, { password: "x2" });
  assert.equal(again.created, false);
  assert.equal(fake.table("cl_cases").length, n);
  assert.equal(fake.table("businesses").length, 1);
});

test("demo story works end to end through the real API (login -> overview -> clinician closes a case)", async () => {
  fake.reset({});
  await seedDemo(fake, { password: "Demo-Pass-123!" });
  const login = (email) => request(app).post("/api/auth/login").send({ email, password: "Demo-Pass-123!" });
  const clin = (await login("dr.demo@careloop-demo.invalid")).body;
  assert.equal(clin.user.business.is_demo, true);
  const H = { Authorization: `Bearer ${clin.token}` };

  const ov = (await request(app).get("/api/overview").set(H)).body;
  assert.ok(ov.overdue >= 2 && ov.urgent_open >= 1 && ov.data_origin.live === 0);
  const flagship = (await request(app).get("/api/cases?q=Amira").set(H)).body.cases[0];
  assert.equal(flagship.status, "consult_booked");
  assert.equal(flagship.is_overdue, true, "the stalled referral is flagged");
  assert.ok(ov.needs_attention.some((a) => a.case_ref === "CL-DEMO01"));

  const review = (await request(app).get("/api/cases?status=pending_closure_review").set(H)).body.cases[0];
  const bad = await request(app).post(`/api/cases/${review.id}/transition`).set(H).send({ to: "closed", note: "x", closure_reason: "completed_care", closure_evidence: "ok" });
  assert.equal(bad.status, 400);
  const ok = await request(app).post(`/api/cases/${review.id}/transition`).set(H).send({ to: "closed", note: "Reviewed", closure_reason: "completed_care", closure_evidence: "Consultation attended, confirmatory HbA1c recorded, plan documented" });
  assert.equal(ok.status, 200);

  const coord = (await login("coordinator.demo@careloop-demo.invalid")).body;
  const pending = (await request(app).get("/api/cases?status=pending_clinical_release").set({ Authorization: `Bearer ${coord.token}` })).body.cases[0];
  const denied = await request(app).post(`/api/cases/${pending.id}/transition`).set({ Authorization: `Bearer ${coord.token}` }).send({ to: "released" });
  assert.equal(denied.status, 403);
});

test("phase 2 demo data: referrals and escalation are consistent and the stalled referral is flagged", async () => {
  fake.reset({});
  await seedDemo(fake, { password: "Demo-Pass-123!" });
  const refs = fake.table("cl_referrals");
  assert.ok(refs.length >= 4 && refs.every((r) => r.data_origin === "simulated"));
  const open = ["requested", "accepted", "scheduled", "attended"];
  const perCase = {};
  refs.filter((r) => open.includes(r.status)).forEach((r) => { perCase[r.case_id] = (perCase[r.case_id] || 0) + 1; });
  assert.ok(Object.values(perCase).every((n) => n === 1), "at most one open referral per case");
  for (const r of refs) {
    if (r.status === "scheduled") assert.ok(r.scheduled_for);
    if (["attended", "completed"].includes(r.status)) assert.ok(r.attended_at && r.attended_note.length >= 3);
    if (r.status === "completed") assert.ok(r.completed_at && r.completed_by && r.outcome_note.length >= 3);
  }
  const flagship = fake.table("cl_cases").find((c) => c.case_ref === "CL-DEMO01");
  const fr = refs.find((r) => r.case_id === flagship.id);
  assert.equal(fr.status, "scheduled");
  assert.ok(Date.parse(fr.scheduled_for) < Date.now(), "the booked appointment has passed with no attendance recorded");
  assert.equal(fake.table("cl_escalations").length, 1);
  assert.equal(fake.table("cl_escalations")[0].status, "open");

  const login = await request(app).post("/api/auth/login").send({ email: "dr.demo@careloop-demo.invalid", password: "Demo-Pass-123!" });
  const H = { Authorization: `Bearer ${login.body.token}` };
  const ov = (await request(app).get("/api/overview").set(H)).body;
  const flagged = ov.needs_attention.find((a) => a.case_ref === "CL-DEMO01");
  assert.ok(flagged.reasons.includes("Appointment date passed, attendance not recorded"));
  assert.ok(ov.referrals_open >= 2);
  const wl = (await request(app).get("/api/referrals").set(H)).body.referrals;
  assert.ok(wl.find((r) => r.case_ref === "CL-DEMO08").issues.length >= 1, "delayed referral is flagged");
});

test("a demo hospital seeded in Phase 1 is topped up with Phase 2 data, once", async () => {
  fake.reset({});
  await seedDemo(fake, { password: "Demo-Pass-123!" });
  // simulate a Phase 1 database: no referrals, no escalations, no referral events
  fake.table("cl_referrals").length = 0; fake.table("cl_escalations").length = 0;
  const evs = fake.table("cl_case_events"); for (let i = evs.length - 1; i >= 0; i--) if (evs[i].event_type.startsWith("referral_")) evs.splice(i, 1);
  const again = await seedDemo(fake, { password: "ignored" });
  assert.equal(again.created, false);
  assert.ok(again.added.referrals >= 4 && again.added.escalations === 1);
  const n = fake.table("cl_referrals").length;
  const third = await seedDemo(fake, {});
  assert.deepEqual(third.added, { referrals: 0, escalations: 0 });
  assert.equal(fake.table("cl_referrals").length, n);
});

test("seeded events never share a timestamp within a case (stable ordering on a real database)", async () => {
  fake.reset({});
  await seedDemo(fake, { password: "Demo-Pass-123!" });
  const seen = new Set();
  for (const e of fake.table("cl_case_events")) {
    const k = e.case_id + "|" + e.created_at;
    assert.ok(!seen.has(k), `duplicate timestamp ${k}`);
    seen.add(k);
  }
});
