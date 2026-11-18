// Case lifecycle rules. This is the single source of truth: routes, the future
// AI call layer and the follow-up engine must all go through validateTransition.
//
// Safety rules encoded here:
//  - Releasing a result for patient contact is a human, clinician decision.
//  - Referral completion, escalation review and closure are human-only.
//  - AI/system actors can only record contact outcomes (contacted, acknowledged,
//    unreachable) or raise an escalation; they can never close or release.
//  - A completed AI call never closes a case. Closure needs a clinician,
//    a reason and written evidence.

const STATUSES = [
  "pending_clinical_release", "released", "patient_contacted", "acknowledged",
  "consult_booked", "consult_completed", "referral_completed",
  "pending_closure_review", "closed", "escalated", "unreachable", "declined",
];
const ACTIVE_STATUSES = STATUSES.filter((s) => s !== "closed");

const CLOSURE_REASONS = [
  "completed_care", "patient_declined_documented", "unreachable_after_attempts",
  "transferred_elsewhere", "clinically_not_required",
];

const URGENCIES = ["routine", "soon", "urgent", "critical"];
const AI_ELIGIBLE_URGENCIES = ["routine", "soon"];

// rule flags: perm (required permission for staff), humanOnly, auto (AI/system may do it),
// note (written note required)
const op = { perm: "case.transition", auto: true };
const opNote = { perm: "case.transition", note: true };
const esc = { perm: "case.escalate", auto: true, note: true };
const review = { perm: "case.review", humanOnly: true, note: true };

const TRANSITIONS = {
  pending_clinical_release: {
    released: { perm: "case.release", humanOnly: true },
    escalated: esc,
  },
  released: { patient_contacted: op, unreachable: { ...op, note: true }, escalated: esc },
  patient_contacted: {
    acknowledged: op, unreachable: { ...op, note: true }, declined: opNote, escalated: esc,
  },
  acknowledged: { consult_booked: opNote, declined: opNote, escalated: esc },
  consult_booked: {
    consult_completed: opNote, // evidence of the consultation is required in the note
    acknowledged: opNote,      // missed / rebooking
    declined: opNote,
    escalated: esc,
  },
  consult_completed: { referral_completed: review, pending_closure_review: opNote, escalated: esc },
  referral_completed: { pending_closure_review: opNote, escalated: esc },
  pending_closure_review: {
    closed: { perm: "case.close", humanOnly: true, note: true, closure: true },
    acknowledged: review, consult_booked: review, escalated: esc,
  },
  escalated: {
    released: review, patient_contacted: review, acknowledged: review, consult_booked: review,
    consult_completed: review, pending_closure_review: review,
  },
  unreachable: { patient_contacted: opNote, pending_closure_review: opNote, escalated: esc },
  declined: { patient_contacted: opNote, pending_closure_review: opNote, escalated: esc },
  closed: {},
};

// Which timestamp column a transition stamps.
const STAMPS = {
  released: "released_at",
  acknowledged: "acknowledged_at",
  consult_booked: "consult_booked_at",
  consult_completed: "consult_completed_at",
  closed: "closed_at",
};

const hasPerm = (perms, p) => Array.isArray(perms) && perms.includes(p);

function ruleFor(from, to) {
  return (TRANSITIONS[from] || {})[to] || null;
}

function actorMayUse(rule, actor) {
  if (actor.type === "staff") return hasPerm(actor.perms, rule.perm);
  return !!rule.auto && !rule.humanOnly; // ai / system
}

// Transitions this actor may attempt from the case's current status (for the UI).
function allowedTransitions(from, actor) {
  return Object.entries(TRANSITIONS[from] || {})
    .filter(([, rule]) => actorMayUse(rule, actor))
    .map(([to, rule]) => ({ to, requires_note: !!rule.note, is_closure: !!rule.closure }));
}

// Returns { ok: true } or { ok: false, status, error }.
function validateTransition({ caseRow, to, actor, input = {} }) {
  const from = caseRow.status;
  const rule = ruleFor(from, to);
  if (!rule) {
    return { ok: false, status: 409, error: `A case that is "${from}" cannot move to "${to}".` };
  }
  if (!actorMayUse(rule, actor)) {
    return {
      ok: false,
      status: actor.type === "staff" ? 403 : 409,
      error: actor.type === "staff"
        ? "You do not have permission to make this change."
        : "This change must be made by authorised staff, not by automation.",
    };
  }
  if (actor.type !== "staff" && to !== "escalated" && caseRow.ai_contact_allowed === false) {
    return { ok: false, status: 409, error: "This case is reserved for human handling." };
  }

  const note = (input.note || "").trim();
  if (rule.note && note.length < 3) {
    return { ok: false, status: 400, error: "A written note is required for this change." };
  }

  if (to === "released") {
    if (!(caseRow.clinical_interpretation || "").trim() || !(caseRow.recommended_next_step || "").trim()) {
      return { ok: false, status: 409, error: "Record the authorised clinical interpretation and recommended next step before release." };
    }
    if (!caseRow.owner_id) {
      return { ok: false, status: 409, error: "Assign an accountable owner before release." };
    }
  }

  if (rule.closure) {
    if (!CLOSURE_REASONS.includes(input.closure_reason)) {
      return { ok: false, status: 400, error: "Choose a closure reason." };
    }
    if ((input.closure_evidence || "").trim().length < 10) {
      return { ok: false, status: 400, error: "Describe the evidence supporting closure (at least 10 characters)." };
    }
    if (input.closure_reason === "completed_care" && !caseRow.consult_completed_at) {
      return { ok: false, status: 409, error: "Care cannot be closed as completed until a consultation has been recorded as completed." };
    }
  }
  return { ok: true, rule };
}

// Column updates produced by a valid transition.
function transitionUpdates({ caseRow, to, input = {}, actor, now = new Date().toISOString() }) {
  const u = { status: to, status_changed_at: now, updated_at: now };
  if (STAMPS[to]) u[STAMPS[to]] = now;
  if (to === "patient_contacted" && !caseRow.first_contact_at) u.first_contact_at = now;
  if (to === "closed") {
    u.closure_reason = input.closure_reason;
    u.closure_evidence = input.closure_evidence.trim();
    u.closed_by = actor.id;
  }
  return u;
}

module.exports = {
  STATUSES, ACTIVE_STATUSES, CLOSURE_REASONS, URGENCIES, AI_ELIGIBLE_URGENCIES,
  TRANSITIONS, allowedTransitions, validateTransition, transitionUpdates,
};
