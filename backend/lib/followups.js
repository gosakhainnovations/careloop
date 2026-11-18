// Follow-up engine. Two clearly separate things:
//  - REMINDERS: automated, only notify the accountable staff member. They never change a case.
//  - ESCALATIONS: move the case to "escalated". Automatic only when a CLINICIAN has authorised that
//    specific rule (escalation_authorised_by); otherwise a human escalates by hand.
const db = require("../config/db");
const sm = require("./stateMachine");
const { transitionCase, SYSTEM_ACTOR, nameOf } = require("./caseService");
const { permsFor } = require("./permissions");

const DAY = 86400000;
const RULES = {
  no_acknowledgement: { label: "Patient has not acknowledged", days: 2, help: "Patient contacted but no acknowledgement recorded." },
  no_booking: { label: "No consultation booked", days: 3, help: "Patient acknowledged but no consultation booked." },
  missed_appointment: { label: "Appointment passed without attendance", days: 0, help: "Appointment time has passed and attendance is not recorded." },
  referral_pending: { label: "Referral pending", days: 2, help: "Referral not accepted or not scheduled." },
  overdue_followup: { label: "Follow-up overdue", days: 0, help: "The case's follow-up deadline has passed." },
  awaiting_clinician: { label: "Awaiting clinician decision", days: 2, help: "Waiting for clinical release or closure review." },
};
const RULE_KEYS = Object.keys(RULES);
const ESCALATABLE = (status) => !!(sm.TRANSITIONS[status] || {}).escalated;

const daysSince = (iso, now) => (now - Date.parse(iso)) / DAY;

// Pure: which (case, rule) pairs are currently failing, and for how long.
function findHits({ cases, referrals, now = Date.now() }) {
  const hits = [];
  const refByCase = {};
  referrals.forEach((r) => { (refByCase[r.case_id] = refByCase[r.case_id] || []).push(r); });
  const today = new Date(now).toISOString().slice(0, 10);
  for (const c of cases) {
    if (c.status === "closed" || c.status === "escalated") continue;
    const add = (rule, days, detail) => hits.push({ case_id: c.id, rule_key: rule, days: Math.max(0, days), detail });
    if (c.status === "patient_contacted") add("no_acknowledgement", daysSince(c.status_changed_at, now), "Patient was contacted but has not acknowledged.");
    if (c.status === "acknowledged") add("no_booking", daysSince(c.acknowledged_at || c.status_changed_at, now), "Patient acknowledged but no consultation is booked.");
    if (["pending_clinical_release", "pending_closure_review"].includes(c.status)) add("awaiting_clinician", daysSince(c.status_changed_at, now), c.status === "pending_clinical_release" ? "Waiting for a clinician to release the result." : "Waiting for a clinician to review closure.");
    if (c.follow_up_due && c.follow_up_due < today) add("overdue_followup", (now - Date.parse(c.follow_up_due)) / DAY, "The follow-up deadline has passed.");
    for (const r of refByCase[c.id] || []) {
      if (r.status === "scheduled" && r.scheduled_for && Date.parse(r.scheduled_for) < now) add("missed_appointment", (now - Date.parse(r.scheduled_for)) / DAY, "The appointment time passed and attendance is not recorded.");
      if (r.status === "requested") add("referral_pending", daysSince(r.requested_at, now), "The referral has not been accepted.");
      if (r.status === "accepted") add("referral_pending", daysSince(r.accepted_at || r.requested_at, now), "The referral is accepted but no appointment is scheduled.");
    }
  }
  return hits;
}

function effectiveRules(overrides) {
  const by = Object.fromEntries((overrides || []).map((o) => [o.rule_key, o]));
  return RULE_KEYS.map((k) => {
    const o = by[k] || {};
    return {
      rule_key: k, label: RULES[k].label, help: RULES[k].help, enabled: o.enabled !== false,
      reminder_after_days: o.reminder_after_days ?? RULES[k].days,
      escalate_enabled: !!o.escalate_enabled, escalate_after_days: o.escalate_after_days ?? null,
      escalation_authorised_by: o.escalation_authorised_by || null, escalation_authorised_at: o.escalation_authorised_at || null,
      customised: !!by[k],
    };
  });
}

async function notify(businessId, userIds, task, kind, title, body) {
  for (const uid of [...new Set(userIds.filter(Boolean))]) {
    await db.from("cl_notifications").insert({ business_id: businessId, user_id: uid, case_id: task.case_id, task_id: task.id, kind, title, body });
  }
}

async function runFollowUps(businessId, now = Date.now()) {
  const out = { created: 0, resolved: 0, escalated: 0 };
  const { data: cases } = await db.from("cl_cases").select("*").eq("business_id", businessId).limit(5000);
  const active = (cases || []).filter((c) => c.status !== "closed");
  const { data: refs } = await db.from("cl_referrals").select("*").eq("business_id", businessId).in("status", ["requested", "accepted", "scheduled"]);
  const { data: ov } = await db.from("cl_followup_rules").select("*").eq("business_id", businessId);
  const rules = Object.fromEntries(effectiveRules(ov).map((r) => [r.rule_key, r]));
  const { data: openTasks } = await db.from("cl_followup_tasks").select("*").eq("business_id", businessId).eq("status", "open");
  const { data: users } = await db.from("business_users").select("id, email, role").eq("business_id", businessId);
  const clinicians = (users || []).filter((u) => permsFor(u.role).includes("case.review")).map((u) => u.id);
  const nameById = Object.fromEntries((users || []).map((u) => [u.id, nameOf(u.email)]));
  const caseById = Object.fromEntries(active.map((c) => [c.id, c]));

  const live = findHits({ cases: active, referrals: refs || [], now }).filter((h) => rules[h.rule_key].enabled && h.days >= rules[h.rule_key].reminder_after_days);
  const liveKeys = new Set(live.map((h) => `${h.case_id}|${h.rule_key}`));
  const openKeys = new Set((openTasks || []).map((t) => `${t.case_id}|${t.rule_key}`));

  // Resolve tasks whose condition has cleared (the next step was taken).
  for (const t of openTasks || []) {
    if (!liveKeys.has(`${t.case_id}|${t.rule_key}`)) {
      await db.from("cl_followup_tasks").update({ status: "done", resolution: "Condition cleared", resolved_at: new Date(now).toISOString() }).eq("id", t.id).eq("business_id", businessId);
      out.resolved += 1;
    }
  }
  for (const h of live) {
    const rule = rules[h.rule_key], c = caseById[h.case_id], key = `${h.case_id}|${h.rule_key}`;
    const dayTxt = `${Math.floor(h.days)} day${Math.floor(h.days) === 1 ? "" : "s"}`;
    if (!openKeys.has(key)) {
      const { data: task, error } = await db.from("cl_followup_tasks").insert({
        business_id: businessId, case_id: c.id, rule_key: h.rule_key, kind: "reminder", status: "open", assigned_to: c.owner_id,
        message: `${rule.label}: ${h.detail} (${dayTxt}).`, data_origin: c.data_origin,
      }).select().single();
      if (error) continue; // unique index: another run created it first
      const who = h.rule_key === "awaiting_clinician" ? [c.owner_id, ...clinicians] : [c.owner_id];
      await notify(businessId, who, task, "reminder", `${c.case_ref}: ${rule.label}`, task.message);
      out.created += 1;
    }
    // Clinician-authorised automatic escalation.
    if (rule.escalate_enabled && rule.escalation_authorised_by && h.days >= rule.escalate_after_days && ESCALATABLE(c.status)) {
      const note = `Automatic escalation under the "${rule.label}" rule after ${dayTxt}. Authorised by ${nameById[rule.escalation_authorised_by] || "a clinician"}.`;
      const r = await transitionCase({ user: { businessId, userId: null, role: "system" }, actor: SYSTEM_ACTOR, caseRow: c, to: "escalated", input: { note } });
      if (r.ok) {
        const { data: t2 } = await db.from("cl_followup_tasks").update({ kind: "escalation", status: "done", resolution: "Escalated automatically (clinician-authorised rule)", resolved_at: new Date(now).toISOString() })
          .eq("case_id", c.id).eq("rule_key", h.rule_key).eq("business_id", businessId).eq("status", "open").select().maybeSingle();
        await notify(businessId, [c.owner_id, ...clinicians], t2 || { id: null, case_id: c.id }, "escalation", `${c.case_ref}: escalated for clinician review`, note);
        out.escalated += 1;
      }
    }
  }
  return out;
}

module.exports = { RULES, RULE_KEYS, findHits, effectiveRules, runFollowUps };
