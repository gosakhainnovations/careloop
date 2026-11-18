import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { StatusPill, UrgencyPill, OriginBadge, ErrorNote, Loading, fmtDate, fmtDateTime } from "../components/ui";
import ReferralPanel, { EscalationPanel } from "../components/ReferralPanel";
import CallPanel from "../components/CallPanel";
import Transcript from "../components/Transcript";

const VERB = {
  released: "Release for patient contact", patient_contacted: "Record patient contacted", acknowledged: "Record acknowledgement",
  consult_booked: "Record consultation booked", consult_completed: "Record consultation completed", referral_completed: "Confirm referral completed",
  pending_closure_review: "Send for closure review", closed: "Close case", escalated: "Escalate for clinician review",
  declined: "Record patient declined", unreachable: "Record patient unreachable",
};
const EVENT_TITLE = {
  case_registered: "Case registered", owner_changed: "Owner changed", note: "Note added", human_only_flag: "Reserved for human handling", case_updated: "Details updated", case_closed: "Case closed", ai_question_routed: "Patient question routed to staff",
  referral_created: "Referral requested", referral_accept: "Referral accepted", referral_schedule: "Appointment scheduled", referral_attend: "Attendance recorded",
  referral_complete: "Referral completed", referral_reject: "Referral rejected", referral_cancel: "Referral cancelled", referral_missed: "Missed appointment recorded", referral_delay: "Delay recorded",
};

function Timeline({ events, statusLabel }) {
  return (
    <ol className="tl" aria-label="Patient journey">
      {events.map((e) => (
        <li key={e.id}>
          <span className={`dot ${e.actor_type}`} aria-hidden="true" />
          <div className="what">{e.event_type === "status_changed" ? statusLabel(e.to_status) : EVENT_TITLE[e.event_type] || e.event_type}</div>
          <div className="meta">
            <span className={`chip ${e.actor_type === "ai" ? "ai" : ""}`}>{e.actor_type === "ai" ? "AI assistant (simulated)" : e.actor_type === "system" ? "System" : "Staff"}</span>
            {e.actor_type !== "ai" && e.actor_name ? `${e.actor_name}, ` : ""}{fmtDateTime(e.created_at)}
          </div>
          {e.note && <div className="note">{e.note}</div>}
          {e.metadata && e.metadata.transcript && <details><summary>View call transcript (simulated)</summary><Transcript turns={e.metadata.transcript} /></details>}
        </li>))}
    </ol>
  );
}

export default function CaseDetail() {
  const { id } = useParams();
  const { can, meta } = useAuth();
  const [d, setD] = useState(null), [error, setError] = useState(""), [msg, setMsg] = useState("");
  const [staff, setStaff] = useState([]), [depts, setDepts] = useState([]);
  const [act, setAct] = useState(null);       // { to, requires_note, is_closure }
  const [form, setForm] = useState({ note: "", closure_reason: "", closure_evidence: "" });
  const [assign, setAssign] = useState({ owner_id: "", reason: "" });
  const [note, setNote] = useState("");
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api(`/cases/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); api("/staff").then((r) => setStaff(r.staff)).catch(() => {}); api("/departments").then((r) => setDepts(r.departments)).catch(() => {}); }, [load]);
  const statusLabel = (s) => (meta?.statuses.find((x) => x.value === s) || {}).label || s;

  const run = async (fn, okMsg) => {
    setBusy(true); setError(""); setMsg("");
    try { await fn(); setMsg(okMsg); setAct(null); setEdit(null); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!d) return error ? <ErrorNote error={error} /> : <Loading />;
  const { case: c, patient, department, owner, events, allowed_transitions, referrals = [], escalations = [] } = d;
  const closed = c.status === "closed";
  const hasOpenRef = referrals.some((r) => ["requested", "accepted", "scheduled", "attended"].includes(r.status));
  // With an open referral these steps are recorded on the referral so the two never disagree.
  const actions = allowed_transitions.filter((t) => !(hasOpenRef && ["consult_booked", "consult_completed", "referral_completed"].includes(t.to)));

  return (
    <>
      <p><Link to="/cases">All cases</Link></p>
      <div className="page-head">
        <div>
          <h1>{c.case_ref} <OriginBadge origin={c.data_origin} /></h1>
          <p>{patient?.full_name}, {c.screening_type}</p>
          <p><StatusPill status={c.status} /> <UrgencyPill urgency={c.urgency} />{c.is_overdue && <span className="pill p-crit" style={{ marginLeft: ".4rem" }}>Follow-up overdue</span>}</p>
        </div>
      </div>
      <ErrorNote error={error} />
      {msg && <div className="ok" role="status">{msg}</div>}
      {c.is_overdue && <div className="subpanel" style={{ background: "var(--amber-bg)", borderColor: "#E8C98A" }} role="note"><strong>The follow-up deadline ({fmtDate(c.follow_up_due)}) has passed.</strong> The patient has not completed the next step: this case is still "{statusLabel(c.status)}". Record what happened, or escalate it for clinician review.</div>}
      {!c.ai_contact_allowed && <div className="err" role="note">This case is reserved for human handling. Automated patient contact is switched off.</div>}

      <div className="cols">
        <div>
          <section className="panel" aria-labelledby="fh">
            <h2 id="fh">Case details</h2>
            <dl className="facts">
              <dt>Screening date</dt><dd>{fmtDate(c.screening_date)}</dd>
              <dt>Result</dt><dd>{c.result_summary}</dd>
              <dt>Authorised interpretation</dt><dd>{c.clinical_interpretation || "Not recorded yet"}</dd>
              <dt>Recommended next step</dt><dd>{c.recommended_next_step || "Not recorded yet"}</dd>
              <dt>Department</dt><dd>{department?.name || "Not assigned"}</dd>
              <dt>Accountable owner</dt><dd>{owner ? `${owner.name} (${owner.role_label})` : "Unknown"}</dd>
              <dt>Follow-up deadline</dt><dd className={c.is_overdue ? "due-late" : ""}>{fmtDate(c.follow_up_due)}</dd>
              <dt>Patient contact</dt><dd>{patient?.phone || "No phone"}{patient?.email ? `, ${patient.email}` : ""}. Language: {patient?.preferred_language === "ar" ? "Arabic" : "English"}.</dd>
              <dt>Consent to contact</dt><dd>{patient?.contact_consent ? `Yes: ${(patient.consent_channels || []).join(", ") || "no channel recorded"}` : "Not recorded"}</dd>
              {closed && <><dt>Closure</dt><dd>{(meta?.closure_reasons.find((r) => r.value === c.closure_reason) || {}).label}. {c.closure_evidence}</dd></>}
            </dl>
            {!closed && can("case.update") && <p style={{ marginTop: "1rem" }}><button onClick={() => setEdit(edit ? null : { clinical_interpretation: c.clinical_interpretation || "", recommended_next_step: c.recommended_next_step || "", urgency: c.urgency, follow_up_due: c.follow_up_due || "", department_id: c.department_id || "" })}>{edit ? "Cancel editing" : "Edit details"}</button></p>}
            {edit && (
              <form className="subpanel" onSubmit={(e) => { e.preventDefault(); run(() => api(`/cases/${id}`, { method: "PATCH", body: edit }), "Details updated."); }}>
                <div className="field"><label htmlFor="e1">Authorised clinical interpretation</label><textarea id="e1" value={edit.clinical_interpretation} onChange={(e) => setEdit({ ...edit, clinical_interpretation: e.target.value })} /></div>
                <div className="field"><label htmlFor="e2">Recommended next step</label><input id="e2" value={edit.recommended_next_step} onChange={(e) => setEdit({ ...edit, recommended_next_step: e.target.value })} /></div>
                <div className="grid3">
                  <div className="field"><label htmlFor="e3">Urgency</label><select id="e3" value={edit.urgency} onChange={(e) => setEdit({ ...edit, urgency: e.target.value })}>{["routine", "soon", "urgent", "critical"].map((u) => <option key={u}>{u}</option>)}</select></div>
                  <div className="field"><label htmlFor="e4">Follow-up deadline</label><input id="e4" type="date" value={edit.follow_up_due} onChange={(e) => setEdit({ ...edit, follow_up_due: e.target.value })} /></div>
                  <div className="field"><label htmlFor="e5">Department</label><select id="e5" value={edit.department_id} onChange={(e) => setEdit({ ...edit, department_id: e.target.value })}><option value="">Not assigned</option>{depts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
                </div>
                <button className="primary" disabled={busy}>Save changes</button>
              </form>)}
          </section>

          {!closed && (
            <section className="panel" aria-labelledby="ah">
              <h2 id="ah">Next actions</h2>
              {actions.length === 0 ? <p className="muted">{hasOpenRef ? "Use the referral below to record the next step." : "You have no actions available on this case at its current stage."}</p> : (
                <div className="actions">{actions.map((t) => (
                  <button key={t.to} className={t.is_closure ? "danger" : t.to === "released" ? "primary" : ""} onClick={() => { setAct(t); setForm({ note: "", closure_reason: "", closure_evidence: "" }); }}>{VERB[t.to] || t.to}</button>))}</div>)}
              {act && (
                <form className="subpanel" onSubmit={(e) => { e.preventDefault(); run(() => api(`/cases/${id}/transition`, { method: "POST", body: { to: act.to, ...form, escalate_to: form.escalate_to || undefined } }), `${VERB[act.to]}: done.`); }}>
                  <strong>{VERB[act.to]}</strong>
                  {act.is_closure && <>
                    <div className="field" style={{ marginTop: ".6rem" }}><label htmlFor="cr">Closure reason</label><select id="cr" value={form.closure_reason} onChange={(e) => setForm({ ...form, closure_reason: e.target.value })} required><option value="">Choose a reason</option>{meta.closure_reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></div>
                    <div className="field"><label htmlFor="ce">Evidence supporting closure</label><textarea id="ce" value={form.closure_evidence} onChange={(e) => setForm({ ...form, closure_evidence: e.target.value })} required minLength={10} /><p className="hint">For example: the consultation date, who saw the patient, and where the outcome is documented.</p></div></>}
                  {act.to === "escalated" && <div className="field" style={{ marginTop: ".6rem" }}><label htmlFor="et">Ask this clinician to review (optional)</label><select id="et" value={form.escalate_to || ""} onChange={(e) => setForm({ ...form, escalate_to: e.target.value })}><option value="">No one named</option>{staff.filter((s) => s.role === "clinician").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>}
                  <div className="field" style={{ marginTop: ".6rem" }}><label htmlFor="nt">Note{act.requires_note ? " (required)" : " (optional)"}</label><textarea id="nt" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} required={act.requires_note} /></div>
                  <button className={act.is_closure ? "danger" : "primary"} disabled={busy}>Confirm</button> <button type="button" onClick={() => setAct(null)}>Cancel</button>
                </form>)}
            </section>)}

          <CallPanel c={c} patient={patient} reload={load} />
          <EscalationPanel escalations={escalations} />
          <ReferralPanel c={c} referrals={referrals} depts={depts} staff={staff} reload={load} />

          {!closed && can("case.assign") && (
            <section className="panel" aria-labelledby="oh">
              <h2 id="oh">Transfer ownership</h2>
              <form onSubmit={(e) => { e.preventDefault(); run(() => api(`/cases/${id}/assign`, { method: "POST", body: assign }), "Ownership transferred."); setAssign({ owner_id: "", reason: "" }); }}>
                <div className="grid2">
                  <div className="field"><label htmlFor="no">New owner</label><select id="no" value={assign.owner_id} onChange={(e) => setAssign({ ...assign, owner_id: e.target.value })} required><option value="">Choose a staff member</option>{staff.filter((s) => s.id !== c.owner_id).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.role_label})</option>)}</select></div>
                  <div className="field"><label htmlFor="nr">Reason</label><input id="nr" value={assign.reason} onChange={(e) => setAssign({ ...assign, reason: e.target.value })} required minLength={3} /></div>
                </div>
                <button disabled={busy}>Transfer ownership</button>
              </form>
            </section>)}
        </div>

        <aside>
          <section className="panel" aria-labelledby="th">
            <h2 id="th">Patient journey</h2>
            <Timeline events={events} statusLabel={statusLabel} />
            {can("note.add") && (
              <form onSubmit={(e) => { e.preventDefault(); run(() => api(`/cases/${id}/notes`, { method: "POST", body: { note } }), "Note added."); setNote(""); }}>
                <div className="field"><label htmlFor="an">Add a note</label><textarea id="an" value={note} onChange={(e) => setNote(e.target.value)} required minLength={2} /></div>
                <button disabled={busy}>Add note</button>
              </form>)}
          </section>
        </aside>
      </div>
    </>
  );
}
