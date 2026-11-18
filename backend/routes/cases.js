const express = require("express");
const crypto = require("crypto");
const db = require("../config/db");
const { authenticate, requirePerm } = require("../middleware/auth");
const { audit } = require("../lib/audit");
const { clRoleFor, CL_ROLE_LABELS } = require("../lib/permissions");
const sm = require("../lib/stateMachine");
const { addEvent, tenantUser, staffNameMap, transitionCase } = require("../lib/caseService");
const { runSimulatedCall } = require("../lib/callSimulation");

const router = express.Router();
router.use(authenticate);

const uid = (v) => typeof v === "string" && /^[0-9a-fA-F-]{36}$/.test(v);
const str = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const REF_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const makeRef = () => "CL-" + Array.from({ length: 6 }, () => REF_CHARS[crypto.randomInt(REF_CHARS.length)]).join("");
const actorOf = (req) => ({ type: "staff", id: req.user.userId, name: req.user.name, perms: req.user.perms });

const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong. Try again." });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });

async function getCase(req, id) {
  if (!uid(id)) throw fail(404, "Case not found");
  const { data } = await db.from("cl_cases").select("*").eq("id", id).eq("business_id", req.user.businessId).maybeSingle();
  if (!data) throw fail(404, "Case not found");
  return data;
}

// ---- list ------------------------------------------------------------
router.get("/", requirePerm("case.view"), handle(async (req, res) => {
  const { status, urgency, department_id, owner_id, data_origin, q, overdue, mine } = req.query;
  let query = db.from("cl_cases").select("*").eq("business_id", req.user.businessId).order("created_at", { ascending: false }).limit(500);
  if (status) query = query.eq("status", status);
  if (urgency) query = query.eq("urgency", urgency);
  if (department_id) query = query.eq("department_id", department_id);
  if (data_origin) query = query.eq("data_origin", data_origin);
  if (owner_id) query = query.eq("owner_id", owner_id);
  if (mine === "1") query = query.eq("owner_id", req.user.userId);
  const { data: cases, error } = await query;
  if (error) throw fail(500, "Could not load cases");

  const ids = [...new Set(cases.map((c) => c.patient_id))];
  const { data: patients } = ids.length
    ? await db.from("cl_patients").select("id, full_name, phone, preferred_language").eq("business_id", req.user.businessId).in("id", ids)
    : { data: [] };
  const byId = Object.fromEntries((patients || []).map((p) => [p.id, p]));
  const today = new Date().toISOString().slice(0, 10);

  let rows = cases.map((c) => ({
    ...c,
    patient_name: (byId[c.patient_id] || {}).full_name || "Unknown",
    is_overdue: !!c.follow_up_due && c.follow_up_due < today && c.status !== "closed",
  }));
  if (overdue === "1") rows = rows.filter((c) => c.is_overdue);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((c) => `${c.case_ref} ${c.patient_name} ${c.screening_type}`.toLowerCase().includes(needle));
  }
  res.json({ cases: rows });
}));

// ---- create ----------------------------------------------------------
router.post("/", requirePerm("case.create"), handle(async (req, res) => {
  const b = req.body || {};
  const businessId = req.user.businessId;
  const screening_type = str(b.screening_type, 120);
  const result_summary = str(b.result_summary, 2000);
  if (!screening_type || !result_summary) throw fail(400, "Screening type and result are required.");
  if (!isDate(b.screening_date) || b.screening_date > new Date().toISOString().slice(0, 10)) throw fail(400, "Enter a valid screening date that is not in the future.");
  const urgency = b.urgency || "routine";
  if (!sm.URGENCIES.includes(urgency)) throw fail(400, "Invalid urgency.");
  if (b.follow_up_due && (!isDate(b.follow_up_due) || b.follow_up_due < b.screening_date)) throw fail(400, "Follow-up deadline must be on or after the screening date.");

  const ownerId = b.owner_id || req.user.userId;
  if (!(await tenantUser(businessId, ownerId))) throw fail(400, "The case owner must be a staff member of this organisation.");

  if (b.department_id) {
    if (!uid(b.department_id)) throw fail(400, "Invalid department.");
    const { data: dept } = await db.from("cl_departments").select("id").eq("id", b.department_id).eq("business_id", businessId).maybeSingle();
    if (!dept) throw fail(400, "Invalid department.");
  }

  const dataOrigin = req.user.isDemo ? "simulated" : "live";
  let patientId = b.patient_id;
  let createdPatientId = null;
  if (patientId) {
    if (!uid(patientId)) throw fail(400, "Invalid patient.");
    const { data: p } = await db.from("cl_patients").select("id").eq("id", patientId).eq("business_id", businessId).maybeSingle();
    if (!p) throw fail(400, "Patient not found.");
  } else {
    const p = b.patient || {};
    const full_name = str(p.full_name, 200);
    if (!full_name) throw fail(400, "Patient name is required.");
    const lang = p.preferred_language === "ar" ? "ar" : "en";
    const { data: created, error } = await db.from("cl_patients").insert({
      business_id: businessId, full_name, phone: str(p.phone, 40) || null, email: str(p.email, 200) || null,
      date_of_birth: isDate(p.date_of_birth) ? p.date_of_birth : null, preferred_language: lang,
      contact_consent: p.contact_consent === true,
      consent_channels: Array.isArray(p.consent_channels) ? p.consent_channels.filter((c) => ["voice", "sms", "whatsapp", "email"].includes(c)) : [],
      consent_recorded_at: p.contact_consent === true ? new Date().toISOString() : null,
      data_origin: dataOrigin, created_by: req.user.userId,
    }).select().single();
    if (error) throw fail(500, "Could not save the patient.");
    patientId = created.id;
    createdPatientId = created.id;
  }

  const row = {
    business_id: businessId, case_ref: makeRef(), patient_id: patientId, screening_type,
    screening_date: b.screening_date, result_summary,
    clinical_interpretation: str(b.clinical_interpretation, 2000) || null,
    recommended_next_step: str(b.recommended_next_step, 1000) || null,
    department_id: b.department_id || null, owner_id: ownerId, urgency,
    ai_contact_allowed: sm.AI_ELIGIBLE_URGENCIES.includes(urgency),
    follow_up_due: b.follow_up_due || null, status: "pending_clinical_release",
    data_origin: dataOrigin, created_by: req.user.userId,
  };
  const { data: created, error } = await db.from("cl_cases").insert(row).select().single();
  if (error) {
    if (createdPatientId) await db.from("cl_patients").delete().eq("id", createdPatientId).eq("business_id", businessId);
    throw fail(500, "Could not save the case.");
  }
  await addEvent(req.user, created.id, {
    event_type: "case_registered", to_status: "pending_clinical_release", actor_type: "staff",
    actor_id: req.user.userId, actor_name: req.user.name, note: null,
    metadata: { urgency, data_origin: dataOrigin },
  });
  if (!row.ai_contact_allowed) {
    await addEvent(req.user, created.id, {
      event_type: "human_only_flag", actor_type: "system", actor_name: "CareLoop",
      note: `Urgency "${urgency}" - reserved for human handling. Automated patient contact is disabled.`, metadata: {},
    });
  }
  await audit(req.user, "case.create", "case", created.id, { case_ref: created.case_ref }, req.ip);
  res.status(201).json({ case: created });
}));

// ---- detail ----------------------------------------------------------
router.get("/:id", requirePerm("case.view"), handle(async (req, res) => {
  const c = await getCase(req, req.params.id);
  const { data: patient } = await db.from("cl_patients").select("*").eq("id", c.patient_id).eq("business_id", req.user.businessId).maybeSingle();
  const { data: events } = await db.from("cl_case_events").select("*").eq("case_id", c.id).eq("business_id", req.user.businessId).order("created_at", { ascending: true });
  let department = null;
  if (c.department_id) {
    const { data } = await db.from("cl_departments").select("id, name").eq("id", c.department_id).eq("business_id", req.user.businessId).maybeSingle();
    department = data;
  }
  const owner = c.owner_id ? await tenantUser(req.user.businessId, c.owner_id) : null;
  const today = new Date().toISOString().slice(0, 10);
  const names = await staffNameMap(req.user.businessId);
  const { data: depts } = await db.from("cl_departments").select("id, name").eq("business_id", req.user.businessId);
  const deptName = Object.fromEntries((depts || []).map((d) => [d.id, d.name]));
  const { data: refs } = await db.from("cl_referrals").select("*").eq("case_id", c.id).eq("business_id", req.user.businessId).order("requested_at", { ascending: false });
  const { data: escs } = await db.from("cl_escalations").select("*").eq("case_id", c.id).eq("business_id", req.user.businessId).order("raised_at", { ascending: false });
  await audit(req.user, "case.view", "case", c.id, {}, req.ip);
  res.json({
    case: { ...c, is_overdue: !!c.follow_up_due && c.follow_up_due < today && c.status !== "closed" },
    patient, department, events: events || [],
    referrals: (refs || []).map((r) => ({ ...r, department_name: deptName[r.department_id] || null, assigned_name: names[r.assigned_to] || null })),
    escalations: (escs || []).map((e) => ({ ...e, assigned_name: names[e.assigned_to] || null, reviewed_by_name: names[e.reviewed_by] || null })),
    owner: owner ? { id: owner.id, name: owner.email.split("@")[0].replace(/[._-]+/g, " "), role: clRoleFor(owner.role), role_label: CL_ROLE_LABELS[clRoleFor(owner.role)] } : null,
    allowed_transitions: sm.allowedTransitions(c.status, actorOf(req)),
  });
}));

// ---- update fields ---------------------------------------------------
const CLINICAL_FIELDS = ["clinical_interpretation", "recommended_next_step", "urgency"];
router.patch("/:id", requirePerm("case.update"), handle(async (req, res) => {
  const c = await getCase(req, req.params.id);
  if (c.status === "closed") throw fail(409, "A closed case cannot be edited.");
  const b = req.body || {};
  const updates = {};
  if (b.result_summary !== undefined) updates.result_summary = str(b.result_summary, 2000);
  if (b.clinical_interpretation !== undefined) updates.clinical_interpretation = str(b.clinical_interpretation, 2000) || null;
  if (b.recommended_next_step !== undefined) updates.recommended_next_step = str(b.recommended_next_step, 1000) || null;
  if (b.urgency !== undefined) {
    if (!sm.URGENCIES.includes(b.urgency)) throw fail(400, "Invalid urgency.");
    updates.urgency = b.urgency;
    updates.ai_contact_allowed = sm.AI_ELIGIBLE_URGENCIES.includes(b.urgency);
  }
  if (b.follow_up_due !== undefined) {
    if (b.follow_up_due && (!isDate(b.follow_up_due) || b.follow_up_due < c.screening_date)) throw fail(400, "Follow-up deadline must be on or after the screening date.");
    updates.follow_up_due = b.follow_up_due || null;
  }
  if (b.department_id !== undefined) {
    if (b.department_id) {
      const { data: dept } = await db.from("cl_departments").select("id").eq("id", uid(b.department_id) ? b.department_id : "").eq("business_id", req.user.businessId).maybeSingle();
      if (!dept) throw fail(400, "Invalid department.");
    }
    updates.department_id = b.department_id || null;
  }
  if (Object.keys(updates).length === 0) throw fail(400, "Nothing to update.");

  // Once a result has been released to the patient pathway, changing the clinical
  // content needs a clinician's review permission.
  const touchesClinical = Object.keys(updates).some((k) => CLINICAL_FIELDS.includes(k));
  if (touchesClinical && c.status !== "pending_clinical_release" && !req.user.perms.includes("case.review")) {
    throw fail(403, "Only a clinician can change clinical details after release.");
  }
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db.from("cl_cases").update(updates).eq("id", c.id).eq("business_id", req.user.businessId).select().single();
  if (error) throw fail(500, "Could not update the case.");
  await addEvent(req.user, c.id, {
    event_type: "case_updated", actor_type: "staff", actor_id: req.user.userId, actor_name: req.user.name,
    note: null, metadata: { fields: Object.keys(updates).filter((k) => k !== "updated_at") },
  });
  await audit(req.user, "case.update", "case", c.id, { fields: Object.keys(updates) }, req.ip);
  res.json({ case: data });
}));

// ---- transition ------------------------------------------------------
router.post("/:id/transition", handle(async (req, res) => {
  const c = await getCase(req, req.params.id);
  const b = req.body || {};
  const input = { note: str(b.note, 2000), closure_reason: b.closure_reason, closure_evidence: str(b.closure_evidence, 4000), escalate_to: b.escalate_to };
  const r = await transitionCase({ user: req.user, actor: actorOf(req), caseRow: c, to: b.to, input, ip: req.ip });
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ case: r.data });
}));

// ---- simulated AI patient call --------------------------------------
router.post("/:id/simulate-call", requirePerm("case.transition"), handle(async (req, res) => {
  const c = await getCase(req, req.params.id);
  const { data: patient } = await db.from("cl_patients").select("*").eq("id", c.patient_id).eq("business_id", req.user.businessId).maybeSingle();
  const scenario = (req.body || {}).scenario;
  const r = await runSimulatedCall({ user: req.user, caseRow: c, patient, scenario, ip: req.ip });
  await audit(req.user, "case.simulated_call", "case", c.id, { scenario }, req.ip);
  res.json(r);
}));

// ---- assign / transfer ownership ------------------------------------
router.post("/:id/assign", requirePerm("case.assign"), handle(async (req, res) => {
  const c = await getCase(req, req.params.id);
  if (c.status === "closed") throw fail(409, "A closed case cannot be reassigned.");
  const reason = str((req.body || {}).reason, 500);
  if (reason.length < 3) throw fail(400, "Give a reason for the ownership change.");
  const newOwner = await tenantUser(req.user.businessId, (req.body || {}).owner_id);
  if (!newOwner) throw fail(400, "Choose a staff member from this organisation.");
  if (newOwner.id === c.owner_id) throw fail(409, "That person already owns this case.");
  const { data, error } = await db.from("cl_cases").update({ owner_id: newOwner.id, updated_at: new Date().toISOString() }).eq("id", c.id).eq("business_id", req.user.businessId).select().single();
  if (error) throw fail(500, "Could not change the owner.");
  await addEvent(req.user, c.id, {
    event_type: "owner_changed", actor_type: "staff", actor_id: req.user.userId, actor_name: req.user.name,
    note: reason, metadata: { from_owner: c.owner_id, to_owner: newOwner.id },
  });
  await audit(req.user, "case.assign", "case", c.id, { to_owner: newOwner.id }, req.ip);
  res.json({ case: data });
}));

// ---- notes -----------------------------------------------------------
router.post("/:id/notes", requirePerm("note.add"), handle(async (req, res) => {
  const c = await getCase(req, req.params.id);
  const note = str((req.body || {}).note, 2000);
  if (note.length < 2) throw fail(400, "Write a note first.");
  await addEvent(req.user, c.id, {
    event_type: "note", actor_type: "staff", actor_id: req.user.userId, actor_name: req.user.name, note, metadata: {},
  });
  await audit(req.user, "case.note", "case", c.id, {}, req.ip);
  res.status(201).json({ ok: true });
}));

module.exports = router;
