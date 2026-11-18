import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { OriginBadge, ErrorNote, Loading, fmtDateTime } from "../components/ui";

function RuleRow({ r, canConfigure, canAuthorise, onSaved, setError }) {
  const [f, setF] = useState({ enabled: r.enabled, reminder_after_days: r.reminder_after_days, escalate_enabled: r.escalate_enabled, escalate_after_days: r.escalate_after_days ?? "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError("");
    try {
      const body = { enabled: f.enabled, reminder_after_days: Number(f.reminder_after_days) };
      if (canAuthorise) { body.escalate_enabled = f.escalate_enabled; body.escalate_after_days = f.escalate_after_days === "" ? null : Number(f.escalate_after_days); }
      await api(`/followups/rules/${r.rule_key}`, { method: "PUT", body }); await onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <tr>
      <td><strong>{r.label}</strong><br /><span className="muted">{r.help}</span></td>
      <td><label className="check"><input type="checkbox" checked={f.enabled} disabled={!canConfigure} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /><span className="sr">Enabled: {r.label}</span>On</label></td>
      <td><label className="sr" htmlFor={`d-${r.rule_key}`}>Remind owner after days: {r.label}</label><input id={`d-${r.rule_key}`} type="number" min="0" max="90" style={{ width: 80 }} value={f.reminder_after_days} disabled={!canConfigure} onChange={(e) => setF({ ...f, reminder_after_days: e.target.value })} /> days</td>
      <td>
        {canAuthorise ? (<>
          <label className="check"><input type="checkbox" checked={f.escalate_enabled} onChange={(e) => setF({ ...f, escalate_enabled: e.target.checked })} />Escalate automatically after</label>
          <input aria-label={`Escalate after days: ${r.label}`} type="number" min="0" max="180" style={{ width: 80 }} value={f.escalate_after_days} disabled={!f.escalate_enabled} onChange={(e) => setF({ ...f, escalate_after_days: e.target.value })} /> days
        </>) : r.escalate_enabled ? <span>Escalates after {r.escalate_after_days} days. Authorised by {r.authorised_by_name || "a clinician"}.</span> : <span className="muted">Off. Only a clinician can authorise automatic escalation.</span>}
      </td>
      <td>{canConfigure && <button onClick={save} disabled={busy}>Save</button>}</td>
    </tr>
  );
}

export default function FollowUps() {
  const [tasks, setTasks] = useState(null), [rules, setRules] = useState(null), [notes, setNotes] = useState(null);
  const [error, setError] = useState(""), [msg, setMsg] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [t, r, n] = await Promise.all([api("/followups"), api("/followups/rules"), api("/followups/notifications")]);
      setTasks(t.tasks); setRules(r); setNotes(n);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = async () => {
    setBusy(true); setError(""); setMsg("");
    try { const r = await api("/followups/run", { method: "POST" }); setMsg(`Checks complete: ${r.created} new reminder(s), ${r.resolved} cleared, ${r.escalated} escalated automatically.`); await load(); window.dispatchEvent(new Event("careloop:notifications")); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const markRead = async () => { await api("/followups/notifications/read", { method: "POST" }); await load(); window.dispatchEvent(new Event("careloop:notifications")); };
  if (!tasks || !rules || !notes) return error ? <ErrorNote error={error} /> : <Loading />;
  const open = tasks.filter((t) => t.status === "open"), autoEsc = tasks.filter((t) => t.kind === "escalation");

  return (
    <>
      <div className="page-head">
        <div><h1>Follow-ups</h1><p className="muted">Reminders only notify the responsible staff member. Escalating a case is a separate step, and happens automatically only where a clinician has authorised that rule.</p></div>
        {rules.can_configure && <button className="primary" onClick={run} disabled={busy}>{busy ? "Checking..." : "Run checks now"}</button>}
      </div>
      <ErrorNote error={error} />
      {msg && <div className="ok" role="status">{msg}</div>}

      <section className="panel" aria-labelledby="nh">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><h2 id="nh">Your notifications ({notes.unread} unread)</h2>{notes.unread > 0 && <button onClick={markRead}>Mark all read</button>}</div>
        {notes.notifications.length === 0 ? <p className="muted">No notifications.</p> : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>{notes.notifications.slice(0, 8).map((n) => (
            <li key={n.id} style={{ padding: ".5rem 0", borderBottom: "1px solid var(--line)", fontWeight: n.read_at ? 400 : 600 }}>
              <span className={`pill ${n.kind === "escalation" ? "p-crit" : "p-wait"}`}>{n.kind === "escalation" ? "Escalated" : "Reminder"}</span>{" "}
              {n.case_ref ? <Link to={`/cases?q=${n.case_ref}`}>{n.case_ref}</Link> : null} {n.body} <span className="muted">{fmtDateTime(n.created_at)}</span>
            </li>))}</ul>)}
        <p className="hint">Notifications appear here and in the badge at the top. Email, SMS and WhatsApp delivery to staff are not set up.</p>
      </section>

      <section className="panel flat" aria-labelledby="th"><div style={{ padding: "1rem 1.2rem .25rem" }}><h2 id="th">Open follow-ups ({open.length})</h2></div>
        <div className="tablewrap"><table>
          <caption className="sr">Open follow-up tasks</caption>
          <thead><tr><th>Case</th><th>Patient</th><th>What is overdue</th><th>Responsible</th><th>Raised</th></tr></thead>
          <tbody>{open.length === 0 && <tr><td colSpan="5" className="muted">Nothing is waiting. Use "Run checks now" to refresh.</td></tr>}
            {open.map((t) => (<tr key={t.id}><td><Link to={`/cases/${t.case_id}`}>{t.case_ref}</Link> <OriginBadge origin={t.data_origin} /></td><td>{t.patient_name}</td><td>{t.message}</td><td>{t.assigned_name || "Unassigned"}</td><td>{fmtDateTime(t.created_at)}</td></tr>))}</tbody>
        </table></div></section>

      {autoEsc.length > 0 && <section className="panel" aria-labelledby="ah"><h2 id="ah">Escalated automatically ({autoEsc.length})</h2>
        <ul>{autoEsc.slice(0, 8).map((t) => <li key={t.id}><Link to={`/cases/${t.case_id}`}>{t.case_ref}</Link>: {t.message}</li>)}</ul></section>}

      <section className="panel flat" aria-labelledby="rh"><div style={{ padding: "1rem 1.2rem .25rem" }}><h2 id="rh">Rules</h2>
        <p className="muted" style={{ marginTop: 0 }}>{rules.can_configure ? "Reminder timing can be changed by administrators and clinicians. " : ""}{rules.can_authorise_escalation ? "As a clinician you can authorise automatic escalation for a rule; your name is recorded." : "Automatic escalation can only be authorised by a clinician."}</p></div>
        <div className="tablewrap"><table>
          <caption className="sr">Follow-up rules</caption>
          <thead><tr><th>Rule</th><th>Status</th><th>Remind owner after</th><th>Escalation</th><th></th></tr></thead>
          <tbody>{rules.rules.map((r) => <RuleRow key={r.rule_key + JSON.stringify([r.enabled, r.reminder_after_days, r.escalate_enabled, r.escalate_after_days])} r={r} canConfigure={rules.can_configure} canAuthorise={rules.can_authorise_escalation} onSaved={load} setError={setError} />)}</tbody>
        </table></div></section>
    </>
  );
}
