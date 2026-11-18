import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ReferralPill, ErrorNote, fmtDate, fmtDateTime, REJECT_REASONS, DELAY_REASONS, reasonLabel } from "./ui";

const LABEL = { accept: "Accept referral", schedule: "Schedule appointment", attend: "Record attendance", complete: "Complete referral", reject: "Reject referral", cancel: "Cancel referral", missed: "Record missed appointment", delay: "Record a delay" };
const BY_STATUS = { requested: ["accept", "reject", "delay", "cancel"], accepted: ["schedule", "reject", "delay", "cancel"], scheduled: ["attend", "missed", "delay", "cancel"], attended: ["complete"] };
const NOTE_REQUIRED = ["attend", "complete", "reject", "cancel", "missed", "delay"];
const OPEN = ["requested", "accepted", "scheduled", "attended"];

export default function ReferralPanel({ c, referrals, depts, staff, reload }) {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [nf, setNf] = useState({ department_id: c.department_id || "", assigned_to: "", reason: c.recommended_next_step || "", note: "" });
  const [open, setOpen] = useState(null);                     // { id, action }
  const [f, setF] = useState({ note: "", reason_code: "", scheduled_for: "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [msg, setMsg] = useState("");
  const hasOpen = referrals.some((r) => OPEN.includes(r.status));
  const canCreate = can("referral.create") && !hasOpen && !["pending_clinical_release", "closed"].includes(c.status);
  const clinicians = staff.filter((s) => s.role === "clinician");
  const differs = nf.department_id && c.department_id && nf.department_id !== c.department_id;

  const run = async (fn, ok) => {
    setBusy(true); setError(""); setMsg("");
    try { const r = await fn(); setMsg(r && r.escalated ? `${ok} The case was escalated for clinician review.` : ok); setOpen(null); setCreating(false); await reload(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const submitAction = (e, r) => {
    e.preventDefault();
    const body = { action: open.action, note: f.note, reason_code: f.reason_code || undefined, scheduled_for: f.scheduled_for ? new Date(f.scheduled_for).toISOString() : undefined };
    run(() => api(`/referrals/${r.id}/action`, { method: "POST", body }), `${LABEL[open.action]}: done.`);
  };

  return (
    <section className="panel" aria-labelledby="rh">
      <h2 id="rh">Referral</h2>
      <p className="hint" style={{ marginTop: 0 }}>A booked appointment is not a completed referral. The patient must be seen, with evidence recorded, and a clinician records the outcome. Appointment times are entered by staff; CareLoop does not read hospital scheduling systems yet.</p>
      <ErrorNote error={error} />
      {msg && <div className="ok" role="status">{msg}</div>}
      {referrals.length === 0 && !creating && <p className="muted">No referral has been made for this case.</p>}

      {referrals.map((r) => {
        const passed = r.status === "scheduled" && r.scheduled_for && Date.parse(r.scheduled_for) < Date.now();
        return (
          <div className="refcard" key={r.id}>
            <h3>{r.department_name || "Department"} <ReferralPill status={r.status} /></h3>
            {passed && <div className="flag" role="note">The appointment time has passed and attendance has not been recorded.</div>}
            <dl className="facts">
              <dt>Reason</dt><dd>{r.reason}</dd>
              <dt>Requested</dt><dd>{fmtDateTime(r.requested_at)}{r.assigned_name ? `, for ${r.assigned_name}` : ""}</dd>
              {r.scheduled_for && <><dt>Appointment</dt><dd>{fmtDateTime(r.scheduled_for)}</dd></>}
              {r.missed_count > 0 && <><dt>Missed</dt><dd>{r.missed_count} time(s)</dd></>}
              {r.delay_reason_code && OPEN.includes(r.status) && <><dt>Delay</dt><dd>{reasonLabel(DELAY_REASONS, r.delay_reason_code)}: {r.delay_note}</dd></>}
              {r.attended_note && <><dt>Attendance evidence</dt><dd>{r.attended_note}</dd></>}
              {r.outcome_note && <><dt>Outcome</dt><dd>{r.outcome_note}</dd></>}
              {r.status === "rejected" && <><dt>Rejected because</dt><dd>{reasonLabel(REJECT_REASONS, r.rejection_reason_code)}: {r.rejection_note}</dd></>}
              {r.status === "cancelled" && <><dt>Cancelled</dt><dd>{r.cancelled_note}</dd></>}
            </dl>
            {(BY_STATUS[r.status] || []).length > 0 && (
              <div className="actions" style={{ marginTop: ".7rem" }}>
                {(BY_STATUS[r.status] || []).map((a) => (a === "complete" && !can("case.review")
                  ? <span key={a} className="muted">A clinician must record the outcome to complete this referral.</span>
                  : <button key={a} onClick={() => { setOpen({ id: r.id, action: a }); setF({ note: "", reason_code: "", scheduled_for: "" }); setError(""); }}>{LABEL[a]}</button>))}
              </div>)}
            {open && open.id === r.id && (
              <form className="subpanel" onSubmit={(e) => submitAction(e, r)}>
                <strong>{LABEL[open.action]}</strong>
                {open.action === "schedule" && <div className="field" style={{ marginTop: ".6rem" }}><label htmlFor="sf">Appointment date and time</label><input id="sf" type="datetime-local" value={f.scheduled_for} onChange={(e) => setF({ ...f, scheduled_for: e.target.value })} required /></div>}
                {["reject", "delay"].includes(open.action) && (
                  <div className="field" style={{ marginTop: ".6rem" }}><label htmlFor="rc">Reason</label>
                    <select id="rc" value={f.reason_code} onChange={(e) => setF({ ...f, reason_code: e.target.value })} required><option value="">Choose a reason</option>
                      {(open.action === "reject" ? REJECT_REASONS : DELAY_REASONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>)}
                <div className="field" style={{ marginTop: ".6rem" }}>
                  <label htmlFor="rn">{open.action === "attend" ? "Evidence that the patient was seen" : open.action === "complete" ? "Outcome" : "Note"}{NOTE_REQUIRED.includes(open.action) ? " (required)" : " (optional)"}</label>
                  <textarea id="rn" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} required={NOTE_REQUIRED.includes(open.action)} minLength={NOTE_REQUIRED.includes(open.action) ? 3 : 0} /></div>
                {open.action === "reject" && <p className="hint">Rejecting a referral escalates the case to clinician review automatically.</p>}
                <button className="primary" disabled={busy}>Confirm</button> <button type="button" onClick={() => setOpen(null)}>Cancel</button>
              </form>)}
          </div>);
      })}

      {canCreate && !creating && <button onClick={() => setCreating(true)}>Create referral</button>}
      {creating && (
        <form className="subpanel" onSubmit={(e) => { e.preventDefault(); run(() => api("/referrals", { method: "POST", body: { case_id: c.id, ...nf, assigned_to: nf.assigned_to || undefined } }), "Referral requested."); }}>
          <strong>New referral</strong>
          <div className="grid2" style={{ marginTop: ".6rem" }}>
            <div className="field"><label htmlFor="nd">Receiving department</label><select id="nd" value={nf.department_id} onChange={(e) => setNf({ ...nf, department_id: e.target.value })} required><option value="">Choose a department</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
              {c.department_id && <p className="hint">The authorised instructions name {(depts.find((d) => d.id === c.department_id) || {}).name}.</p>}</div>
            <div className="field"><label htmlFor="na">Receiving clinician (optional)</label><select id="na" value={nf.assigned_to} onChange={(e) => setNf({ ...nf, assigned_to: e.target.value })}><option value="">Any</option>{clinicians.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          </div>
          <div className="field"><label htmlFor="nr">Reason</label><textarea id="nr" value={nf.reason} onChange={(e) => setNf({ ...nf, reason: e.target.value })} required /></div>
          {differs && <div className="field"><label htmlFor="nn">Why a different department? (required)</label><input id="nn" value={nf.note} onChange={(e) => setNf({ ...nf, note: e.target.value })} required minLength={3} /></div>}
          <button className="primary" disabled={busy}>Request referral</button> <button type="button" onClick={() => setCreating(false)}>Cancel</button>
        </form>)}
    </section>
  );
}

export function EscalationPanel({ escalations }) {
  if (!escalations || escalations.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="eh">
      <h2 id="eh">Escalations</h2>
      {escalations.map((e) => (
        <div key={e.id} className={`escbox ${e.status === "reviewed" ? "done" : ""}`}>
          <strong>{e.status === "open" ? "Open: needs clinician review" : "Reviewed"}</strong>
          <div>{e.reason}</div>
          <div className="muted">Raised {fmtDateTime(e.raised_at)} by {e.raised_by_type === "staff" ? e.raised_by_name : e.raised_by_type === "ai" ? "AI assistant (simulated)" : "CareLoop"}.{e.assigned_name ? ` Review requested from ${e.assigned_name}.` : " No reviewer named."}</div>
          {e.status === "reviewed" && <div className="muted">Reviewed {fmtDateTime(e.reviewed_at)}{e.reviewed_by_name ? ` by ${e.reviewed_by_name}` : ""}: {e.review_note}</div>}
        </div>))}
    </section>
  );
}
