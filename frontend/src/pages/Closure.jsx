import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { StatusPill, OriginBadge, ErrorNote, Loading, fmtDate } from "../components/ui";

function Table({ rows, closed }) {
  if (!rows) return <Loading />;
  if (rows.length === 0) return <p className="muted" style={{ padding: "0 1.2rem 1rem" }}>None.</p>;
  return <div className="tablewrap"><table>
    <thead><tr><th>Case</th><th>Patient</th><th>Screening</th><th>Status</th><th>{closed ? "Closed" : "Follow-up due"}</th></tr></thead>
    <tbody>{rows.map((c) => (
      <tr key={c.id}><td><Link to={`/cases/${c.id}`}>{c.case_ref}</Link> <OriginBadge origin={c.data_origin} /></td><td>{c.patient_name}</td><td>{c.screening_type}</td>
        <td><StatusPill status={c.status} /></td><td>{closed ? fmtDate(c.closed_at) : fmtDate(c.follow_up_due)}</td></tr>))}</tbody>
  </table></div>;
}

export default function Closure() {
  const [review, setReview] = useState(null), [closed, setClosed] = useState(null), [error, setError] = useState("");
  useEffect(() => {
    api("/cases?status=pending_closure_review").then((r) => setReview(r.cases)).catch((e) => setError(e.message));
    api("/cases?status=closed").then((r) => setClosed(r.cases)).catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <div className="page-head"><div><h1>Case closure</h1><p className="muted">A case closes only when a clinician records the reason and the evidence. A completed AI call never closes a case.</p></div></div>
      <ErrorNote error={error} />
      <section className="panel flat"><div style={{ padding: "1rem 1.2rem .25rem" }}><h2>Awaiting closure review</h2></div><Table rows={review} /></section>
      <section className="panel flat"><div style={{ padding: "1rem 1.2rem .25rem" }}><h2>Closed</h2></div><Table rows={closed} closed /></section>
    </>
  );
}
