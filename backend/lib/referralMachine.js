// Referral lifecycle. A referral is only "completed" after the patient has actually
// been seen (attended, with written evidence) and a clinician has recorded the outcome.
// An appointment being scheduled is NOT attendance and NOT completion.
const sm = require("./stateMachine");

const ACTIVE = ["requested", "accepted", "scheduled", "attended"];
const REJECT_CODES = ["capacity", "not_clinically_appropriate", "incomplete_information", "other"];
const DELAY_CODES = ["capacity", "patient_unavailable", "awaiting_documents", "transport", "other"];

// action -> { from: allowed referral statuses, to: new status (null = no status change), note: written note required, perm }
const ACTIONS = {
  accept:   { from: ["requested"], to: "accepted" },
  schedule: { from: ["accepted"], to: "scheduled", needsTime: true },
  attend:   { from: ["scheduled"], to: "attended", note: true },
  complete: { from: ["attended"], to: "completed", note: true, perm: "case.review" },
  reject:   { from: ["requested", "accepted"], to: "rejected", note: true, codes: REJECT_CODES },
  cancel:   { from: ["requested", "accepted", "scheduled"], to: "cancelled", note: true },
  missed:   { from: ["scheduled"], to: "accepted", note: true },
  delay:    { from: ["requested", "accepted", "scheduled"], to: null, note: true, codes: DELAY_CODES },
};

// Validates the referral side of an action. Returns { ok, rule } or { ok:false, status, error }.
function planReferral(action, ref, input, perms) {
  const rule = ACTIONS[action];
  if (!rule) return { ok: false, status: 400, error: "Unknown referral action." };
  const needPerm = rule.perm || "referral.update";
  if (!perms.includes(needPerm)) return { ok: false, status: 403, error: "You do not have permission to do this." };
  if (!rule.from.includes(ref.status)) return { ok: false, status: 409, error: `A referral that is "${ref.status}" cannot be changed this way.` };
  if (rule.note && (input.note || "").trim().length < 3) return { ok: false, status: 400, error: "A written note is required." };
  if (rule.codes && !rule.codes.includes(input.reason_code)) return { ok: false, status: 400, error: "Choose a reason." };
  if (rule.needsTime) {
    const t = Date.parse(input.scheduled_for);
    if (Number.isNaN(t)) return { ok: false, status: 400, error: "Enter the appointment date and time." };
    if (t < Date.now() - 86400000) return { ok: false, status: 400, error: "The appointment time cannot be in the past." };
    if (t > Date.now() + 365 * 86400000) return { ok: false, status: 400, error: "The appointment time is too far ahead." };
  }
  return { ok: true, rule };
}

// What the referral action does to the CASE. Returns { to, actor: 'staff'|'system', note } | { error, status } | {} (no case change).
function caseEffect(action, caseRow, note) {
  const s = caseRow.status;
  if (action === "schedule") {
    if (s === "acknowledged") return { to: "consult_booked", actor: "staff", note: note || "Referral appointment scheduled." };
    if (s === "consult_booked") return {};
    return { status: 409, error: "Record the patient's acknowledgement before scheduling the appointment." };
  }
  if (action === "attend") {
    if (s === "consult_booked") return { to: "consult_completed", actor: "staff", note };
    return { status: 409, error: "The case must be at \"Consultation booked\" before attendance can be recorded." };
  }
  if (action === "complete") {
    if (s === "consult_completed") return { to: "referral_completed", actor: "staff", note };
    return { status: 409, error: "Record that the consultation took place before completing the referral." };
  }
  if (action === "missed") {
    return s === "consult_booked" ? { to: "acknowledged", actor: "staff", note } : {};
  }
  if (action === "reject") {
    // A rejected referral blocks the patient's path: raise a clinical escalation automatically.
    return sm.TRANSITIONS[s] && sm.TRANSITIONS[s].escalated ? { to: "escalated", actor: "system", note: `Referral rejected: ${note}` } : {};
  }
  return {};
}

module.exports = { ACTIVE, ACTIONS, REJECT_CODES, DELAY_CODES, planReferral, caseEffect };
