const test = require("node:test");
const assert = require("node:assert/strict");
const { fake, createApp, tokens, baseSeed, A, B, U } = require("./helpers/setup");
const request = require("supertest");
const { transitionCase, SYSTEM_ACTOR } = require("../lib/caseService");

const app = createApp();
const T = tokens();
const H = (t) => ({ Authorization: `Bearer ${t}` });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
test.beforeEach(() => fake.reset(baseSeed()));

async function mkCase(status = "released") {
  const r = await request(app).post("/api/cases").set(H(T.coordA)).send({
    patient: { full_name: "Esc Patient" }, screening_type: "Hypertension (blood pressure)", screening_date: daysAgo(3), result_summary: "BP 160/100",
    clinical_interpretation: "Elevated", recommended_next_step: "Review", urgency: "soon",
  });
  fake.table("cl_cases").find((c) => c.id === r.body.case.id).status = status;
  return r.body.case.id;
}
const esc = (id, tok, body) => request(app).post(`/api/cases/${id}/transition`).set(H(tok)).send({ to: "escalated", ...body });

test("escalating records who raised it, why, when, and the clinician asked to review", async () => {
  const c = await mkCase();
  const r = await esc(c, T.coordA, { note: "Patient reports chest tightness", escalate_to: U.clinA });
  assert.equal(r.status, 200);
  const e = fake.table("cl_escalations")[0];
  assert.deepEqual([e.status, e.raised_by_type, e.raised_by_id, e.assigned_to, e.raised_from_status, e.business_id], ["open", "staff", U.coordA, U.clinA, "released", A]);
  assert.ok(e.raised_at && e.reason.includes("chest"));
  const detail = (await request(app).get(`/api/cases/${c}`).set(H(T.clinA))).body;
  assert.equal(detail.escalations.length, 1);
  assert.ok(detail.escalations[0].assigned_name);
});

test("the reviewer must be a clinician of the same hospital", async () => {
  const c = await mkCase();
  assert.equal((await esc(c, T.coordA, { note: "Needs review", escalate_to: U.coordA })).status, 400, "a coordinator cannot review clinically");
  assert.equal((await esc(c, T.coordA, { note: "Needs review", escalate_to: U.clinB })).status, 400, "other hospital");
  assert.equal(fake.table("cl_escalations").length, 0);
  assert.equal(fake.table("cl_cases").find((x) => x.id === c).status, "released", "failed escalation changes nothing");
  assert.equal((await esc(c, T.coordA, { note: "Needs review" })).status, 200, "reviewer is optional");
});

test("resuming from escalation is a clinician-documented review", async () => {
  const c = await mkCase();
  await esc(c, T.coordA, { note: "Patient distressed", escalate_to: U.clinA });
  const resume = (tok, body) => request(app).post(`/api/cases/${c}/transition`).set(H(tok)).send({ to: "patient_contacted", ...body });
  assert.equal((await resume(T.coordA, { note: "I called them" })).status, 403);
  assert.equal((await resume(T.clinA, {})).status, 400, "review note required");
  assert.equal((await resume(T.clinA, { note: "Clinician phoned patient; reassured, plan unchanged" })).status, 200);
  const e = fake.table("cl_escalations")[0];
  assert.deepEqual([e.status, e.reviewed_by, e.resumed_to], ["reviewed", U.clinA, "patient_contacted"]);
  assert.match(e.review_note, /Clinician phoned/);
  assert.ok(e.reviewed_at);
});

test("the escalation register is tenant-scoped, filterable and shows how long each has been open", async () => {
  const c = await mkCase();
  await esc(c, T.coordA, { note: "Needs urgent review" });
  fake.table("cl_escalations")[0].raised_at = new Date(Date.now() - 5 * 3600000).toISOString();
  const all = (await request(app).get("/api/escalations").set(H(T.clinA))).body.escalations;
  assert.equal(all.length, 1);
  assert.equal(all[0].patient_name, "Esc Patient");
  assert.ok(all[0].hours_open >= 5);
  assert.equal((await request(app).get("/api/escalations?status=reviewed").set(H(T.clinA))).body.escalations.length, 0);
  assert.deepEqual((await request(app).get("/api/escalations").set(H(T.clinB))).body.escalations, []);
  assert.equal((await request(app).get("/api/escalations")).status, 401);
});

test("automation can raise an escalation but never release, close or resume one", async () => {
  const c = await mkCase();
  const row = () => fake.table("cl_cases").find((x) => x.id === c);
  const user = { businessId: A, userId: null, role: "system" };
  const ai = { type: "ai", id: null, name: "Sakha assistant", perms: [] };
  const raised = await transitionCase({ user, actor: ai, caseRow: row(), to: "escalated", input: { note: "Patient said they feel faint" } });
  assert.equal(raised.ok, true);
  assert.equal(fake.table("cl_escalations")[0].raised_by_type, "ai");
  const resume = await transitionCase({ user, actor: ai, caseRow: row(), to: "released", input: { note: "all fine" } });
  assert.equal(resume.ok, false, "AI cannot resolve its own escalation");
  row().status = "pending_closure_review";
  const close = await transitionCase({ user, actor: SYSTEM_ACTOR, caseRow: row(), to: "closed", input: { note: "auto", closure_reason: "completed_care", closure_evidence: "automatic closure after call" } });
  assert.equal(close.ok, false);
});
