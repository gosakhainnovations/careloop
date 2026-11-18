import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorNote, Loading } from "../components/ui";

const num = (v, suffix = "") => (v === null || v === undefined ? "No data yet" : `${v}${suffix}`);
function Kpi({ label, value, sub }) { return <div className="kpi"><b>{value}</b>{label}{sub && <div className="hint">{sub}</div>}</div>; }

export default function Analytics() {
  const { can } = useAuth();
  const [f, setF] = useState({ from: "", to: "", department_id: "", data_origin: "" });
  const [d, setD] = useState(null), [error, setError] = useState("");
  useEffect(() => {
    if (!can("analytics.view")) return;
    setD(null); setError("");
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    api(`/analytics?${qs}`).then(setD).catch((e) => setError(e.message));
  }, [f]); // eslint-disable-line
  if (!can("analytics.view")) return <><h1>Analytics and reports</h1><p className="muted">Analytics are available to clinicians and administrators.</p></>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const max = d ? Math.max(1, ...d.funnel.map((x) => x.count)) : 1;
  const groups = d ? ["Delay", "Rejection", "Drop-off"].map((g) => [g, d.reasons.filter((r) => r.group === g)]) : [];

  return (
    <>
      <div className="page-head"><div><h1>Analytics and reports</h1><p className="muted">How well actionable results are turning into completed care.</p></div></div>
      <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Report filters">
        <div><label htmlFor="af">Screened from</label><input id="af" type="date" value={f.from} onChange={set("from")} /></div>
        <div><label htmlFor="at">Screened to</label><input id="at" type="date" value={f.to} onChange={set("to")} /></div>
        <div><label htmlFor="ad">Department</label><select id="ad" value={f.department_id} onChange={set("department_id")}><option value="">All departments</option>{(d?.departments || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div><label htmlFor="ao">Data</label><select id="ao" value={f.data_origin} onChange={set("data_origin")}><option value="">Live and simulated</option><option value="live">Live only</option><option value="simulated">Simulated only</option></select></div>
      </form>
      <ErrorNote error={error} />
      {!d && !error ? <Loading /> : d && (
        <>
          {d.origin.simulated > 0 && <div className="banner" style={{ borderRadius: 6, marginBottom: "1rem" }} role="note">This report includes {d.origin.simulated} simulated case(s) and {d.origin.live} live case(s). Simulated cases are synthetic demonstration data, not real patients. Use the Data filter to separate them.</div>}
          {d.totals.cases === 0 ? <p className="muted">No cases match these filters.</p> : (
            <>
              <div className="kpis">
                <Kpi label="Screening cases" value={d.totals.cases} sub={`${d.totals.active} still open`} />
                <Kpi label="Patients contacted" value={d.contact.contacted} sub={num(d.contact.contacted_rate, "% of cases")} />
                <Kpi label="Acknowledged" value={d.contact.acknowledged} sub={num(d.contact.acknowledgement_rate, "% of those contacted")} />
                <Kpi label="Consultations booked / completed" value={`${d.consultations.booked} / ${d.consultations.completed}`} />
                <Kpi label="Referrals accepted / completed" value={`${d.referrals.accepted} / ${d.referrals.completed}`} sub={num(d.referrals.completion_rate, "% completed")} />
                <Kpi label="Missed appointments" value={d.referrals.missed_appointments} />
                <Kpi label="Overdue follow-ups" value={d.totals.overdue} sub={`${d.totals.unresolved} unresolved actionable results`} />
                <Kpi label="Closed with documentation" value={d.closure.closed} sub={`${d.closure.closed_completed_care} after completed care`} />
                <Kpi label="Average days, screening to notification" value={num(d.times.avg_days_to_notification)} />
                <Kpi label="Average days, screening to consultation" value={num(d.times.avg_days_to_consultation)} />
                <Kpi label="Escalations open" value={d.escalations.open} sub={d.escalations.avg_hours_to_review === null ? "No reviews yet" : `${d.escalations.avg_hours_to_review} h average to review`} />
              </div>

              <section className="panel" aria-labelledby="fh"><h2 id="fh">Where patients are in the journey</h2>
                {d.funnel.map((s) => (
                  <div key={s.label} style={{ display: "grid", gridTemplateColumns: "190px 1fr 40px", gap: ".6rem", alignItems: "center", marginBottom: ".35rem" }}>
                    <span>{s.label}</span><div className="barbox"><div className="bar" style={{ width: `${(s.count / max) * 100}%` }} /></div><strong>{s.count}</strong>
                  </div>))}
              </section>

              <section className="panel" aria-labelledby="rh"><h2 id="rh">Reasons for delay and drop-off</h2>
                {d.reasons.length === 0 ? <p className="muted">No delays or drop-offs recorded.</p> : (
                  <div className="grid3">{groups.map(([g, list]) => (
                    <div key={g}><strong>{g}</strong>{list.length === 0 ? <p className="muted">None recorded</p> : <ul>{list.map((r) => <li key={r.key}>{r.label}: <strong>{r.count}</strong></li>)}</ul>}</div>))}</div>)}
              </section>

              <section className="panel flat" aria-labelledby="dh"><div style={{ padding: "1rem 1.2rem .25rem" }}><h2 id="dh">By department</h2></div>
                <div className="tablewrap"><table>
                  <caption className="sr">Cases by department</caption>
                  <thead><tr><th>Department</th><th>Cases</th><th>Contacted</th><th>Consultation completed</th><th>Closed</th><th>Overdue</th></tr></thead>
                  <tbody>{d.by_department.map((r) => <tr key={r.department}><td>{r.department}</td><td>{r.cases}</td><td>{r.contacted}</td><td>{r.consulted}</td><td>{r.closed}</td><td className={r.overdue ? "due-late" : ""}>{r.overdue}</td></tr>)}</tbody>
                </table></div></section>
              <p className="muted">These figures are computed from the timestamps recorded on each case. No outcome claims are made: a pilot with a hospital is needed to compare against a baseline.</p>
            </>)}
        </>)}
    </>
  );
}
