const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, createApp, tokens, baseSeed, A, B, U } = require("./helpers/setup");
const request = require("supertest");

const app = createApp();
const T = tokens();
const H = (t) => ({ Authorization: `Bearer ${t}` });
const DEPT_A = "d1000000-0000-4000-8000-0000000000a1", DEPT_A2 = "d1000000-0000-4000-8000-0000000000a2", DEPT_B = "d1000000-0000-4000-8000-0000000000b1";
const iso = (h) => new Date(Date.now() + h * 3600000).toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test.beforeEach(() => {
  const s = baseSeed();
  s.cl_departments = [{ id: DEPT_A, business_id: A, name: "Endocrinology" }, { id: DEPT_A2, business_id: A, name: "Cardiology" }, { id: DEPT_B, business_id: B, name: "B dept" }];
  fake.reset(s);
});

async function mkCase(status = "acknowledged", over = {}) {
  const r = await request(app).post("/api/cases").set(H(T.coordA)).send({
    patient: { full_name: "Ref Patient" }, screening_type: "Diabetes (HbA1c / glucose)", screening_date: daysAgo(5), result_summary: "HbA1c 7.4%",
    clinical_interpretation: "Above threshold", recommended_next_step: "Endocrinology consultation", department_id: DEPT_A, urgency: "soon", ...over,
  });
  const row = fake.table("cl_cases").find((c) => c.id === r.body.case.id);
  Object.assign(row, { status, consult_completed_at: ["consult_completed", "referral_completed", "pending_closure_review"].includes(status) ? new Date().toISOString() : null });
  return row.id;
}
const mkRef = (caseId, tok = T.coordA, body = {}) => request(app).post("/api/referrals").set(H(tok)).send({ case_id: caseId, department_id: DEPT_A, ...body });
const act = (id, action, tok = T.coordA, body = {}) => request(app).post(`/api/referrals/${id}/action`).set(H(tok)).send({ action, ...body });
const refOf = (id) => fake.table("cl_referrals").find((r) => r.id === id);
const caseOf = (id) => fake.table("cl_cases").find((c) => c.id === id);

test("creating a referral: needs a released case, one open referral at a time, own-tenant department and assignee", async () => {
  const pending = await mkCase("pending_clinical_release");
  assert.equal((await mkRef(pending)).status, 409, "must be released first");
  const closed = await mkCase("closed");
  assert.equal((await mkRef(closed)).status, 409);

  const c = await mkCase();
  assert.equal((await mkRef(c, T.coordA, { department_id: DEPT_B })).status, 400, "other tenant's department");
  assert.equal((await mkRef(c, T.coordA, { assigned_to: U.clinB })).status, 400, "other tenant's staff");
  assert.equal((await mkRef(c, T.coordA, { department_id: DEPT_A2 })).status, 400, "different department needs an explanation");
  assert.equal((await mkRef(c, T.coordA, { department_id: DEPT_A2, note: "Cardiac symptoms reported" })).status, 201);
  assert.equal((await mkRef(c)).status, 409, "second open referral refused");
  assert.equal(fake.table("cl_referrals").length, 1);
});

test("a new referral takes its reason from the authorised next step and is labelled with the tenant and origin", async () => {
  const c = await mkCase();
  const r = await mkRef(c, T.clinA, { assigned_to: U.clinA });
  assert.equal(r.status, 201);
  assert.equal(r.body.referral.reason, "Endocrinology consultation");
  assert.equal(r.body.referral.status, "requested");
  assert.equal(r.body.referral.business_id, A);
  assert.ok(fake.table("cl_case_events").some((e) => e.event_type === "referral_created"));
});

test("booking is NOT completion: scheduling moves the case to 'booked' only, and completion needs attendance evidence plus a clinician", async () => {
  const c = await mkCase();
  const ref = (await mkRef(c)).body.referral.id;
  assert.equal((await act(ref, "schedule", T.coordA, { scheduled_for: iso(48) })).status, 409, "cannot schedule before acceptance");
  assert.equal((await act(ref, "accept")).status, 200);
  const sch = await act(ref, "schedule", T.coordA, { scheduled_for: iso(48) });
  assert.equal(sch.status, 200);
  assert.equal(refOf(ref).status, "scheduled");
  assert.equal(caseOf(c).status, "consult_booked");
  // nothing allows skipping straight to completion
  assert.equal((await act(ref, "complete", T.clinA, { note: "done" })).status, 409);
  assert.equal((await act(ref, "attend", T.coordA, { note: "" })).status, 400, "attendance needs written evidence");
  assert.equal((await act(ref, "attend", T.coordA, { note: "Seen by Dr Hassan on the ward" })).status, 200);
  assert.equal(caseOf(c).status, "consult_completed");
  assert.ok(caseOf(c).consult_completed_at);
  // the open referral blocks closure
  caseOf(c).status = "pending_closure_review";
  const closeTry = await request(app).post(`/api/cases/${c}/transition`).set(H(T.clinA)).send({ to: "closed", note: "closing", closure_reason: "completed_care", closure_evidence: "Consultation attended, plan documented" });
  assert.equal(closeTry.status, 409);
  assert.match(closeTry.body.error, /referral/i);
  caseOf(c).status = "consult_completed";
  assert.equal((await act(ref, "complete", T.coordA, { note: "done" })).status, 403, "coordinator cannot complete");
  assert.equal((await act(ref, "complete", T.clinA, { note: "Treatment plan agreed and documented" })).status, 200);
  assert.equal(refOf(ref).status, "completed");
  assert.equal(caseOf(c).status, "referral_completed");
  // now the case can proceed to closure
  assert.equal((await request(app).post(`/api/cases/${c}/transition`).set(H(T.coordA)).send({ to: "pending_closure_review", note: "Evidence on file" })).status, 200);
  const close = await request(app).post(`/api/cases/${c}/transition`).set(H(T.clinA)).send({ to: "closed", note: "Reviewed", closure_reason: "completed_care", closure_evidence: "Consultation attended, outcome documented in the referral" });
  assert.equal(close.status, 200);
});

test("scheduling is refused until the patient has acknowledged, and leaves everything unchanged", async () => {
  const c = await mkCase("released");
  const ref = (await mkRef(c)).body.referral.id;
  await act(ref, "accept");
  const r = await act(ref, "schedule", T.coordA, { scheduled_for: iso(24) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /acknowledg/i);
  assert.equal(refOf(ref).status, "accepted");
  assert.equal(caseOf(c).status, "released");
});

test("appointment time must be valid and not in the past", async () => {
  const c = await mkCase();
  const ref = (await mkRef(c)).body.referral.id;
  await act(ref, "accept");
  assert.equal((await act(ref, "schedule", T.coordA, {})).status, 400);
  assert.equal((await act(ref, "schedule", T.coordA, { scheduled_for: "tomorrow-ish" })).status, 400);
  assert.equal((await act(ref, "schedule", T.coordA, { scheduled_for: iso(-72) })).status, 400);
  assert.equal(refOf(ref).status, "accepted");
});

test("missed appointment: referral goes back to accepted, case back to acknowledged, count kept, can be rebooked", async () => {
  const c = await mkCase();
  const ref = (await mkRef(c)).body.referral.id;
  await act(ref, "accept"); await act(ref, "schedule", T.coordA, { scheduled_for: iso(24) });
  assert.equal((await act(ref, "missed", T.coordA, {})).status, 400, "note required");
  assert.equal((await act(ref, "missed", T.coordA, { note: "Patient did not attend; phone off" })).status, 200);
  assert.deepEqual([refOf(ref).status, refOf(ref).missed_count, refOf(ref).scheduled_for], ["accepted", 1, null]);
  assert.equal(caseOf(c).status, "acknowledged");
  assert.equal((await act(ref, "schedule", T.coordA, { scheduled_for: iso(96) })).status, 200);
  assert.equal(caseOf(c).status, "consult_booked");
});

test("rejection records the reason and automatically escalates the case to clinical review", async () => {
  const c = await mkCase();
  const ref = (await mkRef(c)).body.referral.id;
  assert.equal((await act(ref, "reject", T.coordA, { note: "No capacity this month" })).status, 400, "reason code required");
  const r = await act(ref, "reject", T.coordA, { reason_code: "capacity", note: "No capacity this month" });
  assert.equal(r.status, 200);
  assert.equal(r.body.escalated, true);
  assert.deepEqual([refOf(ref).status, refOf(ref).rejection_reason_code], ["rejected", "capacity"]);
  assert.equal(caseOf(c).status, "escalated");
  const esc = fake.table("cl_escalations")[0];
  assert.deepEqual([esc.raised_by_type, esc.status, esc.business_id], ["system", "open", A]);
  assert.match(esc.reason, /Referral rejected/);
  const ev = fake.table("cl_case_events").filter((e) => e.case_id === c);
  assert.ok(ev.some((e) => e.event_type === "referral_reject") && ev.some((e) => e.to_status === "escalated" && e.actor_type === "system"));
  // a clinician reviews and a new referral can then be made
  const resume = await request(app).post(`/api/cases/${c}/transition`).set(H(T.clinA)).send({ to: "acknowledged", note: "Will refer to another department" });
  assert.equal(resume.status, 200);
  assert.equal((await mkRef(c, T.coordA, { department_id: DEPT_A2, note: "Alternative provider" })).status, 201);
});

test("delays are recorded with a reason and surfaced; cancellation needs a note and frees the case", async () => {
  const c = await mkCase();
  const ref = (await mkRef(c)).body.referral.id;
  assert.equal((await act(ref, "delay", T.coordA, { note: "Waiting", reason_code: "nonsense" })).status, 400);
  assert.equal((await act(ref, "delay", T.coordA, { note: "Clinic is full this week", reason_code: "capacity" })).status, 200);
  assert.equal(refOf(ref).status, "requested");
  const list = (await request(app).get("/api/referrals").set(H(T.coordA))).body.referrals;
  assert.ok(list[0].issues.includes("Delay recorded"));
  assert.equal((await act(ref, "cancel", T.coordA, {})).status, 400);
  assert.equal((await act(ref, "cancel", T.coordA, { note: "Patient chose private provider" })).status, 200);
  assert.equal((await mkRef(c)).status, 201, "a new referral is allowed after cancellation");
});

test("tenant isolation: another hospital cannot see or act on referrals", async () => {
  const c = await mkCase();
  const ref = (await mkRef(c)).body.referral.id;
  assert.equal((await act(ref, "accept", T.coordB)).status, 404);
  assert.equal((await mkRef(c, T.coordB)).status, 404);
  assert.deepEqual((await request(app).get("/api/referrals").set(H(T.coordB))).body.referrals, []);
  assert.equal(refOf(ref).status, "requested");
});

test("worklist flags missed attendance recording; overview 'needs attention' shows it", async () => {
  const c = await mkCase();
  const ref = (await mkRef(c)).body.referral.id;
  await act(ref, "accept"); await act(ref, "schedule", T.coordA, { scheduled_for: iso(48) });
  refOf(ref).scheduled_for = iso(-30); // the appointment time has now passed with no attendance recorded
  const list = (await request(app).get("/api/referrals?status=scheduled").set(H(T.coordA))).body.referrals;
  assert.equal(list.length, 1);
  assert.ok(list[0].issues.includes("Appointment date passed, attendance not recorded"));
  assert.equal(list[0].patient_name, "Ref Patient");
  const ov = (await request(app).get("/api/overview").set(H(T.coordA))).body;
  assert.equal(ov.referrals_open, 1);
  assert.ok(ov.needs_attention.find((a) => a.id === c).reasons.includes("Appointment date passed, attendance not recorded"));
});

test("unknown actions and wrong-state actions are rejected without changing anything", async () => {
  const c = await mkCase();
  const ref = (await mkRef(c)).body.referral.id;
  assert.equal((await act(ref, "teleport")).status, 400);
  assert.equal((await act(ref, "attend", T.coordA, { note: "seen" })).status, 409, "cannot attend a referral that is not scheduled");
  assert.equal((await act("not-a-uuid", "accept")).status, 404);
  assert.equal(refOf(ref).status, "requested");
});

test("with an open referral, the case cannot be moved around it (booking/consultation/completion go through the referral)", async () => {
  const c = await mkCase();
  const ref = (await mkRef(c)).body.referral.id;
  const move = (to, tok = T.clinA) => request(app).post(`/api/cases/${c}/transition`).set(H(tok)).send({ to, note: "direct case move" });
  assert.equal((await move("consult_booked")).status, 409, "referral not yet scheduled");
  await act(ref, "accept"); await act(ref, "schedule", T.coordA, { scheduled_for: iso(48) });
  assert.equal(caseOf(c).status, "consult_booked");
  assert.equal((await move("consult_completed")).status, 409, "attendance must be recorded on the referral");
  assert.equal(caseOf(c).status, "consult_booked");
  await act(ref, "attend", T.coordA, { note: "Seen in clinic" });
  caseOf(c).status = "consult_completed";
  assert.equal((await move("referral_completed")).status, 409, "the referral record must be completed");
  assert.equal(refOf(ref).status, "attended");
});

test("cases WITHOUT a referral keep working exactly as before", async () => {
  const c = await mkCase();
  const move = (to) => request(app).post(`/api/cases/${c}/transition`).set(H(T.clinA)).send({ to, note: "recorded directly" });
  assert.equal((await move("consult_booked")).status, 200);
  assert.equal((await move("consult_completed")).status, 200);
  assert.equal((await move("referral_completed")).status, 200);
});
