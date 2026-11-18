const express = require("express");
const db = require("../config/db");
const { authenticate, requirePerm } = require("../middleware/auth");
const { clRoleFor, CL_ROLE_LABELS, PERMS } = require("../lib/permissions");
const sm = require("../lib/stateMachine");

const router = express.Router();
router.use(authenticate);

const SCREENING_TYPES = [
  "Diabetes (HbA1c / glucose)", "Hypertension (blood pressure)", "Breast cancer (mammogram)",
  "Cervical cancer", "Colorectal cancer", "Lung cancer (low-dose CT)", "Cardiovascular risk", "Other",
];
const STATUS_LABELS = {
  pending_clinical_release: "Awaiting clinical release", released: "Released for contact",
  patient_contacted: "Patient contacted", acknowledged: "Acknowledged", consult_booked: "Consultation booked",
  consult_completed: "Consultation completed", referral_completed: "Referral completed",
  pending_closure_review: "Awaiting closure review", closed: "Closed", escalated: "Escalated",
  unreachable: "Unreachable", declined: "Declined",
};
const CLOSURE_LABELS = {
  completed_care: "Care completed", patient_declined_documented: "Patient declined (documented)",
  unreachable_after_attempts: "Unreachable after attempts", transferred_elsewhere: "Transferred elsewhere",
  clinically_not_required: "Clinically not required",
};

router.get("/meta", (req, res) => {
  res.json({
    statuses: sm.STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
    urgencies: sm.URGENCIES, screening_types: SCREENING_TYPES,
    closure_reasons: sm.CLOSURE_REASONS.map((r) => ({ value: r, label: CLOSURE_LABELS[r] })),
  });
});

router.get("/departments", requirePerm("case.view"), async (req, res) => {
  const { data } = await db.from("cl_departments").select("id, name, is_active").eq("business_id", req.user.businessId).order("name", { ascending: true });
  res.json({ departments: data || [] });
});

router.post("/departments", requirePerm("department.manage"), async (req, res) => {
  const name = String((req.body || {}).name || "").trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: "Enter a department name." });
  const { data, error } = await db.from("cl_departments").insert({ business_id: req.user.businessId, name }).select("id, name, is_active").single();
  if (error) return res.status(409).json({ error: "That department already exists." });
  res.status(201).json({ department: data });
});

// Staff directory for owner pickers. Never returns password hashes.
router.get("/staff", requirePerm("case.view"), async (req, res) => {
  const { data } = await db.from("business_users").select("id, email, role").eq("business_id", req.user.businessId);
  const staff = (data || []).filter((u) => clRoleFor(u.role)).map((u) => ({
    id: u.id, email: u.email, name: u.email.split("@")[0].replace(/[._-]+/g, " "),
    role: clRoleFor(u.role), role_label: CL_ROLE_LABELS[clRoleFor(u.role)], permissions: PERMS[clRoleFor(u.role)],
  }));
  res.json({ staff });
});

router.get("/overview", requirePerm("case.view"), async (req, res) => {
  const { data: cases } = await db.from("cl_cases").select("id, case_ref, patient_id, screening_type, status, urgency, follow_up_due, status_changed_at, created_at, data_origin, owner_id").eq("business_id", req.user.businessId).limit(2000);
  const rows = cases || [];
  const today = new Date().toISOString().slice(0, 10);
  const byStatus = Object.fromEntries(sm.STATUSES.map((s) => [s, 0]));
  rows.forEach((c) => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
  const active = rows.filter((c) => c.status !== "closed");
  const overdue = active.filter((c) => c.follow_up_due && c.follow_up_due < today);
  const urgentOpen = active.filter((c) => ["urgent", "critical"].includes(c.urgency));
  const twoDaysAgo = Date.now() - 2 * 86400000;
  const stalledRelease = active.filter((c) => c.status === "pending_clinical_release" && new Date(c.created_at).getTime() < twoDaysAgo);

  const ids = [...new Set(rows.map((c) => c.patient_id))];
  const { data: patients } = ids.length ? await db.from("cl_patients").select("id, full_name").eq("business_id", req.user.businessId).in("id", ids) : { data: [] };
  const names = Object.fromEntries((patients || []).map((p) => [p.id, p.full_name]));

  const { data: refRows } = await db.from("cl_referrals").select("id, case_id, status, scheduled_for, requested_at, accepted_at").eq("business_id", req.user.businessId).limit(2000);
  const activeRefs = (refRows || []).filter((r) => ["requested", "accepted", "scheduled", "attended"].includes(r.status));
  const attention = new Map();
  const flag = (c, reason) => {
    const cur = attention.get(c.id) || { id: c.id, case_ref: c.case_ref, patient_name: names[c.patient_id] || "Unknown", status: c.status, urgency: c.urgency, data_origin: c.data_origin, reasons: [] };
    cur.reasons.push(reason); attention.set(c.id, cur);
  };
  overdue.forEach((c) => flag(c, "Follow-up overdue"));
  urgentOpen.forEach((c) => flag(c, "Urgent - human handling"));
  stalledRelease.forEach((c) => flag(c, "Waiting for clinical release over 2 days"));
  active.filter((c) => c.status === "escalated").forEach((c) => flag(c, "Escalated - needs review"));
  const caseById = Object.fromEntries(rows.map((c) => [c.id, c]));
  const nowMs = Date.now();
  activeRefs.forEach((r) => {
    const c = caseById[r.case_id]; if (!c || c.status === "closed") return;
    if (r.status === "scheduled" && r.scheduled_for && Date.parse(r.scheduled_for) < nowMs) flag(c, "Appointment date passed, attendance not recorded");
    else if (r.status === "requested" && nowMs - Date.parse(r.requested_at) > 2 * 86400000) flag(c, "Referral waiting for acceptance over 2 days");
    else if (r.status === "accepted" && nowMs - Date.parse(r.accepted_at || r.requested_at) > 3 * 86400000) flag(c, "Referral accepted but not scheduled for over 3 days");
  });

  const sev = (a) => (a.urgency === "critical" ? 0 : a.urgency === "urgent" ? 1 : a.status === "escalated" ? 2 : 3);
  res.json({
    total: rows.length, active: active.length, closed: byStatus.closed || 0,
    overdue: overdue.length, urgent_open: urgentOpen.length,
    awaiting_release: byStatus.pending_clinical_release || 0,
    referrals_open: activeRefs.length,
    by_status: byStatus,
    data_origin: { live: rows.filter((c) => c.data_origin === "live").length, simulated: rows.filter((c) => c.data_origin === "simulated").length },
    needs_attention: [...attention.values()]
      .sort((a, b) => sev(a) - sev(b) || b.reasons.length - a.reasons.length)
      .slice(0, 12),
  });
});

module.exports = router;
