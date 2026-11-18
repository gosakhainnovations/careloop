import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { StatusPill, UrgencyPill, OriginBadge, ErrorNote, Loading, fmtDate } from "../components/ui";

export default function Cases({ preset = {}, title = "Screening cases", intro = "Every registered screening result and where it stands." }) {
  const { can, meta } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [staff, setStaff] = useState({});
  const [error, setError] = useState("");
  const f = { status: sp.get("status") || preset.status || "", urgency: sp.get("urgency") || "", q: sp.get("q") || "", overdue: sp.get("overdue") === "1", mine: sp.get("mine") === "1" };
  const set = (k, v) => { const n = new URLSearchParams(sp); if (v) n.set(k, v === true ? "1" : v); else n.delete(k); setSp(n, { replace: true }); };

  useEffect(() => { api("/staff").then((r) => setStaff(Object.fromEntries(r.staff.map((s) => [s.id, s.name])))).catch(() => {}); }, []);
  useEffect(() => {
    setRows(null); setError("");
    const qs = new URLSearchParams(Object.entries({ status: f.status, urgency: f.urgency, q: f.q, overdue: f.overdue ? "1" : "", mine: f.mine ? "1" : "" }).filter(([, v]) => v));
    api(`/cases?${qs}`).then((r) => setRows(r.cases)).catch((e) => setError(e.message));
  }, [f.status, f.urgency, f.q, f.overdue, f.mine]); // eslint-disable-line

  return (
    <>
      <div className="page-head">
        <div><h1>{title}</h1><p className="muted">{intro}</p></div>
        {can("case.create") && <Link className="btn primary" to="/cases/new">Register a case</Link>}
      </div>
      <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
        <div><label htmlFor="q">Search</label><input id="q" value={f.q} onChange={(e) => set("q", e.target.value)} placeholder="Reference, patient or screening" /></div>
        {!preset.status && <div><label htmlFor="st">Status</label>
          <select id="st" value={f.status} onChange={(e) => set("status", e.target.value)}><option value="">All statuses</option>{(meta?.statuses || []).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></div>}
        <div><label htmlFor="ur">Urgency</label>
          <select id="ur" value={f.urgency} onChange={(e) => set("urgency", e.target.value)}><option value="">All</option>{["routine", "soon", "urgent", "critical"].map((u) => <option key={u} value={u}>{u[0].toUpperCase() + u.slice(1)}</option>)}</select></div>
        <label className="check"><input type="checkbox" checked={f.overdue} onChange={(e) => set("overdue", e.target.checked)} />Overdue only</label>
        <label className="check"><input type="checkbox" checked={f.mine} onChange={(e) => set("mine", e.target.checked)} />My cases</label>
      </form>
      <ErrorNote error={error} />
      {!rows && !error ? <Loading /> : rows && (
        <div className="panel flat"><div className="tablewrap"><table>
          <caption className="sr">Screening cases</caption>
          <thead><tr><th>Case</th><th>Patient</th><th>Screening</th><th>Status</th><th>Urgency</th><th>Owner</th><th>Follow-up due</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="7" className="muted">No cases match these filters.</td></tr>}
            {rows.map((c) => (
              <tr key={c.id}>
                <td><Link to={`/cases/${c.id}`}>{c.case_ref}</Link> <OriginBadge origin={c.data_origin} /></td>
                <td>{c.patient_name}</td><td>{c.screening_type}</td><td><StatusPill status={c.status} /></td>
                <td><UrgencyPill urgency={c.urgency} /></td><td>{staff[c.owner_id] || "Unknown"}</td>
                <td className={c.is_overdue ? "due-late" : ""}>{fmtDate(c.follow_up_due)}{c.is_overdue ? " (overdue)" : ""}</td>
              </tr>))}
          </tbody>
        </table></div></div>
      )}
    </>
  );
}
