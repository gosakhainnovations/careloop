import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { UrgencyPill, OriginBadge, ErrorNote, Loading, fmtDateTime } from "../components/ui";

const who = (e) => (e.raised_by_type === "staff" ? e.raised_by_name || "Staff" : e.raised_by_type === "ai" ? "AI assistant (simulated)" : "CareLoop (automatic)");

export default function Escalations() {
  const [status, setStatus] = useState("open");
  const [rows, setRows] = useState(null), [error, setError] = useState("");
  useEffect(() => { setRows(null); api(`/escalations${status ? `?status=${status}` : ""}`).then((r) => setRows(r.escalations)).catch((e) => setError(e.message)); }, [status]);
  return (
    <>
      <div className="page-head"><div><h1>Escalations</h1><p className="muted">Cases raised for clinician review. A case leaves escalation only when a clinician records their review.</p></div></div>
      <div className="filters"><div><label htmlFor="es">Show</label><select id="es" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Open</option><option value="reviewed">Reviewed</option><option value="">All</option></select></div></div>
      <ErrorNote error={error} />
      {!rows && !error ? <Loading /> : rows && (
        <div className="panel flat"><div className="tablewrap"><table>
          <caption className="sr">Escalations</caption>
          <thead><tr><th>Case</th><th>Patient</th><th>Reason</th><th>Raised</th><th>Reviewer</th><th>Status</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="6" className="muted">None.</td></tr>}
            {rows.map((e) => (
              <tr key={e.id}>
                <td><Link to={`/cases/${e.case_id}`}>{e.case_ref}</Link> <OriginBadge origin={e.data_origin} /></td>
                <td>{e.patient_name} <UrgencyPill urgency={e.urgency} /></td>
                <td>{e.reason}</td>
                <td>{fmtDateTime(e.raised_at)}<br /><span className="muted">{who(e)}</span></td>
                <td>{e.assigned_name || <span className="muted">No reviewer named</span>}</td>
                <td>{e.status === "open" ? <span className="pill p-crit">Open{e.hours_open != null ? `, ${e.hours_open}h` : ""}</span>
                  : <><span className="pill p-done">Reviewed</span><br /><span className="muted">{e.reviewed_by_name ? `${e.reviewed_by_name}: ` : ""}{e.review_note}</span></>}</td>
              </tr>))}
          </tbody>
        </table></div></div>)}
    </>
  );
}
