const express = require("express");
const db = require("../config/db");
const { authenticate, requirePerm } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate);
// Log of every AI-attributed action (today: simulated calls), with the transcript where one exists.
router.get("/", requirePerm("case.view"), async (req, res) => {
  const biz = req.user.businessId;
  const { data: evs } = await db.from("cl_case_events").select("*").eq("business_id", biz).eq("actor_type", "ai").order("created_at", { ascending: false }).limit(200);
  const rows = evs || [];
  const ids = [...new Set(rows.map((e) => e.case_id))];
  const { data: cases } = ids.length ? await db.from("cl_cases").select("id, case_ref, patient_id, data_origin").eq("business_id", biz).in("id", ids) : { data: [] };
  const cById = Object.fromEntries((cases || []).map((c) => [c.id, c]));
  const pIds = [...new Set((cases || []).map((c) => c.patient_id))];
  const { data: pats } = pIds.length ? await db.from("cl_patients").select("id, full_name").eq("business_id", biz).in("id", pIds) : { data: [] };
  const pById = Object.fromEntries((pats || []).map((p) => [p.id, p.full_name]));
  res.json({ events: rows.map((e) => { const c = cById[e.case_id] || {}; return { id: e.id, case_id: e.case_id, case_ref: c.case_ref, patient_name: pById[c.patient_id] || "Unknown", event_type: e.event_type, to_status: e.to_status, note: e.note, created_at: e.created_at, simulated: !!(e.metadata && e.metadata.simulated), scenario: e.metadata && e.metadata.scenario, transcript: e.metadata && e.metadata.transcript, data_origin: c.data_origin }; }) });
});
module.exports = router;
