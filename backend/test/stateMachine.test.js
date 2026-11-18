const test = require("node:test");
const assert = require("node:assert/strict");
const sm = require("../lib/stateMachine");
const { PERMS } = require("../lib/permissions");

const staff = (role) => ({ type: "staff", id: "u", perms: PERMS[role] });
const coord = staff("care_coordinator"), clin = staff("clinician"), admin = staff("cl_admin");
const ai = { type: "ai", id: null, perms: [] };
const base = { status: "x", owner_id: "o", ai_contact_allowed: true, clinical_interpretation: "i", recommended_next_step: "n", consult_completed_at: null };
const v = (status, to, actor, input = {}, extra = {}) => sm.validateTransition({ caseRow: { ...base, status, ...extra }, to, actor, input });

test("every transition target is a known status; closed is terminal", () => {
  for (const [from, targets] of Object.entries(sm.TRANSITIONS)) {
    assert.ok(sm.STATUSES.includes(from));
    Object.keys(targets).forEach((t) => assert.ok(sm.STATUSES.includes(t), `${from}->${t}`));
  }
  assert.deepEqual(sm.TRANSITIONS.closed, {});
  assert.equal(v("closed", "acknowledged", clin, { note: "reopen" }).ok, false);
});

test("a booked consultation is not a completed referral and cannot skip to closure", () => {
  for (const to of ["referral_completed", "pending_closure_review", "closed"]) {
    assert.equal(v("consult_booked", to, clin, { note: "x" }).ok, false, `consult_booked -> ${to}`);
  }
  assert.equal(v("acknowledged", "closed", clin, { note: "x", closure_reason: "completed_care", closure_evidence: "long enough evidence" }).ok, false);
});

test("only a clinician releases a result; coordinators and admins cannot", () => {
  assert.equal(v("pending_clinical_release", "released", clin).ok, true);
  assert.equal(v("pending_clinical_release", "released", coord).status, 403);
  assert.equal(v("pending_clinical_release", "released", admin).status, 403);
});

test("release requires authorised interpretation, next step and an owner", () => {
  assert.equal(v("pending_clinical_release", "released", clin, {}, { clinical_interpretation: "" }).ok, false);
  assert.equal(v("pending_clinical_release", "released", clin, {}, { recommended_next_step: null }).ok, false);
  assert.equal(v("pending_clinical_release", "released", clin, {}, { owner_id: null }).ok, false);
});

test("AI/system can record contact outcomes and escalate - nothing else", () => {
  assert.equal(v("released", "patient_contacted", ai).ok, true);
  assert.equal(v("patient_contacted", "acknowledged", ai).ok, true);
  assert.equal(v("released", "unreachable", ai, { note: "no answer" }).ok, true);
  assert.equal(v("released", "escalated", ai, { note: "patient reports chest pain" }).ok, true);
  for (const [from, to] of [["pending_clinical_release", "released"], ["acknowledged", "consult_booked"], ["consult_booked", "consult_completed"], ["consult_completed", "referral_completed"], ["pending_closure_review", "closed"], ["escalated", "released"]]) {
    assert.equal(v(from, to, ai, { note: "x", closure_reason: "completed_care", closure_evidence: "long enough evidence" }, { consult_completed_at: "t" }).ok, false, `AI must not ${from} -> ${to}`);
  }
});

test("a completed AI call can never close a case", () => {
  const r = v("pending_closure_review", "closed", ai, { note: "call done", closure_reason: "completed_care", closure_evidence: "AI call completed successfully" }, { consult_completed_at: "t" });
  assert.equal(r.ok, false);
});

test("urgent/critical cases are reserved for humans (AI may only escalate)", () => {
  const urgent = { ai_contact_allowed: false };
  assert.equal(v("released", "patient_contacted", ai, {}, urgent).ok, false);
  assert.equal(v("released", "escalated", ai, { note: "needs human" }, urgent).ok, true);
  assert.equal(v("released", "patient_contacted", coord, {}, urgent).ok, true, "staff can still work the case");
});

test("closure needs permission, reason, written evidence, and recorded consultation for 'completed care'", () => {
  const ok = { note: "reviewed", closure_reason: "completed_care", closure_evidence: "Consultation attended, plan documented" };
  const withConsult = { consult_completed_at: "2026-11-01T00:00:00Z" };
  assert.equal(v("pending_closure_review", "closed", clin, ok, withConsult).ok, true);
  assert.equal(v("pending_closure_review", "closed", coord, ok, withConsult).status, 403);
  assert.equal(v("pending_closure_review", "closed", admin, ok, withConsult).status, 403);
  assert.equal(v("pending_closure_review", "closed", clin, { ...ok, closure_evidence: "short" }, withConsult).ok, false);
  assert.equal(v("pending_closure_review", "closed", clin, { ...ok, closure_reason: "bogus" }, withConsult).ok, false);
  assert.equal(v("pending_closure_review", "closed", clin, { ...ok, closure_evidence: "" }, withConsult).ok, false);
  assert.equal(v("pending_closure_review", "closed", clin, ok, { consult_completed_at: null }).status, 409);
  // other reasons do not require a consultation but still need evidence
  assert.equal(v("pending_closure_review", "closed", clin, { note: "documented", closure_reason: "patient_declined_documented", closure_evidence: "Patient declined by phone on 2026-11-02" }).ok, true);
});

test("notes are mandatory where evidence matters", () => {
  for (const [from, to] of [["consult_booked", "consult_completed"], ["released", "escalated"], ["patient_contacted", "declined"], ["acknowledged", "consult_booked"]]) {
    assert.equal(v(from, to, clin, {}).ok, false, `${from}->${to} without note`);
    assert.equal(v(from, to, clin, { note: "documented reason" }).ok, true, `${from}->${to} with note`);
  }
});

test("resolving an escalation is a clinician review with a note", () => {
  assert.equal(v("escalated", "released", coord, { note: "x" }).status, 403);
  assert.equal(v("escalated", "patient_contacted", clin, {}).ok, false);
  assert.equal(v("escalated", "patient_contacted", clin, { note: "Clinician spoke to patient" }).ok, true);
});

test("transitionUpdates stamps the right timestamps", () => {
  const now = "2026-11-10T10:00:00.000Z";
  const u = sm.transitionUpdates({ caseRow: { first_contact_at: null }, to: "patient_contacted", actor: clin, now });
  assert.equal(u.first_contact_at, now);
  const again = sm.transitionUpdates({ caseRow: { first_contact_at: "earlier" }, to: "patient_contacted", actor: clin, now });
  assert.equal(again.first_contact_at, undefined, "first contact time is never overwritten");
  const c = sm.transitionUpdates({ caseRow: {}, to: "closed", actor: { id: "doc" }, input: { closure_reason: "completed_care", closure_evidence: "  evidence text  " }, now });
  assert.deepEqual([c.closed_at, c.closure_evidence, c.closed_by], [now, "evidence text", "doc"]);
});

test("allowedTransitions only offers what the actor may do", () => {
  const forCoord = sm.allowedTransitions("pending_clinical_release", coord).map((t) => t.to);
  const forClin = sm.allowedTransitions("pending_clinical_release", clin).map((t) => t.to);
  assert.deepEqual(forCoord, ["escalated"]);
  assert.deepEqual(forClin.sort(), ["escalated", "released"]);
  assert.equal(sm.allowedTransitions("pending_closure_review", coord).some((t) => t.to === "closed"), false);
  assert.equal(sm.allowedTransitions("pending_closure_review", clin).some((t) => t.is_closure), true);
});
