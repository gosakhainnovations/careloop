const express = require("express");
const db = require("../config/db");
const { authenticate, requirePerm } = require("../middleware/auth");
const { staffNameMap } = require("../lib/caseService");

const router = express.Router();
router.use(authenticate);

// Escalation register: who raised it, why, who reviews it, and the documented review.
router.get("/", requirePerm("case.view"), async (req, res) => {
  const biz = req.user.businessId;
  let q = db.from("cl_escalations").select("*").eq("business_id", biz).order("raised_at", { ascending: false }).limit(500);
  if (req.query.status === "open" || req.query.status === "reviewed") q = q.eq("status", req.query.status);
  const { data: rows } = await q;
  const list = rows || [];
  const ids = [...new Set(list.map((e) => e.case_id))];
  const { data: cases } = ids.length ? await db.from("cl_cases").select("id, case_ref, patient_id, urgency, status, data_origin").eq("business_id", biz).in("id", ids) : { data: [] };
  const cById = Object.fromEntries((cases || []).map((c) => [c.id, c]));
  const pIds = [...new Set((cases || []).map((c) => c.patient_id))];
  const { data: pats } = pIds.length ? await db.from("cl_patients").select("id, full_name").eq("business_id", biz).in("id", pIds) : { data: [] };
  const pById = Object.fromEntries((pats || []).map((p) => [p.id, p.full_name]));
  const names = await staffNameMap(biz);
  const now = Date.now();
  res.json({
    escalations: list.map((e) => {
      const c = cById[e.case_id] || {};
      return {
        ...e, case_ref: c.case_ref, urgency: c.urgency, case_status: c.status, data_origin: e.data_origin || c.data_origin,
        patient_name: pById[c.patient_id] || "Unknown", assigned_name: names[e.assigned_to] || null, reviewed_by_name: names[e.reviewed_by] || null,
        raised_by_name: e.raised_by_name, hours_open: e.status === "open" ? Math.floor((now - Date.parse(e.raised_at)) / 3600000) : null,
      };
    }),
  });
});

module.exports = router;
