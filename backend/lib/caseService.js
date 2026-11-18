// Shared case operations. Every change to a case's status (from the cases routes,
// from referrals, and later from the AI call layer and the follow-up engine) goes
// through transitionCase, so the lifecycle rules can never be bypassed.
const db = require("../config/db");
const sm = require("./stateMachine");
const { audit } = require("./audit");
const { permsFor, clRoleFor } = require("./permissions");

const ACTIVE_REFERRAL = ["requested", "accepted", "scheduled", "attended"];
const nameOf = (email) => String(email || "").split("@")[0].replace(/[._-]+/g, " ");
const isUuid = (v) => typeof v === "string" && /^[0-9a-fA-F-]{36}$/.test(v);

async function addEvent(user, caseId, fields) {
  const { error } = await db.from("cl_case_events").insert({ business_id: user.businessId, case_id: caseId, ...fields });
  if (error) console.error("EVENT WRITE FAILED:", error.message);
}

// A user of this hospital who has a CareLoop role (or null).
async function tenantUser(businessId, userId) {
  if (!isUuid(userId)) return null;
  const { data } = await db.from("business_users").select("id, email, role").eq("id", userId).eq("business_id", businessId).maybeSingle();
  return data && clRoleFor(data.role) ? data : null;
}

// id -> display name for every staff member of the hospital.
async function staffNameMap(businessId) {
  const { data } = await db.from("business_users").select("id, email").eq("business_id", businessId);
  return Object.fromEntries((data || []).map((u) => [u.id, nameOf(u.email)]));
}

const SYSTEM_ACTOR = { type: "system", id: null, name: "CareLoop", perms: [] };

// actor: { type: 'staff'|'ai'|'system', id, name, perms }. Returns { ok, data } or { ok:false, status, error }.
async function transitionCase({ user, actor, caseRow, to, input = {}, ip = null }) {
  const v = sm.validateTransition({ caseRow, to, actor, input });
  if (!v.ok) return v;

  if (to === "closed") {
    const { data: open } = await db.from("cl_referrals").select("id").eq("case_id", caseRow.id).eq("business_id", user.businessId).in("status", ACTIVE_REFERRAL);
    if (open && open.length) return { ok: false, status: 409, error: "Complete or cancel the open referral before closing this case." };
  }

  // With an open referral, booking / consultation / completion must go through the referral so the
  // case and the referral can never disagree (a booked appointment is not a completed referral).
  if (["consult_booked", "consult_completed", "referral_completed"].includes(to)) {
    const { data: open } = await db.from("cl_referrals").select("status").eq("case_id", caseRow.id).eq("business_id", user.businessId).in("status", ACTIVE_REFERRAL);
    const st = open && open[0] && open[0].status;
    if (st) {
      if (to === "consult_booked" && ["requested", "accepted"].includes(st)) return { ok: false, status: 409, error: "This case has an open referral. Schedule the appointment on the referral so both stay in step." };
      if (to === "consult_completed" && ["requested", "accepted", "scheduled"].includes(st)) return { ok: false, status: 409, error: "This case has an open referral. Record attendance on the referral so both stay in step." };
      if (to === "referral_completed") return { ok: false, status: 409, error: "This case has an open referral. Complete the referral record instead." };
    }
  }

  let reviewer = null;
  if (to === "escalated" && input.escalate_to) {
    const u = await tenantUser(user.businessId, input.escalate_to);
    if (!u || !permsFor(u.role).includes("case.review")) {
      return { ok: false, status: 400, error: "Choose a clinician from this organisation to review the escalation." };
    }
    reviewer = u;
  }

  const updates = sm.transitionUpdates({ caseRow, to, input, actor });
  // Compare-and-set on the current status so two people cannot apply conflicting moves.
  const { data, error } = await db.from("cl_cases").update(updates).eq("id", caseRow.id).eq("business_id", user.businessId).eq("status", caseRow.status).select().maybeSingle();
  if (error) return { ok: false, status: 500, error: "Could not update the case." };
  if (!data) return { ok: false, status: 409, error: "This case was changed by someone else. Reload and try again." };

  const note = (input.note || "").trim() || null;
  await addEvent(user, caseRow.id, {
    event_type: to === "closed" ? "case_closed" : "status_changed", from_status: caseRow.status, to_status: to,
    actor_type: actor.type, actor_id: actor.type === "staff" ? actor.id : null, actor_name: actor.name, note,
    metadata: { ...(to === "closed" ? { closure_reason: input.closure_reason } : {}), ...(input.metadata || {}) },
  });

  const now = new Date().toISOString();
  if (to === "escalated") {
    const { error: ee } = await db.from("cl_escalations").insert({
      business_id: user.businessId, case_id: caseRow.id, raised_from_status: caseRow.status, raised_by_type: actor.type,
      raised_by_id: actor.type === "staff" ? actor.id : null, raised_by_name: actor.name, reason: note || "Escalated",
      assigned_to: reviewer ? reviewer.id : null, status: "open", raised_at: now, data_origin: caseRow.data_origin,
    });
    if (ee) console.error("ESCALATION WRITE FAILED:", ee.message);
  }
  if (caseRow.status === "escalated") {
    // Resuming from an escalation is the documented clinical review.
    await db.from("cl_escalations").update({ status: "reviewed", reviewed_at: now, reviewed_by: actor.id, review_note: note, resumed_to: to })
      .eq("case_id", caseRow.id).eq("business_id", user.businessId).eq("status", "open");
  }
  await audit(user, to === "closed" ? "case.close" : "case.transition", "case", caseRow.id,
    { from: caseRow.status, to, ...(actor.type !== "staff" ? { automated: true } : {}) }, ip);
  return { ok: true, data };
}

module.exports = { addEvent, tenantUser, staffNameMap, transitionCase, nameOf, isUuid, ACTIVE_REFERRAL, SYSTEM_ACTOR };
