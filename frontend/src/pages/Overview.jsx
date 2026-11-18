import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { StatusPill, UrgencyPill, OriginBadge, ErrorNote, Loading } from "../components/ui";

const STAGES = [
  ["pending_clinical_release", "Awaiting release"], ["released", "Released"], ["patient_contacted", "Contacted"],
  ["acknowledged", "Acknowledged"], ["consult_booked", "Booked"], ["consult_completed", "Consulted"],
  ["referral_completed", "Referred"], ["pending_closure_review", "Closure review"], ["closed", "Closed"],
];
const SIDE = [["escalated", "Escalated"], ["unreachable", "Unreachable"], ["declined", "Declined"]];

export default function Overview() {
  const { can } = useAuth();
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { api("/overview").then(setD).catch((e) => setError(e.message)); }, []);
  if (error) return <ErrorNote error={error} />;
  if (!d) return <Loading />;

  return (
    <>
      <div className="page-head">
        <div><h1>Screening-to-care overview</h1><p className="muted">Where every actionable result stands today.</p></div>
        {can("case.create") && <Link className="btn primary" to="/cases/new">Register a case</Link>}
      </div>

      <section className="panel" aria-labelledby="rail-h">
        <h2 id="rail-h">Patient journey, all cases</h2>
        <div className="rail" role="list">
          {STAGES.map(([s, label]) => {
            const n = d.by_status[s] || 0;
            const hot = s === "pending_clinical_release" && n > 0 && d.awaiting_release > 0;
            return (
              <div role="listitem" key={s} className={`stage ${n ? "has" : ""} ${hot ? "hot" : ""}`}>
                <Link className="node" to={`/cases?status=${s}`} aria-label={`${n} cases: ${label}`}>{n}</Link>
                <small>{label}</small>
              </div>
            );
          })}
        </div>
        <div className="side-lane">
          {SIDE.map(([s, label]) => (
            <Link key={s} className="btn" to={`/cases?status=${s}`}>{label}: <strong>{d.by_status[s] || 0}</strong></Link>
          ))}
        </div>
      </section>

      <div className="kpis">
        <Link className="kpi" to="/cases"><b>{d.active}</b>Active cases</Link>
        <Link className={`kpi ${d.overdue ? "warn" : ""}`} to="/cases?overdue=1"><b>{d.overdue}</b>Follow-ups overdue</Link>
        <Link className={`kpi ${d.urgent_open ? "crit" : ""}`} to="/cases?urgency=urgent"><b>{d.urgent_open}</b>Urgent, human handling</Link>
        <Link className="kpi" to="/cases?status=pending_clinical_release"><b>{d.awaiting_release}</b>Awaiting clinical release</Link>
        <Link className="kpi" to="/referrals"><b>{d.referrals_open}</b>Referrals in progress</Link>
      </div>

      <section className="panel flat" aria-labelledby="att-h">
        <div style={{ padding: "1rem 1.2rem .25rem" }}><h2 id="att-h">Needs attention</h2></div>
        {d.needs_attention.length === 0 ? <p className="muted" style={{ padding: "0 1.2rem 1rem" }}>Nothing needs attention right now.</p> : (
          <div className="tablewrap"><table>
            <caption className="sr">Cases that need attention</caption>
            <thead><tr><th>Case</th><th>Patient</th><th>Status</th><th>Urgency</th><th>Why</th></tr></thead>
            <tbody>{d.needs_attention.map((a) => (
              <tr key={a.id}>
                <td><Link to={`/cases/${a.id}`}>{a.case_ref}</Link> <OriginBadge origin={a.data_origin} /></td>
                <td>{a.patient_name}</td><td><StatusPill status={a.status} /></td><td><UrgencyPill urgency={a.urgency} /></td>
                <td>{a.reasons.join("; ")}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </section>
      <p className="muted">Live cases: {d.data_origin.live}. Simulated cases: {d.data_origin.simulated}. Simulated cases are never mixed into live figures without a label.</p>
    </>
  );
}
