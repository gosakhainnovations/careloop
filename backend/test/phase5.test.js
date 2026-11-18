const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, createApp, tokens, baseSeed, A, B, U } = require("./helpers/setup");
const request = require("supertest");
const { computeAnalytics } = require("../lib/analytics");

const app = createApp(); const T = tokens(); const H = (t) => ({ Authorization: `Bearer ${t}` });
const DAY = 86400000, ago = (d) => new Date(Date.now() - d * DAY).toISOString(), dateAgo = (d) => ago(d).slice(0, 10);
const DEPT = "d1000000-0000-4000-8000-0000000000a1";
test.beforeEach(() => { const s = baseSeed(); s.cl_departments = [{ id: DEPT, business_id: A, name: "Endocrinology" }]; s.cl_referrals = []; s.cl_escalations = []; s.cl_notifications = []; fake.reset(s); });

async function mk(over = {}, patient = {}) {
  const r = await request(app).post("/api/cases").set(H(T.coordA)).send({
    patient: { full_name: "Ramesh Kumar", date_of_birth: "1971-06-04", preferred_language: "en", contact_consent: true, consent_channels: ["voice", "sms"], phone: "+0", ...patient },
    screening_type: "Diabetes (HbA1c / glucose)", screening_date: dateAgo(5), result_summary: "HbA1c 7.4%", clinical_interpretation: "SECRET-INTERPRETATION-TEXT",
    recommended_next_step: "See an endocrinologist within 14 days.", department_id: DEPT, urgency: "soon", ...over });
  const id = r.body.case.id; await request(app).post(`/api/cases/${id}/transition`).set(H(T.clinA)).send({ to: "released" });
  return id;
}
const call = (id, scenario, tok = T.coordA) => request(app).post(`/api/cases/${id}/simulate-call`).set(H(tok)).send({ scenario });
const row = (id) => fake.table("cl_cases").find((c) => c.id === id);
const evs = (id) => fake.table("cl_case_events").filter((e) => e.case_id === id);

test("simulated call: patient understands -> contacted and acknowledged by the AI, a consultation request for staff, transcript saved", async () => {
  const id = await mk();
  const r = await call(id, "acknowledged");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.steps, ["patient_contacted", "acknowledged"]);
  assert.equal(row(id).status, "acknowledged");
  const ai = evs(id).filter((e) => e.actor_type === "ai");
  assert.ok(ai.length >= 3 && ai.every((e) => e.metadata.simulated === true && /simulated/i.test(e.actor_name)));
  assert.ok(ai.filter((e) => e.metadata.transcript).length === 1, "transcript stored once");
  const ref = fake.table("cl_referrals")[0];
  assert.deepEqual([ref.status, ref.requested_by, ref.department_id], ["requested", null, DEPT]);
  assert.equal(r.body.referral_requested, true);
  assert.equal(fake.table("cl_audit_log").filter((a) => a.action === "case.simulated_call").length, 1);
});

test("the call speaks only the approved next step, after the date-of-birth check, and never the interpretation or result", async () => {
  const id = await mk(); const { body } = await call(id, "acknowledged");
  const text = body.transcript.map((t) => t.text).join(" ");
  assert.ok(text.includes("See an endocrinologist within 14 days."));
  assert.ok(!text.includes("SECRET-INTERPRETATION-TEXT") && !text.includes("HbA1c 7.4%"));
  const iDob = body.transcript.findIndex((t) => /date of birth/i.test(t.text)), iStep = body.transcript.findIndex((t) => t.text.includes("endocrinologist"));
  assert.ok(iDob >= 0 && iStep > iDob, "identity is checked before any information");
  assert.ok(body.transcript.some((t) => /in your own words/i.test(t.text)), "teach-back confirms understanding");
  assert.ok(body.transcript.some((t) => /nothing is booked until/i.test(t.text)));
});

test("a medical question is not answered: it is routed to staff and the owner and clinicians are notified", async () => {
  const id = await mk(); const { body } = await call(id, "question");
  assert.equal(body.question_routed, true);
  const t = body.transcript.map((x) => x.text).join(" ");
  assert.match(t, /not able to answer/i);
  assert.ok(!/serious|medicine/i.test(body.transcript.filter((x) => x.who === "assistant").map((x) => x.text).join(" ")), "the assistant never discusses the question");
  assert.ok(evs(id).some((e) => e.event_type === "ai_question_routed"));
  const who = fake.table("cl_notifications").map((n) => n.user_id).sort();
  assert.deepEqual(who, [U.coordA, U.clinA].sort());
});

test("no answer or failed identity check: marked unreachable, and nothing about the result is spoken", async () => {
  for (const sc of ["no_answer", "identity_failed"]) {
    const id = await mk(); const { body } = await call(id, sc);
    assert.equal(row(id).status, "unreachable");
    const text = body.transcript.map((x) => x.text).join(" ");
    assert.ok(!text.includes("endocrinologist") && !text.includes("Diabetes"), sc);
    assert.equal(fake.table("cl_referrals").length, 0);
  }
});

test("a patient who declines is escalated to staff, not recorded as declined by the AI", async () => {
  const id = await mk(); const r = await call(id, "declines");
  assert.equal(r.status, 200); assert.equal(row(id).status, "escalated");
  assert.equal(fake.table("cl_escalations")[0].raised_by_type, "ai");
  assert.equal(fake.table("cl_referrals").length, 0);
});

test("the call is refused when it would be unsafe", async () => {
  const urgent = await mk({ urgency: "critical" }); assert.equal((await call(urgent, "acknowledged")).status, 409);
  const noConsent = await mk({}, { contact_consent: false, consent_channels: [] }); assert.equal((await call(noConsent, "acknowledged")).status, 409);
  const smsOnly = await mk({}, { consent_channels: ["sms"] }); assert.equal((await call(smsOnly, "acknowledged")).status, 409, "no voice consent");
  const arabic = await mk({}, { preferred_language: "ar" }); const ar = await call(arabic, "acknowledged"); assert.equal(ar.status, 409); assert.match(ar.body.error, /Arabic/);
  const noDob = await mk({}, { date_of_birth: null }); assert.equal((await call(noDob, "acknowledged")).status, 409);
  const pending = (await request(app).post("/api/cases").set(H(T.coordA)).send({ patient: { full_name: "P", date_of_birth: "1980-01-01", contact_consent: true, consent_channels: ["voice"] }, screening_type: "Other", screening_date: dateAgo(1), result_summary: "x" })).body.case.id;
  assert.equal((await call(pending, "acknowledged")).status, 409, "must be released first");
  const ok = await mk(); await call(ok, "acknowledged"); assert.equal((await call(ok, "acknowledged")).status, 409, "already acknowledged");
  assert.equal((await call(ok, "teleport")).status, 400);
  for (const id of [urgent, noConsent, smsOnly, arabic, noDob, pending]) assert.ok(!evs(id).some((e) => e.actor_type === "ai"), "refused calls leave no trace");
});

test("a retry after an earlier unanswered attempt works from 'patient contacted'", async () => {
  const id = await mk(); row(id).status = "patient_contacted";
  const r = await call(id, "acknowledged"); assert.equal(r.status, 200); assert.deepEqual(r.body.steps, ["acknowledged"]); assert.equal(row(id).status, "acknowledged");
  assert.ok(evs(id).some((e) => e.metadata && e.metadata.transcript), "transcript is still stored");
});

test("only one open referral: a second call does not create another request; tenant isolation holds", async () => {
  const id = await mk(); fake.table("cl_referrals").push({ id: "r1", business_id: A, case_id: id, department_id: DEPT, status: "accepted" });
  const r = await call(id, "acknowledged"); assert.equal(r.body.referral_requested, false); assert.equal(fake.table("cl_referrals").length, 1);
  const id2 = await mk(); assert.equal((await call(id2, "acknowledged", T.coordB)).status, 404);
  assert.equal(row(id2).status, "released");
});

test("communications log lists AI actions with transcripts, scoped to the hospital", async () => {
  const id = await mk(); await call(id, "acknowledged");
  const mine = (await request(app).get("/api/communications").set(H(T.clinA))).body.events;
  assert.ok(mine.length >= 3 && mine.every((e) => e.simulated)); assert.ok(mine.some((e) => Array.isArray(e.transcript)));
  assert.equal(mine[0].patient_name, "Ramesh Kumar");
  assert.deepEqual((await request(app).get("/api/communications").set(H(T.clinB))).body.events, []);
});

// ------------------------------------------------------------------ analytics
const C = (o) => ({ id: Math.random().toString(36).slice(2), status: "patient_contacted", data_origin: "live", department_id: DEPT, screening_date: "2026-11-01", ...o });
test("analytics: rates, averages, funnel and reasons are computed from real timestamps (no NaN on empty data)", () => {
  const cases = [
    C({ first_contact_at: "2026-11-03T09:00:00Z", acknowledged_at: "2026-11-03T10:00:00Z", consult_booked_at: "2026-11-04T09:00:00Z", consult_completed_at: "2026-11-09T09:00:00Z", released_at: "x", status: "closed", closure_reason: "completed_care" }),
    C({ first_contact_at: "2026-11-05T09:00:00Z", released_at: "x", follow_up_due: "2026-11-02", status: "unreachable" }),
    C({ status: "pending_clinical_release", follow_up_due: "2026-11-01" }),
    C({ first_contact_at: "2026-11-02T09:00:00Z", released_at: "x", status: "closed", closure_reason: "patient_declined_documented" }),
  ];
  const refs = [{ status: "completed", accepted_at: "x", missed_count: 1 }, { status: "rejected", rejection_reason_code: "capacity", missed_count: 0 }, { status: "requested", delay_reason_code: "transport", missed_count: 2 }];
  const a = computeAnalytics({ cases, referrals: refs, escalations: [{ status: "reviewed", raised_at: "2026-11-02T00:00:00Z", reviewed_at: "2026-11-02T12:00:00Z" }, { status: "open", raised_at: "2026-11-03T00:00:00Z" }], departments: [{ id: DEPT, name: "Endocrinology" }], now: Date.parse("2026-11-16T00:00:00Z") });
  assert.deepEqual([a.totals.cases, a.totals.active, a.totals.closed, a.totals.overdue], [4, 2, 2, 2]);
  assert.deepEqual([a.contact.contacted, a.contact.contacted_rate, a.contact.acknowledged, a.contact.acknowledgement_rate], [3, 75, 1, 33.3]);
  assert.equal(a.times.avg_days_to_notification, 2.7);      // (2 + 4 + 1) / 3 days after the screening date, rounded
  assert.equal(a.times.avg_days_to_consultation, 8.4);
  assert.deepEqual([a.referrals.total, a.referrals.completed, a.referrals.rejected, a.referrals.missed_appointments, a.referrals.completion_rate], [3, 1, 1, 3, 33.3]);
  assert.deepEqual([a.closure.closed, a.closure.closed_completed_care], [2, 1]);
  assert.deepEqual([a.escalations.open, a.escalations.avg_hours_to_review], [1, 12]);
  assert.deepEqual(a.funnel.map((f) => f.count), [4, 3, 3, 1, 1, 1, 2]);
  const keys = a.reasons.map((r) => r.group + ":" + r.key);
  for (const k of ["Delay:transport", "Rejection:capacity", "Drop-off:patient_declined_documented", "Drop-off:unreachable"]) assert.ok(keys.includes(k), k);
  assert.equal(a.by_department[0].department, "Endocrinology");
  const empty = computeAnalytics({ cases: [], referrals: [], escalations: [], departments: [] });
  assert.ok(JSON.stringify(empty).indexOf("NaN") < 0 && empty.times.avg_days_to_notification === null && empty.contact.contacted_rate === null);
});

test("analytics API: permission, filters, labels simulated vs live, tenant isolation", async () => {
  const a1 = await mk(); await call(a1, "acknowledged");
  fake.table("cl_cases").push({ id: "sim1", business_id: A, case_ref: "CL-SIM1", patient_id: "p", screening_type: "x", screening_date: "2026-01-01", status: "closed", closure_reason: "completed_care", data_origin: "simulated", department_id: null, owner_id: U.coordA });
  const get = (qs, tok = T.adminA) => request(app).get(`/api/analytics${qs}`).set(H(tok));
  assert.equal((await get("", T.coordA)).status, 403, "coordinators cannot see analytics");
  assert.equal((await get("", T.clinA)).status, 200);
  const all = (await get("")).body; assert.equal(all.totals.cases, 2); assert.deepEqual(all.origin, { live: 1, simulated: 1 });
  assert.equal((await get("?data_origin=simulated")).body.totals.cases, 1);
  assert.equal((await get("?data_origin=live")).body.totals.cases, 1);
  assert.equal((await get("?from=2026-06-01&to=2099-01-01")).body.totals.cases, 1, "date range");
  assert.equal((await get(`?department_id=${DEPT}`)).body.totals.cases, 1);
  assert.equal((await get("", T.clinB)).body.totals.cases, 0);
  assert.equal((await request(app).get("/api/analytics")).status, 401);
});
