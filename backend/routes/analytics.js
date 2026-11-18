const express = require("express");
const db = require("../config/db");
const { authenticate, requirePerm } = require("../middleware/auth");
const { computeAnalytics } = require("../lib/analytics");

const router = express.Router();
router.use(authenticate);
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

router.get("/", requirePerm("analytics.view"), async (req, res) => {
  const biz = req.user.businessId, q = req.query;
  const { data: all } = await db.from("cl_cases").select("*").eq("business_id", biz).limit(20000);
  let cases = all || [];
  if (isDate(q.from)) cases = cases.filter((c) => c.screening_date >= q.from);
  if (isDate(q.to)) cases = cases.filter((c) => c.screening_date <= q.to);
  if (q.department_id) cases = cases.filter((c) => c.department_id === q.department_id);
  if (["live", "simulated"].includes(q.data_origin)) cases = cases.filter((c) => c.data_origin === q.data_origin);
  const ids = new Set(cases.map((c) => c.id));
  const { data: refs } = await db.from("cl_referrals").select("*").eq("business_id", biz).limit(20000);
  const { data: escs } = await db.from("cl_escalations").select("*").eq("business_id", biz).limit(20000);
  const { data: depts } = await db.from("cl_departments").select("id, name").eq("business_id", biz);
  const result = computeAnalytics({ cases, referrals: (refs || []).filter((r) => ids.has(r.case_id)), escalations: (escs || []).filter((e) => ids.has(e.case_id)), departments: depts || [] });
  res.json({ ...result, departments: depts || [], filters: { from: isDate(q.from) ? q.from : null, to: isDate(q.to) ? q.to : null, department_id: q.department_id || null, data_origin: ["live", "simulated"].includes(q.data_origin) ? q.data_origin : "all" }, generated_at: new Date().toISOString() });
});
module.exports = router;
