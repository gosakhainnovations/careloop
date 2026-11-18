import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { OriginBadge, ErrorNote, Loading, fmtDateTime } from "../components/ui";
import Transcript from "../components/Transcript";

export default function Communications() {
  const [rows, setRows] = useState(null), [error, setError] = useState("");
  useEffect(() => { api("/communications").then((r) => setRows(r.events)).catch((e) => setError(e.message)); }, []);
  return (
    <>
      <div className="page-head"><div><h1>Patient communication</h1><p className="muted">Every action taken by the AI assistant, and the call transcript where there is one. Real calls are not built yet: these are labelled simulations.</p></div></div>
      <ErrorNote error={error} />
      {!rows && !error ? <Loading /> : rows && (
        <div className="panel flat"><div className="tablewrap"><table>
          <caption className="sr">AI assistant actions</caption>
          <thead><tr><th>When</th><th>Case</th><th>Patient</th><th>What happened</th><th>Transcript</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="5" className="muted">No AI actions yet. Open a released case and run a simulated call.</td></tr>}
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{fmtDateTime(e.created_at)}</td>
                <td><Link to={`/cases/${e.case_id}`}>{e.case_ref}</Link> <OriginBadge origin={e.data_origin} /></td>
                <td>{e.patient_name}</td>
                <td>{e.note}{e.simulated && <span className="origin" style={{ marginLeft: ".4rem" }}>Simulated</span>}</td>
                <td>{e.transcript ? <details><summary>View transcript</summary><Transcript turns={e.transcript} /></details> : <span className="muted">None</span>}</td>
              </tr>))}
          </tbody>
        </table></div></div>)}
    </>
  );
}
