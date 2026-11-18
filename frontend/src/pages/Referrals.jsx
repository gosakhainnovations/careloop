import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ReferralPill, OriginBadge, UrgencyPill, ErrorNote, Loading, fmtDateTime } from "../components/ui";

const FILTERS = [["", "All referrals"], ["requested", "Awaiting acceptance"], ["accepted", "Awaiting appointment"], ["scheduled", "Appointment scheduled"], ["attended", "Awaiting outcome"], ["completed", "Completed"], ["rejected", "Rejected"]];

export default function Referrals() {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState(null), [error, setError] = useState("");
  useEffect(() => { setRows(null); api(`/referrals${status ? `?status=${status}` : ""}`).then((r) => setRows(r.referrals)).catch((e) => setError(e.message)); }, [status]);
  const sorted = rows && [...rows].sort((a, b) => b.issues.length - a.issues.length);
  const flagged = rows ? rows.filter((r) => r.issues.length).length : 0;
  return (
    <>
      <div className="page-head"><div><h1>Referrals</h1><p className="muted">Every referral and whether the patient was actually seen. Booked is not the same as completed.</p></div></div>
      <div className="filters"><div><label htmlFor="rs">Show</label><select id="rs" value={status} onChange={(e) => setStatus(e.target.value)}>{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        {rows && <p role="status" style={{ margin: 0 }}><strong>{flagged}</strong> need attention</p>}</div>
      <ErrorNote error={error} />
      {!rows && !error ? <Loading /> : rows && (
        <div className="panel flat"><div className="tablewrap"><table>
          <caption className="sr">Referrals</caption>
          <thead><tr><th>Case</th><th>Patient</th><th>Department</th><th>Referral</th><th>Appointment</th><th>Needs attention</th></tr></thead>
          <tbody>
            {sorted.length === 0 && <tr><td colSpan="6" className="muted">No referrals match.</td></tr>}
            {sorted.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/cases/${r.case_id}`}>{r.case_ref}</Link> <OriginBadge origin={r.data_origin} /></td>
                <td>{r.patient_name} <UrgencyPill urgency={r.urgency} /></td>
                <td>{r.department_name}{r.assigned_name ? <span className="muted"><br />{r.assigned_name}</span> : null}</td>
                <td><ReferralPill status={r.status} />{r.missed_count > 0 && <span className="muted"><br />Missed {r.missed_count}x</span>}</td>
                <td>{r.scheduled_for ? fmtDateTime(r.scheduled_for) : "Not scheduled"}</td>
                <td>{r.issues.length ? r.issues.join("; ") : <span className="muted">None</span>}</td>
              </tr>))}
          </tbody>
        </table></div></div>)}
    </>
  );
}
