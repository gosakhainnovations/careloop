const express = require("express");
const db = require("../config/db");
const { authenticate, requirePerm } = require("../middleware/auth");
const { audit } = require("../lib/audit");
const { RULES, RULE_KEYS, effectiveRules, runFollowUps } = require("../lib/followups");
const { staffNameMap } = require("../lib/caseService");

const router = express.Router();
router.use(authenticate);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

router.get("/", requirePerm("case.view"), async (req, res) => {
  const biz = req.user.businessId;
  const { data: tasks } = await db.from("cl_followup_tasks").select("*").eq("business_id", biz).order("created_at", { ascending: false }).limit(300);
  const list = tasks || [];
  const ids = [...new Set(list.map((t) => t.case_id))];
  const { data: cases } = ids.length ? await db.from("cl_cases").select("id, case_ref, patient_id, status, urgency, data_origin").eq("business_id", biz).in("id", ids) : { data: [] };
  const cById = Object.fromEntries((cases || []).map((c) => [c.id, c]));
  const pIds = [...new Set((cases || []).map((c) => c.patient_id))];
  const { data: pats } = pIds.length ? await db.from("cl_patients").select("id, full_name").eq("business_id", biz).in("id", pIds) : { data: [] };
  const pById = Object.fromEntries((pats || []).map((p) => [p.id, p.full_name]));
  const names = await staffNameMap(biz);
  res.json({
    tasks: list.map((t) => { const c = cById[t.case_id] || {}; return { ...t, rule_label: (RULES[t.rule_key] || {}).label || t.rule_key, case_ref: c.case_ref, case_status: c.status, urgency: c.urgency, data_origin: t.data_origin || c.data_origin, patient_name: pById[c.patient_id] || "Unknown", assigned_name: names[t.assigned_to] || null }; }),
  });
});

router.get("/rules", requirePerm("case.view"), async (req, res) => {
  const { data } = await db.from("cl_followup_rules").select("*").eq("business_id", req.user.businessId);
  const names = await staffNameMap(req.user.businessId);
  res.json({ rules: effectiveRules(data).map((r) => ({ ...r, authorised_by_name: names[r.escalation_authorised_by] || null })), can_configure: req.user.perms.includes("followup.configure"), can_authorise_escalation: req.user.perms.includes("case.review") });
});

router.put("/rules/:key", requirePerm("followup.configure"), async (req, res) => {
  const key = req.params.key, biz = req.user.businessId;
  if (!RULE_KEYS.includes(key)) return res.status(404).json({ error: "Unknown rule." });
  const b = req.body || {};
  const { data: existing } = await db.from("cl_followup_rules").select("*").eq("business_id", biz).eq("rule_key", key).maybeSingle();
  const cur = effectiveRules(existing ? [existing] : []).find((r) => r.rule_key === key);
  const u = { updated_by: req.user.userId, updated_at: new Date().toISOString() };
  if (b.enabled !== undefined) u.enabled = !!b.enabled;
  if (b.reminder_after_days !== undefined) { const d = int(b.reminder_after_days, 0, 90); if (d === null) return res.status(400).json({ error: "Reminder days must be 0 to 90." }); u.reminder_after_days = d; }

  const touchesEscalation = b.escalate_enabled !== undefined || b.escalate_after_days !== undefined;
  if (touchesEscalation) {
    // Automatic escalation changes a clinical pathway, so only a clinician may authorise it.
    if (!req.user.perms.includes("case.review")) return res.status(403).json({ error: "Only a clinician can authorise automatic escalation." });
    const enabled = b.escalate_enabled !== undefined ? !!b.escalate_enabled : cur.escalate_enabled;
    let after = b.escalate_after_days !== undefined ? (b.escalate_after_days === null ? null : int(b.escalate_after_days, 0, 180)) : cur.escalate_after_days;
    if (enabled) {
      if (after === null) return res.status(400).json({ error: "Set the number of days after which the case is escalated (0 to 180)." });
      const remind = u.reminder_after_days ?? cur.reminder_after_days;
      if (after < remind) return res.status(400).json({ error: "Escalation must come at or after the reminder." });
      Object.assign(u, { escalate_enabled: true, escalate_after_days: after, escalation_authorised_by: req.user.userId, escalation_authorised_at: new Date().toISOString() });
    } else Object.assign(u, { escalate_enabled: false, escalate_after_days: after, escalation_authorised_by: null, escalation_authorised_at: null });
  }
  if (existing) await db.from("cl_followup_rules").update(u).eq("id", existing.id).eq("business_id", biz);
  else await db.from("cl_followup_rules").insert({ business_id: biz, rule_key: key, enabled: true, reminder_after_days: cur.reminder_after_days, escalate_enabled: false, ...u });
  await audit(req.user, "followup.rule", "rule", null, { rule_key: key, changed: Object.keys(u).filter((k) => !["updated_by", "updated_at"].includes(k)) }, req.ip);
  const { data } = await db.from("cl_followup_rules").select("*").eq("business_id", biz);
  res.json({ rules: effectiveRules(data) });
});

router.post("/run", requirePerm("followup.configure"), async (req, res) => {
  const r = await runFollowUps(req.user.businessId);
  await audit(req.user, "followup.run", "followup", null, r, req.ip);
  res.json(r);
});

// ---- my notifications ---------------------------------------------------
router.get("/notifications", async (req, res) => {
  const { data } = await db.from("cl_notifications").select("*").eq("business_id", req.user.businessId).eq("user_id", req.user.userId).order("created_at", { ascending: false }).limit(100);
  const rows = data || [];
  const ids = [...new Set(rows.map((n) => n.case_id).filter(Boolean))];
  const { data: cs } = ids.length ? await db.from("cl_cases").select("id, case_ref").eq("business_id", req.user.businessId).in("id", ids) : { data: [] };
  const ref = Object.fromEntries((cs || []).map((c) => [c.id, c.case_ref]));
  res.json({ unread: rows.filter((n) => !n.read_at).length, notifications: rows.map((n) => ({ ...n, case_ref: ref[n.case_id] || null })) });
});
router.post("/notifications/read", async (req, res) => {
  await db.from("cl_notifications").update({ read_at: new Date().toISOString() }).eq("business_id", req.user.businessId).eq("user_id", req.user.userId).is("read_at", null);
  res.json({ ok: true });
});

module.exports = router;
