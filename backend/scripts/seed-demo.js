// Creates a clearly-labelled SIMULATED demo hospital with synthetic patients only.
// Usage:  node scripts/seed-demo.js           (needs SUPABASE_URL + SUPABASE_SERVICE_KEY)
//         DEMO_PASSWORD=... node scripts/seed-demo.js   (otherwise a random password is generated)
// Safe to run twice: if the demo hospital exists it does nothing.
// All events attributed to "AI assistant" below are SIMULATED - no real call is made.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { buildTranscript } = require("../lib/callSimulation");

const DEMO_PHONE = "DEMO-CARELOOP-0001"; // sentinel; not a real phone number
const DEMO_DOMAIN = "careloop-demo.invalid"; // reserved TLD, cannot receive mail

// Timestamp N days ago at a (possibly fractional) hour, e.g. 11.25 = 11:15 UTC.
const mkAgo = (now) => (days, hour = 9) => {
  const d = new Date(now); d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0); return d.toISOString();
};

async function seedDemo(db, { password, now = new Date() } = {}) {
  const { data: existing } = await db.from("businesses").select("id").eq("phone_number", DEMO_PHONE).maybeSingle();
  if (existing) return { created: false, businessId: existing.id, added: await topUpPhase2(db, existing.id, now) };

  const pw = password || crypto.randomBytes(9).toString("base64url") + "!9";
  const ago = mkAgo(now);
  const day = (n) => ago(n).slice(0, 10);

  const { data: biz, error: be } = await db.from("businesses").insert({
    business_name: "CareLoop Demo Hospital (Simulated)", business_type: "hospital", phone_number: DEMO_PHONE,
    is_active: true, products: ["careloop"], is_demo: true,
  }).select().single();
  if (be) throw new Error("Could not create demo business: " + be.message);

  const hash = await bcrypt.hash(pw, 10);
  const mkUser = async (local, role) => {
    const { data, error } = await db.from("business_users").insert({
      business_id: biz.id, email: `${local}@${DEMO_DOMAIN}`, password_hash: hash, role,
    }).select("id, email").single();
    if (error) throw new Error("Could not create demo user: " + error.message);
    return data;
  };
  const clinician = await mkUser("dr.demo", "doctor");
  const coord = await mkUser("coordinator.demo", "receptionist");
  const admin = await mkUser("admin.demo", "admin");

  const depts = {};
  for (const name of ["Endocrinology", "Primary Care", "Breast Imaging", "Cardiology", "Gastroenterology"]) {
    const { data } = await db.from("cl_departments").insert({ business_id: biz.id, name }).select().single();
    depts[name] = data.id;
  }

  const S = (type, userRec, name) => ({ type, id: userRec && userRec.id, name });
  const staffC = S("staff", coord, "coordinator demo"), staffD = S("staff", clinician, "dr demo");
  const ai = { type: "ai", id: null, name: "Sakha assistant (simulated)" };
  const sys = { type: "system", id: null, name: "CareLoop" };

  // Each case: patient, case fields, and an ordered event chain (days ago).
  const cases = [
    { ref: "CL-DEMO01", p: ["Amira Haddad", "1978-04-12", "en"], type: "Diabetes (HbA1c / glucose)", sd: 21,
      result: "HbA1c 7.4% at community screening camp (point-of-care test).",
      interp: "Above the hospital diabetes referral threshold. Confirmatory laboratory testing and a specialist consultation are recommended.",
      next: "Confirmatory HbA1c and fasting glucose, then endocrinology consultation within 14 days.",
      dept: "Endocrinology", owner: coord, urgency: "soon", due: day(5), status: "consult_booked",
      events: [
        [21, 9, "case_registered", null, "pending_clinical_release", staffC, null],
        [20, 10, "status_changed", "pending_clinical_release", "released", staffD, null],
        [19, 11, "status_changed", "released", "patient_contacted", ai, "Simulated outbound call placed to the patient."],
        [19, 11.25, "status_changed", "patient_contacted", "acknowledged", ai, "Simulated call: patient confirmed they understood the next steps."],
        [19, 12, "status_changed", "acknowledged", "consult_booked", staffC, "Endocrinology slot arranged for the patient (simulated call outcome, confirmed by coordinator)."],
      ] },
    { ref: "CL-DEMO02", p: ["Rashid Karim", "1969-09-30", "en"], type: "Hypertension (blood pressure)", sd: 1,
      result: "Blood pressure 152/96 mmHg on two readings at workplace screening.",
      interp: "Stage 2 range readings. Clinical review and repeat measurement recommended.",
      next: "Primary care review within 14 days.", dept: "Primary Care", owner: coord, urgency: "routine", due: day(-13),
      status: "pending_clinical_release", events: [[1, 9, "case_registered", null, "pending_clinical_release", staffC, null]] },
    { ref: "CL-DEMO03", p: ["Leila Nasser", "1985-01-22", "ar"], type: "Diabetes (HbA1c / glucose)", sd: 40,
      result: "Fasting glucose 9.1 mmol/L at annual health check.",
      interp: "Elevated fasting glucose. Confirmatory testing and consultation recommended.",
      next: "Endocrinology consultation and confirmatory testing.", dept: "Endocrinology", owner: clinician, urgency: "soon", due: day(12),
      status: "pending_closure_review", consult: 14, events: [
        [40, 9, "case_registered", null, "pending_clinical_release", staffC, null],
        [39, 9, "status_changed", "pending_clinical_release", "released", staffD, null],
        [38, 10, "status_changed", "released", "patient_contacted", ai, "Simulated outbound call placed."],
        [38, 10.25, "status_changed", "patient_contacted", "acknowledged", ai, "Simulated call: patient acknowledged next steps."],
        [37, 9, "status_changed", "acknowledged", "consult_booked", staffC, "Consultation booked for the following week."],
        [14, 15, "status_changed", "consult_booked", "consult_completed", staffC, "Attended Endocrinology consultation; confirmatory HbA1c 7.9%, treatment plan started."],
        [13, 9, "status_changed", "consult_completed", "referral_completed", staffD, "Referral to Endocrinology accepted and completed; discharge summary on file."],
        [13, 10, "status_changed", "referral_completed", "pending_closure_review", staffC, "All required follow-up evidence recorded. Ready for clinician review."],
      ] },
    { ref: "CL-DEMO04", p: ["Omar Siddiqui", "1962-06-05", "en"], type: "Hypertension (blood pressure)", sd: 2,
      result: "Blood pressure 190/122 mmHg with headache reported at screening.",
      interp: "Severely elevated reading with symptoms. Same-day clinician contact required.",
      next: "Clinician to contact the patient today.", dept: "Cardiology", owner: clinician, urgency: "critical", due: day(0),
      status: "escalated", flags: true, events: [
        [2, 9, "case_registered", null, "pending_clinical_release", staffC, null],
        [2, 9.1, "human_only_flag", null, null, sys, "Urgency \"critical\" - reserved for human handling. Automated patient contact is disabled."],
        [2, 10, "status_changed", "pending_clinical_release", "escalated", staffC, "Escalated to clinician for same-day call."],
      ] },
    { ref: "CL-DEMO05", p: ["Fatima Zahra", "1974-11-18", "ar"], type: "Breast cancer (mammogram)", sd: 18,
      result: "Mammogram flagged for further assessment.",
      interp: "Further imaging assessment recommended.", next: "Diagnostic breast imaging appointment.",
      dept: "Breast Imaging", owner: coord, urgency: "soon", due: day(4), status: "unreachable", events: [
        [18, 9, "case_registered", null, "pending_clinical_release", staffC, null],
        [17, 9, "status_changed", "pending_clinical_release", "released", staffD, null],
        [16, 10, "status_changed", "released", "unreachable", ai, "Simulated call attempts 1-3: no answer; voicemail not left."],
      ] },
    { ref: "CL-DEMO06", p: ["Yusuf Ali", "1971-03-09", "en"], type: "Colorectal cancer", sd: 25,
      result: "Positive faecal immunochemical test.", interp: "Colonoscopy recommended.",
      next: "Gastroenterology referral for colonoscopy.", dept: "Gastroenterology", owner: coord, urgency: "soon", due: day(10),
      status: "declined", events: [
        [25, 9, "case_registered", null, "pending_clinical_release", staffC, null],
        [24, 9, "status_changed", "pending_clinical_release", "released", staffD, null],
        [23, 10, "status_changed", "released", "patient_contacted", ai, "Simulated outbound call placed."],
        [23, 10.5, "status_changed", "patient_contacted", "declined", staffC, "Patient says they will use another provider and does not want follow-up here."],
      ] },
    { ref: "CL-DEMO07", p: ["Noor Hamdan", "1990-08-14", "en"], type: "Diabetes (HbA1c / glucose)", sd: 60,
      result: "HbA1c 6.9% at screening.", interp: "Borderline-diagnostic. Confirmatory testing recommended.",
      next: "Primary care review.", dept: "Primary Care", owner: clinician, urgency: "routine", due: day(30),
      status: "closed", consult: 40, closed: { by: clinician, reason: "completed_care", days: 35,
        evidence: "Primary care visit 2026 completed; diagnosis confirmed, management plan documented, follow-up booked with GP." }, events: [
        [60, 9, "case_registered", null, "pending_clinical_release", staffC, null],
        [59, 9, "status_changed", "pending_clinical_release", "released", staffD, null],
        [58, 9, "status_changed", "released", "patient_contacted", ai, "Simulated outbound call placed."],
        [58, 9.25, "status_changed", "patient_contacted", "acknowledged", ai, "Simulated call: acknowledged."],
        [57, 9, "status_changed", "acknowledged", "consult_booked", staffC, "Booked primary care visit."],
        [40, 11, "status_changed", "consult_booked", "consult_completed", staffC, "Visit attended; diagnosis confirmed."],
        [38, 9, "status_changed", "consult_completed", "pending_closure_review", staffC, "Evidence on file; ready for review."],
        [35, 14, "case_closed", "pending_closure_review", "closed", staffD, "Reviewed and closed by clinician."],
      ] },
    { ref: "CL-DEMO08", p: ["Sara Mansour", "1980-12-02", "en"], type: "Cardiovascular risk", sd: 8,
      result: "10-year cardiovascular risk estimated at 14% at health check.", interp: "Lifestyle and clinic review recommended.",
      next: "Primary care cardiovascular risk review.", dept: "Primary Care", owner: coord, urgency: "routine", due: day(-3),
      status: "acknowledged", events: [
        [8, 9, "case_registered", null, "pending_clinical_release", staffC, null],
        [7, 9, "status_changed", "pending_clinical_release", "released", staffD, null],
        [6, 10, "status_changed", "released", "patient_contacted", ai, "Simulated outbound call placed."],
        [6, 10.25, "status_changed", "patient_contacted", "acknowledged", ai, "Simulated call: acknowledged; wants an evening slot."],
      ] },
    { ref: "CL-DEMO09", p: ["Khalid Aziz", "1966-02-27", "en"], type: "Diabetes (HbA1c / glucose)", sd: 12,
      result: "HbA1c 8.1% at screening camp.", interp: "Elevated. Confirmatory testing and consultation recommended.",
      next: "Endocrinology consultation within 14 days.", dept: "Endocrinology", owner: coord, urgency: "soon", due: day(2),
      status: "patient_contacted", events: [
        [12, 9, "case_registered", null, "pending_clinical_release", staffC, null],
        [11, 9, "status_changed", "pending_clinical_release", "released", staffD, null],
        [6, 10, "status_changed", "released", "patient_contacted", ai, "Simulated outbound call; message left, no confirmation of understanding yet."],
      ] },
  ];

  for (const c of cases) {
    const urgent = ["urgent", "critical"].includes(c.urgency);
    const { data: pat } = await db.from("cl_patients").insert({
      business_id: biz.id, full_name: c.p[0], phone: "+0000000000", date_of_birth: c.p[1], preferred_language: c.p[2],
      contact_consent: true, consent_channels: ["voice", "sms"], consent_recorded_at: ago(c.sd), data_origin: "simulated",
      created_by: coord.id,
    }).select().single();

    const last = c.events[c.events.length - 1];
    const stamp = {};
    for (const e of c.events) {
      const at = ago(e[0], e[1]);
      if (e[5] && e[4] === "released") stamp.released_at = at;
      if (e[4] === "patient_contacted" && !stamp.first_contact_at) stamp.first_contact_at = at;
      if (e[4] === "acknowledged" && !stamp.acknowledged_at) stamp.acknowledged_at = at;
      if (e[4] === "consult_booked") stamp.consult_booked_at = at;
      if (e[4] === "consult_completed") stamp.consult_completed_at = at;
    }
    const row = {
      business_id: biz.id, case_ref: c.ref, patient_id: pat.id, screening_type: c.type, screening_date: day(c.sd),
      result_summary: c.result, clinical_interpretation: c.interp, recommended_next_step: c.next,
      department_id: depts[c.dept], owner_id: c.owner.id, urgency: c.urgency, ai_contact_allowed: !urgent,
      follow_up_due: c.due, status: c.status, status_changed_at: ago(last[0], last[1]), data_origin: "simulated",
      created_by: coord.id, created_at: ago(c.sd), updated_at: ago(last[0], last[1]), ...stamp,
    };
    if (c.closed) {
      Object.assign(row, { closure_reason: c.closed.reason, closure_evidence: c.closed.evidence, closed_by: c.closed.by.id, closed_at: ago(c.closed.days, 14) });
    }
    const { data: cs, error } = await db.from("cl_cases").insert(row).select().single();
    if (error) throw new Error(`Could not create demo case ${c.ref}: ${error.message}`);
    for (const e of c.events) {
      await db.from("cl_case_events").insert({
        business_id: biz.id, case_id: cs.id, event_type: e[2], from_status: e[3], to_status: e[4],
        actor_type: e[5].type, actor_id: e[5].id || null, actor_name: e[5].name, note: e[6],
        metadata: e[5].type === "ai" ? { simulated: true, ...(c.ref === "CL-DEMO01" && e[4] === "patient_contacted" ? { transcript: buildTranscript({ scenario: "acknowledged", patient: { full_name: c.p[0], date_of_birth: c.p[1] }, hospital: "CareLoop Demo Hospital (Simulated)", c: { screening_type: c.type, recommended_next_step: c.next }, slots: ["Saturday 7 November at 10:30 AM", "Monday 9 November at 4:00 PM"], deptName: c.dept, ownerName: "coordinator demo" }) } : {}) } : {}, created_at: ago(e[0], e[1]),
      });
    }
  }
  const added = await topUpPhase2(db, biz.id, now);
  return { created: true, businessId: biz.id, password: pw, users: [clinician.email, coord.email, admin.email], added };
}

// Adds the Phase 2 demo records (referrals, an escalation) to an existing demo hospital.
// Idempotent: a case that already has a referral/escalation is skipped.
async function topUpPhase2(db, bizId, now = new Date()) {
  const ago = mkAgo(now);
  const { data: users } = await db.from("business_users").select("id, email").eq("business_id", bizId);
  const u = Object.fromEntries((users || []).map((x) => [x.email.split("@")[0], x]));
  const clin = u["dr.demo"], coord = u["coordinator.demo"];
  if (!clin || !coord) return { referrals: 0, escalations: 0 };
  const { data: depts } = await db.from("cl_departments").select("id, name").eq("business_id", bizId);
  const dept = Object.fromEntries((depts || []).map((d) => [d.name, d.id]));
  const { data: cases } = await db.from("cl_cases").select("*").eq("business_id", bizId);
  const byRef = Object.fromEntries((cases || []).map((c) => [c.case_ref, c]));
  const out = { referrals: 0, escalations: 0 };

  const addReferral = async (caseRef, deptName, r, events) => {
    const c = byRef[caseRef]; if (!c) return;
    const { data: have } = await db.from("cl_referrals").select("id").eq("case_id", c.id).eq("business_id", bizId);
    if (have && have.length) return;
    const { data: ref, error } = await db.from("cl_referrals").insert({
      business_id: bizId, case_id: c.id, department_id: dept[deptName], assigned_to: clin.id, reason: c.recommended_next_step,
      requested_by: coord.id, data_origin: "simulated", missed_count: 0, ...r,
    }).select().single();
    if (error) throw new Error(`Could not create demo referral for ${caseRef}: ${error.message}`);
    for (const [d, h, type, who, note] of events) {
      await db.from("cl_case_events").insert({
        business_id: bizId, case_id: c.id, event_type: type, actor_type: "staff", actor_id: who.id,
        actor_name: who === clin ? "dr demo" : "coordinator demo", note, metadata: { referral_id: ref.id }, created_at: ago(d, h),
      });
    }
    out.referrals += 1;
  };

  await addReferral("CL-DEMO01", "Endocrinology", {
    status: "scheduled", requested_at: ago(19, 11.5), accepted_at: ago(19, 11.75), accepted_by: clin.id,
    scheduled_for: ago(6, 10), scheduled_by: coord.id, updated_at: ago(19, 11.95),
  }, [[19, 11.5, "referral_created", coord, "Endocrinology referral requested."], [19, 11.75, "referral_accept", clin, null],
      [19, 11.95, "referral_schedule", coord, "Appointment set; attendance not yet recorded."]]);

  await addReferral("CL-DEMO03", "Endocrinology", {
    status: "completed", requested_at: ago(38, 10.5), accepted_at: ago(38, 11), accepted_by: clin.id, scheduled_for: ago(14, 13),
    scheduled_by: coord.id, attended_at: ago(14, 15), attended_note: "Attended Endocrinology consultation; confirmatory HbA1c 7.9%.",
    completed_at: ago(13, 8.9), completed_by: clin.id, outcome_note: "Referral accepted and completed; discharge summary on file.", updated_at: ago(13, 8.9),
  }, [[38, 10.5, "referral_created", coord, "Endocrinology referral requested."], [38, 11, "referral_accept", clin, null],
      [37, 8.9, "referral_schedule", coord, null], [14, 14.9, "referral_attend", coord, "Attended Endocrinology consultation; confirmatory HbA1c 7.9%."],
      [13, 8.9, "referral_complete", clin, "Referral accepted and completed; discharge summary on file."]]);

  await addReferral("CL-DEMO07", "Primary Care", {
    status: "completed", requested_at: ago(58, 9.5), accepted_at: ago(58, 10), accepted_by: clin.id, scheduled_for: ago(40, 10),
    scheduled_by: coord.id, attended_at: ago(40, 10.9), attended_note: "Visit attended; diagnosis confirmed.",
    completed_at: ago(38, 8.8), completed_by: clin.id, outcome_note: "Management plan documented; follow-up with GP booked.", updated_at: ago(38, 8.8),
  }, [[58, 9.5, "referral_created", coord, "Primary care referral requested."], [58, 10, "referral_accept", clin, null],
      [57, 8.9, "referral_schedule", coord, null], [40, 10.9, "referral_attend", coord, "Visit attended; diagnosis confirmed."],
      [38, 8.8, "referral_complete", clin, "Management plan documented; follow-up with GP booked."]]);

  await addReferral("CL-DEMO08", "Primary Care", {
    status: "requested", requested_at: ago(5, 10), delay_reason_code: "capacity",
    delay_note: "Clinic fully booked this week; asked the department for the next available slot.", delayed_at: ago(3, 9), updated_at: ago(3, 9),
  }, [[5, 10, "referral_created", coord, "Primary care referral requested."], [3, 9, "referral_delay", coord, "Clinic fully booked this week; asked the department for the next available slot."]]);

  const esc = byRef["CL-DEMO04"];
  if (esc) {
    const { data: haveE } = await db.from("cl_escalations").select("id").eq("case_id", esc.id).eq("business_id", bizId);
    if (!haveE || !haveE.length) {
      await db.from("cl_escalations").insert({
        business_id: bizId, case_id: esc.id, raised_from_status: "pending_clinical_release", raised_by_type: "staff", raised_by_id: coord.id,
        raised_by_name: "coordinator demo", reason: "Escalated to clinician for same-day call.", assigned_to: clin.id, status: "open",
        raised_at: ago(2, 10), data_origin: "simulated",
      });
      out.escalations += 1;
    }
  }
  return out;
}

if (require.main === module) {
  require("dotenv").config();
  const db = require("../config/db");
  seedDemo(db, { password: process.env.DEMO_PASSWORD }).then(async (r) => {
    const f = await require("../lib/followups").runFollowUps(r.businessId);
    console.log(`Follow-up checks run: ${f.created} reminder(s) created.`);
    if (!r.created) return console.log(`Demo hospital already exists. Added ${r.added.referrals} referral(s) and ${r.added.escalations} escalation(s) that were missing.`);
    console.log("Simulated demo hospital created (synthetic data only).\n");
    r.users.forEach((u) => console.log("  " + u));
    console.log("\n  Password (shown once): " + r.password);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { seedDemo, topUpPhase2, DEMO_PHONE };
