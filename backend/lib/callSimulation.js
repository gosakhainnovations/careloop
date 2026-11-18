// SIMULATED AI patient call. No real call is placed. It shows exactly what the real call layer will be allowed to do:
//  - speak ONLY the clinician-approved next step, and only after a date-of-birth check
//  - ask the patient to repeat the step back (teach-back) to confirm understanding
//  - record contact / acknowledgement, and put in a consultation REQUEST that staff confirm
//  - never answer medical questions (they are routed to staff) and never decide anything clinical
// All state changes go through transitionCase, so the same safety rules apply as for any other actor.
const db = require("../config/db");
const { transitionCase, addEvent } = require("./caseService");
const { permsFor } = require("./permissions");

const AI = { type: "ai", id: null, name: "Sakha assistant (simulated)", perms: [] };
const SCENARIOS = {
  acknowledged: "Patient understands and prefers an appointment slot",
  question: "Patient asks a medical question the assistant must not answer",
  no_answer: "No answer after three attempts",
  identity_failed: "Date of birth does not match",
  declines: "Patient does not want follow-up",
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const ACTIVE_REF = ["requested", "accepted", "scheduled", "attended"];

function slotsFrom(now = new Date()) {
  const out = []; const d = new Date(now);
  while (out.length < 2) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (![0, 6].includes(d.getUTCDay())) out.push(`${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })} at ${out.length ? "4:00 PM" : "10:30 AM"}`);
  }
  return out;
}
const dobText = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function buildTranscript({ scenario, patient, hospital, c, slots, deptName, ownerName }) {
  const first = String(patient.full_name).split(" ")[0];
  const A = (t) => ({ who: "assistant", text: t }), P = (t) => ({ who: "patient", text: t });
  const open = [A(`Hello, this is the Sakha assistant calling on behalf of ${hospital}. May I speak with ${patient.full_name}?`)];
  if (scenario === "no_answer") return [...open, { who: "system", text: "No answer. Second attempt: no answer. Third attempt: no answer. No message was left and no health information was shared." }];
  open.push(P("Yes, speaking."), A("Before I share anything, please confirm your date of birth."));
  if (scenario === "identity_failed") return [...open, P("It is the 3rd of March 1990."), A("I'm sorry, that does not match our records, so I cannot continue. I have not shared any details. Someone from the care team will contact you. Goodbye.")];
  open.push(P(`${dobText(patient.date_of_birth)}.`), A(`Thank you, ${first}. Your recent ${c.screening_type} result needs a follow-up${deptName ? ` with ${deptName}` : ""}. ${c.recommended_next_step} I am not a doctor and this is not a diagnosis; the doctor will explain everything.`));
  if (scenario === "declines") return [...open, A("Does that make sense to you?"), P("I don't want to go to the hospital. I don't want any follow-up."), A("I understand. I won't push. I will let your care team know so that someone can talk it through with you. Thank you for your time. Goodbye.")];
  const t = [...open];
  if (scenario === "question") t.push(A("Does that make sense to you?"), P("Yes, but is this serious? Do I need to take medicine?"), A(`That is a question for a doctor, and I am not able to answer it. I will ask ${ownerName || "your care team"} to call you. Meanwhile, could you tell me in your own words what the next step is?`));
  else t.push(A("To make sure I explained it well, could you tell me in your own words what you will do next?"));
  t.push(P(`I will go to ${deptName || "the doctor"} for the check-up soon, like you said.`), A("That is exactly right. Would you like us to arrange the visit? I can offer " + slots[0] + ", or " + slots[1] + "."), P(`${slots[0]} suits me.`), A(`I have passed your preference to ${hospital}. A coordinator will confirm the booking with you; nothing is booked until they do. Is there anything else you would like me to note?`), P("No, thank you."), A("Thank you. Goodbye."));
  return t;
}

async function runSimulatedCall({ user, caseRow, patient, scenario, ip }) {
  if (!SCENARIOS[scenario]) throw fail(400, "Choose a scenario.");
  if (!patient) throw fail(404, "Patient not found");
  if (!["released", "patient_contacted"].includes(caseRow.status)) throw fail(409, "A call can only be made after a clinician has released the case and before the patient has acknowledged.");
  if (caseRow.ai_contact_allowed === false) throw fail(409, "This case is reserved for human handling. Automated contact is switched off.");
  if (!patient.contact_consent || !(patient.consent_channels || []).includes("voice")) throw fail(409, "The patient has not agreed to be contacted by phone.");
  if (patient.preferred_language !== "en") throw fail(409, "Arabic voice is not available yet. Please contact this patient by staff.");
  if (!patient.date_of_birth) throw fail(409, "A date of birth is needed to verify identity before any health information is shared.");

  const biz = (await db.from("businesses").select("business_name").eq("id", user.businessId).maybeSingle()).data;
  const hospital = (biz && biz.business_name) || "the hospital";
  const { data: users } = await db.from("business_users").select("id, email, role").eq("business_id", user.businessId);
  const owner = (users || []).find((u) => u.id === caseRow.owner_id);
  const ownerName = owner ? owner.email.split("@")[0].replace(/[._-]+/g, " ") : null;
  const dept = caseRow.department_id ? (await db.from("cl_departments").select("name").eq("id", caseRow.department_id).eq("business_id", user.businessId).maybeSingle()).data : null;
  const slots = slotsFrom();
  const transcript = buildTranscript({ scenario, patient, hospital, c: caseRow, slots, deptName: dept && dept.name, ownerName });

  const out = { scenario, transcript, steps: [], referral_requested: false, question_routed: false };
  let row = caseRow, attached = false;
  const move = async (to, note) => {
    const meta = { simulated: true, scenario, ...(attached ? {} : { transcript }) };
    const r = await transitionCase({ user, actor: AI, caseRow: row, to, input: { note, metadata: meta }, ip });
    if (!r.ok) throw fail(r.status, r.error);
    attached = true; row = r.data; out.steps.push(to);
  };
  if (scenario === "no_answer") await move("unreachable", "Simulated call: no answer after 3 attempts. No message left.");
  else if (scenario === "identity_failed") await move("unreachable", "Simulated call: identity could not be verified, so no health information was shared.");
  else {
    if (row.status === "released") await move("patient_contacted", "Simulated call connected. Identity verified by date of birth.");
    if (scenario === "declines") await move("escalated", "Simulated call: the patient said they do not want follow-up. A staff member needs to talk to them.");
    else {
      await move("acknowledged", "Simulated call: the patient repeated the next step correctly (teach-back).");
      if (scenario === "question") {
        await addEvent(user, row.id, { event_type: "ai_question_routed", actor_type: "ai", actor_name: AI.name, note: 'Patient asked "Is this serious? Do I need to take medicine?" The assistant did not answer and routed it to staff for a callback.', metadata: { simulated: true } });
        const notify = [row.owner_id, ...(users || []).filter((u) => permsFor(u.role).includes("case.review")).map((u) => u.id)];
        for (const uid of [...new Set(notify.filter(Boolean))]) await db.from("cl_notifications").insert({ business_id: user.businessId, user_id: uid, case_id: row.id, kind: "reminder", title: `${row.case_ref}: patient question for staff`, body: "During a simulated call the patient asked a medical question. Please call them back." });
        out.question_routed = true;
      }
      const { data: open } = await db.from("cl_referrals").select("id").eq("case_id", row.id).eq("business_id", user.businessId).in("status", ACTIVE_REF);
      if (row.department_id && !(open && open.length)) {
        const { data: ref } = await db.from("cl_referrals").insert({ business_id: user.businessId, case_id: row.id, department_id: row.department_id, assigned_to: null, reason: row.recommended_next_step, status: "requested", requested_by: null, requested_at: new Date().toISOString(), missed_count: 0, data_origin: row.data_origin }).select().single();
        if (ref) { await addEvent(user, row.id, { event_type: "referral_created", actor_type: "ai", actor_name: AI.name, note: `Requested during the simulated call. The patient prefers ${slots[0]}. Staff must confirm.`, metadata: { simulated: true, referral_id: ref.id } }); out.referral_requested = true; }
      }
    }
  }
  out.case = row;
  return out;
}
module.exports = { runSimulatedCall, buildTranscript, SCENARIOS };
