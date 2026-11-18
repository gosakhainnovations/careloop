const express = require("express");
const db = require("../config/db");
const { authenticate, requirePerm } = require("../middleware/auth");
const { audit } = require("../lib/audit");
const sm = require("../lib/stateMachine");
const rm = require("../lib/referralMachine");
const { permsFor } = require("../lib/permissions");
const { addEvent, tenantUser, staffNameMap, transitionCase, SYSTEM_ACTOR, isUuid } = require("../lib/caseService");

const router = express.Router();
router.use(authenticate);

const str = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const fail = (status, message) => Object.assign(new Error(message), { status });
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong. Try again." });
  }
};
const staffActor = (req) => ({ type: "staff", id: req.user.userId, name: req.user.name, perms: req.user.perms });

async function loadCase(req, id) {
  if (!isUuid(id)) throw fail(404, "Case not found");
  const { data } = await db.from("cl_cases").select("*").eq("id", id).eq("business_id", req.user.businessId).maybeSingle();
  if (!data) throw fail(404, "Case not found");
  return data;
}

// ---- list (referral worklist) ----------------------------------------
router.get("/", requirePerm("case.view"), handle(async (req, res) => {
  const biz = req.user.businessId;
  let q = db.from("cl_referrals").select("*").eq("business_id", biz).order("requested_at", { ascending: false }).limit(500);
  if (req.query.status) q = q.eq("status", req.query.status);
  const { data: refs, error } = await q;
  if (error) throw fail(500, "Could not load referrals");
  const caseIds = [...new Set(refs.map((r) => r.case_id))];
  const { data: cases } = caseIds.length ? await db.from("cl_cases").select("id, case_ref, patient_id, status, urgency, data_origin").eq("business_id", biz).in("id", caseIds) : { data: [] };
  const cById = Object.fromEntries((cases || []).map((c) => [c.id, c]));
  const pIds = [...new Set((cases || []).map((c) => c.patient_id))];
  const { data: pats } = pIds.length ? await db.from("cl_patients").select("id, full_name").eq("business_id", biz).in("id", pIds) : { data: [] };
  const pById = Object.fromEntries((pats || []).map((p) => [p.id, p.full_name]));
  const { data: depts } = await db.from("cl_departments").select("id, name").eq("business_id", biz);
  const dById = Object.fromEntries((depts || []).map((d) => [d.id, d.name]));
  const names = await staffNameMap(biz);
  const now = Date.now();
  res.json({
    referrals: refs.map((r) => {
      const c = cById[r.case_id] || {};
      const issues = [];
      if (r.status === "scheduled" && r.scheduled_for && Date.parse(r.scheduled_for) < now) issues.push("Appointment date passed, attendance not recorded");
      if (r.status === "requested" && now - Date.parse(r.requested_at) > 2 * 86400000) issues.push("Waiting for acceptance over 2 days");
      if (r.status === "accepted" && now - Date.parse(r.accepted_at || r.requested_at) > 3 * 86400000) issues.push("Accepted but not scheduled for over 3 days");
      if (r.delay_reason_code && rm.ACTIVE.includes(r.status)) issues.push("Delay recorded");
      return {
        ...r, case_ref: c.case_ref, case_status: c.status, urgency: c.urgency, data_origin: r.data_origin || c.data_origin,
        patient_name: pById[c.patient_id] || "Unknown", department_name: dById[r.department_id] || null, assigned_name: names[r.assigned_to] || null, issues,
      };
    }),
  });
}));

// ---- create -----------------------------------------------------------
router.post("/", requirePerm("referral.create"), handle(async (req, res) => {
  const b = req.body || {};
  const c = await loadCase(req, b.case_id);
  const biz = req.user.businessId;
  if (c.status === "closed") throw fail(409, "A closed case cannot have new referrals.");
  if (c.status === "pending_clinical_release") throw fail(409, "The result must be released by a clinician before a referral is made.");
  const { data: active } = await db.from("cl_referrals").select("id").eq("case_id", c.id).eq("business_id", biz).in("status", rm.ACTIVE);
  if (active && active.length) throw fail(409, "This case already has an open referral. Complete or cancel it first.");

  if (!isUuid(b.department_id)) throw fail(400, "Choose the receiving department.");
  const { data: dept } = await db.from("cl_departments").select("id").eq("id", b.department_id).eq("business_id", biz).maybeSingle();
  if (!dept) throw fail(400, "Choose the receiving department.");
  const note = str(b.note, 500);
  if (c.department_id && c.department_id !== b.department_id && note.length < 3) {
    throw fail(400, "This differs from the department in the authorised instructions. Explain why.");
  }
  let assignee = null;
  if (b.assigned_to) {
    assignee = await tenantUser(biz, b.assigned_to);
    if (!assignee) throw fail(400, "Choose a staff member from this organisation.");
  }
  const reason = str(b.reason, 1000) || c.recommended_next_step;
  if (!reason) throw fail(400, "Record the reason for the referral.");

  const { data: ref, error } = await db.from("cl_referrals").insert({
    business_id: biz, case_id: c.id, department_id: b.department_id, assigned_to: assignee ? assignee.id : null, reason,
    status: "requested", requested_by: req.user.userId, requested_at: new Date().toISOString(), missed_count: 0,
    data_origin: c.data_origin,
  }).select().single();
  if (error) throw fail(409, "Could not create the referral. It may already have an open one.");
  await addEvent(req.user, c.id, {
    event_type: "referral_created", actor_type: "staff", actor_id: req.user.userId, actor_name: req.user.name,
    note: note || reason, metadata: { referral_id: ref.id, department_id: b.department_id },
  });
  await audit(req.user, "referral.create", "referral", ref.id, { case_id: c.id }, req.ip);
  res.status(201).json({ referral: ref });
}));

// ---- actions ----------------------------------------------------------
router.post("/:id/action", requirePerm("referral.update"), handle(async (req, res) => {
  const biz = req.user.businessId;
  if (!isUuid(req.params.id)) throw fail(404, "Referral not found");
  const { data: ref } = await db.from("cl_referrals").select("*").eq("id", req.params.id).eq("business_id", biz).maybeSingle();
  if (!ref) throw fail(404, "Referral not found");
  const c = await loadCase(req, ref.case_id);
  const b = req.body || {};
  const action = b.action;
  const input = { note: str(b.note, 1000), reason_code: b.reason_code, scheduled_for: b.scheduled_for };

  const plan = rm.planReferral(action, ref, input, req.user.perms);
  if (!plan.ok) return res.status(plan.status).json({ error: plan.error });

  // Work out and PRE-VALIDATE the effect on the case before changing anything.
  const eff = rm.caseEffect(action, c, input.note);
  if (eff.error) return res.status(eff.status).json({ error: eff.error });
  const actor = eff.actor === "system" ? SYSTEM_ACTOR : staffActor(req);
  if (eff.to) {
    const v = sm.validateTransition({ caseRow: c, to: eff.to, actor, input: { note: eff.note } });
    if (!v.ok) return res.status(v.status).json({ error: v.error });
  }

  const now = new Date().toISOString();
  const u = { updated_at: now };
  if (plan.rule.to) u.status = plan.rule.to;
  if (action === "accept") Object.assign(u, { accepted_at: now, accepted_by: req.user.userId });
  if (action === "schedule") Object.assign(u, { scheduled_for: new Date(input.scheduled_for).toISOString(), scheduled_by: req.user.userId });
  if (action === "attend") Object.assign(u, { attended_at: now, attended_note: input.note });
  if (action === "complete") Object.assign(u, { completed_at: now, completed_by: req.user.userId, outcome_note: input.note });
  if (action === "reject") Object.assign(u, { rejection_reason_code: input.reason_code, rejection_note: input.note });
  if (action === "cancel") u.cancelled_note = input.note;
  if (action === "missed") Object.assign(u, { scheduled_for: null, missed_count: (ref.missed_count || 0) + 1 });
  if (action === "delay") Object.assign(u, { delay_reason_code: input.reason_code, delay_note: input.note, delayed_at: now });

  const { data: updated, error } = await db.from("cl_referrals").update(u).eq("id", ref.id).eq("business_id", biz).eq("status", ref.status).select().maybeSingle();
  if (error) throw fail(500, "Could not update the referral.");
  if (!updated) throw fail(409, "This referral was changed by someone else. Reload and try again.");

  await addEvent(req.user, c.id, {
    event_type: `referral_${action}`, actor_type: "staff", actor_id: req.user.userId, actor_name: req.user.name,
    note: input.note || (action === "schedule" ? `Appointment set for ${new Date(input.scheduled_for).toISOString()}` : null),
    metadata: { referral_id: ref.id, reason_code: input.reason_code || null, scheduled_for: u.scheduled_for || null },
  });

  let caseResult = null;
  if (eff.to) {
    caseResult = await transitionCase({ user: req.user, actor, caseRow: c, to: eff.to, input: { note: eff.note }, ip: req.ip });
    if (!caseResult.ok) console.error("CASE TRANSITION AFTER REFERRAL FAILED:", caseResult.error);
  }
  await audit(req.user, `referral.${action}`, "referral", ref.id, { case_id: c.id }, req.ip);
  res.json({ referral: updated, case: caseResult && caseResult.ok ? caseResult.data : c, escalated: !!(eff.to === "escalated" && caseResult && caseResult.ok) });
}));

module.exports = router;
