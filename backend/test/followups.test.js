const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, createApp, tokens, baseSeed, A, B, U } = require("./helpers/setup");
const request = require("supertest");
const { findHits, runFollowUps, effectiveRules } = require("../lib/followups");

const app = createApp();
const T = tokens();
const H = (t) => ({ Authorization: `Bearer ${t}` });
const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const dateAgo = (d) => ago(d).slice(0, 10);
test.beforeEach(() => fake.reset(baseSeed()));

function addCase(biz, over = {}) {
  const row = { id: `c${Math.random().toString(16).slice(2, 10)}-0000-4000-8000-000000000000`, business_id: biz, case_ref: "CL-" + Math.random().toString(36).slice(2, 8).toUpperCase(), patient_id: "p1", status: "patient_contacted", owner_id: biz === A ? U.coordA : U.coordB, status_changed_at: ago(5), acknowledged_at: null, follow_up_due: null, urgency: "routine", data_origin: "live", ai_contact_allowed: true, ...over };
  fake.table("cl_cases").push(row); return row;
}
const rulePut = (tok, key, body) => request(app).put(`/api/followups/rules/${key}`).set(H(tok)).send(body);

test("engine: each rule fires only once its threshold is reached, and not for closed or escalated cases", () => {
  const now = Date.now();
  const mk = (o) => ({ id: "x", status: "patient_contacted", status_changed_at: new Date(now - 3 * DAY).toISOString(), follow_up_due: null, ...o });
  const keys = (cases, referrals = []) => findHits({ cases, referrals, now }).map((h) => h.rule_key);
  assert.deepEqual(keys([mk({})]), ["no_acknowledgement"]);
  assert.deepEqual(keys([mk({ status: "acknowledged", acknowledged_at: new Date(now - 4 * DAY).toISOString() })]), ["no_booking"]);
  assert.deepEqual(keys([mk({ status: "pending_clinical_release" })]), ["awaiting_clinician"]);
  assert.deepEqual(keys([mk({ status: "consult_booked", follow_up_due: new Date(now - 2 * DAY).toISOString().slice(0, 10) })]), ["overdue_followup"]);
  assert.deepEqual(keys([mk({ status: "consult_booked" })], [{ case_id: "x", status: "scheduled", scheduled_for: new Date(now - DAY).toISOString() }]), ["missed_appointment"]);
  assert.deepEqual(keys([mk({ status: "acknowledged" })], [{ case_id: "x", status: "requested", requested_at: new Date(now - 3 * DAY).toISOString() }]).sort(), ["no_booking", "referral_pending"]);
  assert.deepEqual(keys([mk({ status: "closed" }), mk({ status: "escalated" })]), []);
  assert.deepEqual(keys([mk({ status: "consult_booked" })], [{ case_id: "x", status: "scheduled", scheduled_for: new Date(now + DAY).toISOString() }]), [], "future appointment is fine");
});

test("run: reminders notify the owner once, change nothing on the case, and clear when the next step happens", async () => {
  const c = addCase(A);
  const r1 = await runFollowUps(A);
  assert.equal(r1.created, 1);
  const task = fake.table("cl_followup_tasks")[0];
  assert.deepEqual([task.kind, task.status, task.assigned_to, task.business_id], ["reminder", "open", U.coordA, A]);
  const notes = fake.table("cl_notifications");
  assert.deepEqual(notes.map((n) => n.user_id), [U.coordA]);
  assert.equal(c.status, "patient_contacted", "a reminder never changes the case");
  assert.equal(fake.table("cl_escalations").length, 0);
  assert.equal((await runFollowUps(A)).created, 0, "second run does not duplicate");
  assert.equal(fake.table("cl_notifications").length, 1);
  c.status = "acknowledged"; c.acknowledged_at = ago(0);   // staff took the next step
  const r3 = await runFollowUps(A);
  assert.equal(r3.resolved, 1);
  assert.deepEqual([task.status, task.resolution], ["done", "Condition cleared"]);
});

test("run: awaiting-clinician reminders also reach the hospital's clinicians", async () => {
  addCase(A, { status: "pending_clinical_release" });
  await runFollowUps(A);
  assert.deepEqual(fake.table("cl_notifications").map((n) => n.user_id).sort(), [U.coordA, U.clinA].sort());
});

test("automatic escalation never happens unless a clinician has authorised that rule", async () => {
  const c = addCase(A, { status_changed_at: ago(30) });
  await runFollowUps(A);
  assert.equal(c.status, "patient_contacted", "default: reminders only");
  assert.equal(fake.table("cl_escalations").length, 0);
});

test("a clinician-authorised rule escalates automatically as 'system', records it, and notifies owner and clinicians", async () => {
  const c = addCase(A, { status_changed_at: ago(6) });
  const set = await rulePut(T.clinA, "no_acknowledgement", { escalate_enabled: true, escalate_after_days: 5 });
  assert.equal(set.status, 200);
  const r = await runFollowUps(A);
  assert.equal(r.escalated, 1);
  assert.equal(c.status, "escalated");
  const esc = fake.table("cl_escalations")[0];
  assert.deepEqual([esc.raised_by_type, esc.status], ["system", "open"]);
  assert.match(esc.reason, /Authorised by/);
  assert.ok(fake.table("cl_case_events").some((e) => e.to_status === "escalated" && e.actor_type === "system"));
  const task = fake.table("cl_followup_tasks")[0];
  assert.deepEqual([task.kind, task.status], ["escalation", "done"]);
  assert.ok(fake.table("cl_notifications").some((n) => n.kind === "escalation" && n.user_id === U.clinA));
  // below the escalation threshold the same rule only reminds
  const c2 = addCase(A, { status_changed_at: ago(3) });
  await runFollowUps(A);
  assert.equal(c2.status, "patient_contacted");
});

test("who may configure: coordinators cannot; admins set reminders but cannot authorise escalation; clinicians can", async () => {
  assert.equal((await rulePut(T.coordA, "no_booking", { reminder_after_days: 1 })).status, 403);
  assert.equal((await rulePut(T.adminA, "no_booking", { reminder_after_days: 5 })).status, 200);
  const blocked = await rulePut(T.adminA, "no_booking", { escalate_enabled: true, escalate_after_days: 9 });
  assert.equal(blocked.status, 403);
  assert.equal(fake.table("cl_followup_rules").find((r) => r.rule_key === "no_booking").escalate_enabled, false);
  const ok = await rulePut(T.clinA, "no_booking", { escalate_enabled: true, escalate_after_days: 9 });
  assert.equal(ok.status, 200);
  const row = fake.table("cl_followup_rules").find((r) => r.rule_key === "no_booking");
  assert.deepEqual([row.escalate_enabled, row.escalation_authorised_by, row.reminder_after_days], [true, U.clinA, 5]);
  assert.ok(row.escalation_authorised_at);
  // an admin editing reminders afterwards must not strip or re-stamp the clinician's authorisation
  await rulePut(T.adminA, "no_booking", { reminder_after_days: 4 });
  assert.equal(fake.table("cl_followup_rules").find((r) => r.rule_key === "no_booking").escalation_authorised_by, U.clinA);
  // switching it off clears the authorisation
  await rulePut(T.clinA, "no_booking", { escalate_enabled: false });
  assert.equal(fake.table("cl_followup_rules").find((r) => r.rule_key === "no_booking").escalation_authorised_by, null);
});

test("rule validation", async () => {
  assert.equal((await rulePut(T.clinA, "nope", {})).status, 404);
  assert.equal((await rulePut(T.clinA, "no_booking", { reminder_after_days: -1 })).status, 400);
  assert.equal((await rulePut(T.clinA, "no_booking", { reminder_after_days: 1.5 })).status, 400);
  assert.equal((await rulePut(T.clinA, "no_booking", { escalate_enabled: true })).status, 400, "needs a day count");
  assert.equal((await rulePut(T.clinA, "no_booking", { reminder_after_days: 6, escalate_enabled: true, escalate_after_days: 2 })).status, 400, "escalation cannot precede the reminder");
});

test("a disabled rule produces nothing", async () => {
  addCase(A);
  await rulePut(T.adminA, "no_acknowledgement", { enabled: false });
  assert.equal((await runFollowUps(A)).created, 0);
});

test("tenant isolation: running for one hospital never touches another; lists and notifications are scoped", async () => {
  const a = addCase(A), b = addCase(B);
  await runFollowUps(A);
  assert.equal(fake.table("cl_followup_tasks").length, 1);
  assert.equal(fake.table("cl_followup_tasks")[0].case_id, a.id);
  await runFollowUps(B);
  assert.equal(fake.table("cl_followup_tasks").length, 2);
  const listA = (await request(app).get("/api/followups").set(H(T.coordA))).body.tasks;
  assert.deepEqual(listA.map((t) => t.case_id), [a.id]);
  assert.equal((await request(app).get("/api/followups/notifications").set(H(T.coordB))).body.notifications.every((n) => n.case_id === b.id), true);
  assert.equal((await request(app).get("/api/followups/rules")).status, 401);
  // B's coordinator cannot run A's checks or see A's rule config
  assert.equal((await request(app).post("/api/followups/run").set(H(T.coordB))).status, 403);
});

test("notifications are private to each person and can be marked read", async () => {
  addCase(A, { status: "pending_clinical_release", status_changed_at: ago(5) });
  await runFollowUps(A);
  const mine = (await request(app).get("/api/followups/notifications").set(H(T.coordA))).body;
  const clin = (await request(app).get("/api/followups/notifications").set(H(T.clinA))).body;
  const admin = (await request(app).get("/api/followups/notifications").set(H(T.adminA))).body;
  assert.equal(mine.unread, 1); assert.equal(clin.unread, 1); assert.equal(admin.unread, 0);
  await request(app).post("/api/followups/notifications/read").set(H(T.coordA));
  assert.equal((await request(app).get("/api/followups/notifications").set(H(T.coordA))).body.unread, 0);
  assert.equal((await request(app).get("/api/followups/notifications").set(H(T.clinA))).body.unread, 1, "marking mine read does not touch anyone else's");
});

test("the 'run now' endpoint works for clinicians/admins and is audited", async () => {
  addCase(A);
  const r = await request(app).post("/api/followups/run").set(H(T.adminA));
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 1);
  assert.ok(fake.table("cl_audit_log").some((a) => a.action === "followup.run"));
});
