const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, createApp, tokens, tokenFor, baseSeed, A, B, U } = require("./helpers/setup");
const request = require("supertest");

const app = createApp();
const T = tokens();
const H = (t) => ({ Authorization: `Bearer ${t}` });
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const validCase = (over = {}) => ({
  patient: { full_name: "Test Patient", phone: "+000", date_of_birth: "1980-01-01", preferred_language: "en", contact_consent: true, consent_channels: ["voice", "sms", "pigeon"] },
  screening_type: "Diabetes (HbA1c / glucose)", screening_date: daysAgo(3),
  result_summary: "HbA1c 7.4%", clinical_interpretation: "Above threshold; confirmatory testing recommended.",
  recommended_next_step: "Endocrinology consultation within 14 days", urgency: "soon", follow_up_due: daysAgo(-10), ...over,
});
const create = (tok, body = validCase()) => request(app).post("/api/cases").set(H(tok)).send(body);
const act = (tok, id, to, extra = {}) => request(app).post(`/api/cases/${id}/transition`).set(H(tok)).send({ to, ...extra });
const status = (id) => fake.table("cl_cases").find((c) => c.id === id).status;

test.beforeEach(() => fake.reset(baseSeed()));

test("registering a case: tenant and origin come from the token, not the body", async () => {
  const res = await create(T.coordA, { ...validCase(), business_id: B, data_origin: "simulated", owner_id: undefined });
  assert.equal(res.status, 201);
  const c = res.body.case;
  assert.equal(c.business_id, A);
  assert.equal(c.data_origin, "live");
  assert.equal(c.status, "pending_clinical_release");
  assert.equal(c.owner_id, U.coordA, "creator is the accountable owner by default");
  assert.match(c.case_ref, /^CL-[A-Z0-9]{6}$/);
  assert.equal(fake.table("cl_patients")[0].business_id, A);
  assert.deepEqual(fake.table("cl_patients")[0].consent_channels, ["voice", "sms"], "unknown consent channels are dropped");
  assert.equal(fake.table("cl_case_events").filter((e) => e.event_type === "case_registered").length, 1);
});

test("a demo tenant's cases are always labelled simulated", async () => {
  fake.table("businesses").find((b) => b.id === A).is_demo = true;
  const demoTok = tokenFor(U.coordA, "receptionist", A, { isDemo: true });
  const res = await create(demoTok);
  assert.equal(res.body.case.data_origin, "simulated");
  assert.equal(fake.table("cl_patients")[0].data_origin, "simulated");
});

test("validation: bad inputs are rejected and nothing is stored", async () => {
  const bad = [
    validCase({ screening_type: "" }), validCase({ result_summary: "" }),
    validCase({ screening_date: "2999-01-01" }), validCase({ screening_date: "yesterday" }),
    validCase({ urgency: "whenever" }), validCase({ follow_up_due: daysAgo(30) }),
    validCase({ patient: { full_name: "" } }), validCase({ owner_id: U.coordB }),
    validCase({ department_id: "not-a-uuid" }),
  ];
  for (const b of bad) assert.equal((await create(T.coordA, b)).status, 400, JSON.stringify(b).slice(0, 60));
  assert.equal(fake.table("cl_cases").length, 0);
  assert.equal(fake.table("cl_patients").length, 0, "no orphaned patient records");
});

test("cross-tenant references are refused (department, patient, owner)", async () => {
  fake.table("cl_departments").push({ id: "d1111111-0000-4000-8000-000000000001", business_id: B, name: "Other hospital dept" });
  assert.equal((await create(T.coordA, validCase({ department_id: "d1111111-0000-4000-8000-000000000001" }))).status, 400);
  fake.table("cl_patients").push({ id: "a2222222-0000-4000-8000-000000000002", business_id: B, full_name: "B patient" });
  const { patient, ...rest } = validCase();
  assert.equal((await create(T.coordA, { ...rest, patient_id: "a2222222-0000-4000-8000-000000000002" })).status, 400);
  assert.equal((await create(T.coordA, validCase({ owner_id: U.clinB }))).status, 400);
});

test("urgent cases are flagged human-only and AI contact is disabled", async () => {
  const res = await create(T.coordA, validCase({ urgency: "critical" }));
  assert.equal(res.body.case.ai_contact_allowed, false);
  assert.ok(fake.table("cl_case_events").some((e) => e.event_type === "human_only_flag"));
});

test("tenant isolation: tenant B cannot see or touch tenant A's case", async () => {
  const id = (await create(T.coordA)).body.case.id;
  assert.equal((await request(app).get(`/api/cases/${id}`).set(H(T.coordB))).status, 404);
  assert.equal((await request(app).patch(`/api/cases/${id}`).set(H(T.coordB)).send({ urgency: "routine" })).status, 404);
  assert.equal((await act(T.clinB, id, "released")).status, 404);
  assert.equal((await request(app).post(`/api/cases/${id}/notes`).set(H(T.coordB)).send({ note: "hello" })).status, 404);
  assert.equal((await request(app).post(`/api/cases/${id}/assign`).set(H(T.clinB)).send({ owner_id: U.clinB, reason: "take it" })).status, 404);
  const list = await request(app).get("/api/cases").set(H(T.coordB));
  assert.deepEqual(list.body.cases, []);
  const ov = await request(app).get("/api/overview").set(H(T.coordB));
  assert.equal(ov.body.total, 0);
  assert.equal(status(id), "pending_clinical_release");
  // query-string tricks do nothing
  const sneaky = await request(app).get(`/api/cases?business_id=${A}`).set(H(T.coordB));
  assert.deepEqual(sneaky.body.cases, []);
});

test("roles: coordinators cannot release or close; clinicians can; admins cannot make clinical decisions", async () => {
  const id = (await create(T.coordA)).body.case.id;
  assert.equal((await act(T.coordA, id, "released")).status, 403);
  assert.equal((await act(T.adminA, id, "released")).status, 403);
  assert.equal((await act(T.clinA, id, "released")).status, 200);
  assert.equal(status(id), "released");
});

test("release is blocked until the clinical interpretation has been recorded", async () => {
  const id = (await create(T.coordA, validCase({ clinical_interpretation: "" }))).body.case.id;
  const res = await act(T.clinA, id, "released");
  assert.equal(res.status, 409);
  assert.match(res.body.error, /interpretation/i);
});

test("full diabetes journey: register -> release -> contact -> acknowledge -> book -> consult -> review -> clinician closes", async () => {
  const id = (await create(T.coordA)).body.case.id;
  const steps = [
    [T.clinA, "released", {}], [T.coordA, "patient_contacted", {}], [T.coordA, "acknowledged", {}],
    [T.coordA, "consult_booked", { note: "Endocrinology slot booked" }],
    [T.coordA, "consult_completed", { note: "Attended consultation; confirmatory HbA1c 7.9%" }],
    [T.clinA, "referral_completed", { note: "Referral accepted and completed" }],
    [T.coordA, "pending_closure_review", { note: "All evidence on file" }],
  ];
  for (const [tok, to, extra] of steps) {
    const r = await act(tok, id, to, extra);
    assert.equal(r.status, 200, `${to}: ${r.body.error}`);
  }
  // closure attempts that must fail
  assert.equal((await act(T.coordA, id, "closed", { note: "x", closure_reason: "completed_care", closure_evidence: "Consultation attended, plan documented" })).status, 403);
  assert.equal((await act(T.clinA, id, "closed", { note: "closing", closure_reason: "completed_care", closure_evidence: "short" })).status, 400);
  assert.equal(status(id), "pending_closure_review");
  const done = await act(T.clinA, id, "closed", { note: "Reviewed by clinician", closure_reason: "completed_care", closure_evidence: "Consultation attended 2026-11-09, treatment plan documented" });
  assert.equal(done.status, 200);
  const c = fake.table("cl_cases")[0];
  assert.equal(c.status, "closed");
  assert.equal(c.closed_by, U.clinA);
  assert.ok(c.closed_at && c.first_contact_at && c.consult_completed_at && c.released_at);
  // closed is final
  assert.equal((await act(T.clinA, id, "acknowledged", { note: "reopen" })).status, 409);
  assert.equal((await request(app).patch(`/api/cases/${id}`).set(H(T.clinA)).send({ urgency: "routine" })).status, 409);
  // timeline is complete, ordered and attributed
  const detail = await request(app).get(`/api/cases/${id}`).set(H(T.clinA));
  const types = detail.body.events.map((e) => e.to_status || e.event_type);
  assert.deepEqual(types, ["pending_clinical_release", "released", "patient_contacted", "acknowledged", "consult_booked", "consult_completed", "referral_completed", "pending_closure_review", "closed"]);
  assert.ok(detail.body.events.every((e) => e.actor_type === "staff" && e.actor_name));
  // audit trail covers the sensitive actions
  const actions = fake.table("cl_audit_log").map((a) => a.action);
  for (const a of ["case.create", "case.transition", "case.close", "case.view"]) assert.ok(actions.includes(a), `audit has ${a}`);
});

test("completed care cannot be closed unless a consultation was recorded", async () => {
  const id = (await create(T.coordA)).body.case.id;
  fake.table("cl_cases")[0].status = "pending_closure_review";
  const r = await act(T.clinA, id, "closed", { note: "Closing after call", closure_reason: "completed_care", closure_evidence: "Phone call completed by AI assistant" });
  assert.equal(r.status, 409);
  assert.equal(status(id), "pending_closure_review");
});

test("illegal jumps are rejected and leave the case unchanged", async () => {
  const id = (await create(T.coordA)).body.case.id;
  for (const to of ["closed", "consult_booked", "acknowledged", "bogus"]) assert.equal((await act(T.clinA, id, to, { note: "x", closure_reason: "completed_care", closure_evidence: "long enough evidence" })).status, 409, to);
  assert.equal(status(id), "pending_clinical_release");
});

test("moves that need a note are refused without one", async () => {
  const id = (await create(T.coordA)).body.case.id;
  assert.equal((await act(T.coordA, id, "escalated")).status, 400);
  assert.equal((await act(T.coordA, id, "escalated", { note: "Patient reported severe symptoms on the phone" })).status, 200);
});

test("ownership: only assigners can transfer; owner must be in the tenant; reason required; history kept", async () => {
  const id = (await create(T.coordA)).body.case.id;
  const url = `/api/cases/${id}/assign`;
  assert.equal((await request(app).post(url).set(H(T.coordA)).send({ owner_id: U.clinA, reason: "clinical case" })).status, 403);
  assert.equal((await request(app).post(url).set(H(T.clinA)).send({ owner_id: U.clinB, reason: "wrong tenant" })).status, 400);
  assert.equal((await request(app).post(url).set(H(T.clinA)).send({ owner_id: U.clinA })).status, 400);
  assert.equal((await request(app).post(url).set(H(T.clinA)).send({ owner_id: U.coordA, reason: "no change" })).status, 409);
  const ok = await request(app).post(url).set(H(T.adminA)).send({ owner_id: U.clinA, reason: "Needs clinician ownership" });
  assert.equal(ok.status, 200);
  assert.equal(fake.table("cl_cases")[0].owner_id, U.clinA);
  const ev = fake.table("cl_case_events").find((e) => e.event_type === "owner_changed");
  assert.deepEqual([ev.metadata.from_owner, ev.metadata.to_owner], [U.coordA, U.clinA]);
});

test("clinical fields are editable before release, but only by a clinician afterwards", async () => {
  const id = (await create(T.coordA)).body.case.id;
  const patch = (tok, body) => request(app).patch(`/api/cases/${id}`).set(H(tok)).send(body);
  assert.equal((await patch(T.coordA, { clinical_interpretation: "Corrected wording" })).status, 200);
  await act(T.clinA, id, "released");
  assert.equal((await patch(T.coordA, { clinical_interpretation: "Changed after release" })).status, 403);
  assert.equal((await patch(T.clinA, { clinical_interpretation: "Clinician amendment" })).status, 200);
  assert.equal((await patch(T.coordA, { follow_up_due: daysAgo(-20) })).status, 200, "operational fields stay editable");
  const r = await patch(T.clinA, { urgency: "critical" });
  assert.equal(r.body.case.ai_contact_allowed, false, "raising urgency switches off automated contact");
});

test("detail view hides nothing it shouldn't and offers only permitted actions", async () => {
  const id = (await create(T.coordA)).body.case.id;
  const forCoord = await request(app).get(`/api/cases/${id}`).set(H(T.coordA));
  assert.deepEqual(forCoord.body.allowed_transitions.map((t) => t.to), ["escalated"]);
  const forClin = await request(app).get(`/api/cases/${id}`).set(H(T.clinA));
  assert.ok(forClin.body.allowed_transitions.some((t) => t.to === "released"));
  assert.equal(forClin.body.patient.full_name, "Test Patient");
  assert.equal(forClin.body.owner.role_label, "Care coordinator");
  assert.equal((await request(app).get("/api/cases/not-a-uuid").set(H(T.clinA))).status, 404);
});

test("list: filters, search and overdue flag", async () => {
  await create(T.coordA, validCase({ follow_up_due: null }));
  const overdueId = (await create(T.coordA, validCase({ screening_type: "Hypertension (blood pressure)", screening_date: daysAgo(30), follow_up_due: daysAgo(5) }))).body.case.id;
  const all = await request(app).get("/api/cases").set(H(T.coordA));
  assert.equal(all.body.cases.length, 2);
  const od = await request(app).get("/api/cases?overdue=1").set(H(T.coordA));
  assert.deepEqual(od.body.cases.map((c) => c.id), [overdueId]);
  assert.equal((await request(app).get("/api/cases?q=hypertension").set(H(T.coordA))).body.cases.length, 1);
  assert.equal((await request(app).get("/api/cases?status=closed").set(H(T.coordA))).body.cases.length, 0);
  assert.equal((await request(app).get("/api/cases?mine=1").set(H(T.clinA))).body.cases.length, 0);
});

test("overview: counts, needs-attention reasons, and live vs simulated split", async () => {
  await create(T.coordA, validCase({ urgency: "critical" }));
  await create(T.coordA, validCase({ follow_up_due: daysAgo(3), screening_date: daysAgo(20) }));
  const ov = (await request(app).get("/api/overview").set(H(T.coordA))).body;
  assert.equal(ov.total, 2); assert.equal(ov.active, 2); assert.equal(ov.overdue, 1); assert.equal(ov.urgent_open, 1);
  assert.equal(ov.by_status.pending_clinical_release, 2);
  assert.deepEqual(ov.data_origin, { live: 2, simulated: 0 });
  assert.equal(ov.needs_attention[0].urgency, "critical", "most severe case is listed first");
  const reasons = ov.needs_attention.flatMap((a) => a.reasons);
  assert.ok(reasons.includes("Follow-up overdue") && reasons.includes("Urgent - human handling"));
});

test("staff directory never exposes password hashes and is tenant-scoped", async () => {
  const res = await request(app).get("/api/staff").set(H(T.coordA));
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("password") && !text.includes("SECRET-HASH"));
  assert.equal(res.body.staff.length, 3);
  assert.ok(res.body.staff.every((s) => !s.email.endsWith("@b.test")));
});

test("departments: admin can add; coordinator cannot; tenant-scoped; duplicates refused", async () => {
  assert.equal((await request(app).post("/api/departments").set(H(T.coordA)).send({ name: "Cardiology" })).status, 403);
  assert.equal((await request(app).post("/api/departments").set(H(T.adminA)).send({ name: "Cardiology" })).status, 201);
  fake.table("cl_departments").push({ id: "d9999999-0000-4000-8000-000000000009", business_id: B, name: "B only" });
  const list = await request(app).get("/api/departments").set(H(T.coordA));
  assert.deepEqual(list.body.departments.map((d) => d.name), ["Cardiology"]);
});

test("notes are appended to the timeline and need content", async () => {
  const id = (await create(T.coordA)).body.case.id;
  assert.equal((await request(app).post(`/api/cases/${id}/notes`).set(H(T.coordA)).send({ note: "" })).status, 400);
  assert.equal((await request(app).post(`/api/cases/${id}/notes`).set(H(T.coordA)).send({ note: "Patient asked for evening slots" })).status, 201);
  assert.ok(fake.table("cl_case_events").some((e) => e.event_type === "note" && e.note.includes("evening")));
});
