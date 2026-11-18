import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorNote } from "../components/ui";

export default function Settings() {
  const { can } = useAuth();
  const [depts, setDepts] = useState([]), [name, setName] = useState(""), [error, setError] = useState("");
  const load = () => api("/departments").then((r) => setDepts(r.departments)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const add = async (e) => {
    e.preventDefault(); setError("");
    try { await api("/departments", { method: "POST", body: { name } }); setName(""); load(); } catch (err) { setError(err.message); }
  };
  return (
    <>
      <div className="page-head"><div><h1>Settings and integrations</h1></div></div>
      <ErrorNote error={error} />
      <section className="panel" aria-labelledby="dh">
        <h2 id="dh">Departments</h2>
        {depts.length === 0 ? <p className="muted">No departments yet.</p> : <ul>{depts.map((d) => <li key={d.id}>{d.name}</li>)}</ul>}
        {can("department.manage") ? (
          <form onSubmit={add} style={{ display: "flex", gap: ".6rem", alignItems: "flex-end", maxWidth: 480 }}>
            <div style={{ flex: 1 }}><label htmlFor="dn">Add a department</label><input id="dn" value={name} onChange={(e) => setName(e.target.value)} required /></div>
            <button className="primary">Add department</button>
          </form>) : <p className="muted">Only administrators can add departments.</p>}
      </section>
      <section className="panel" aria-labelledby="ih">
        <h2 id="ih">Integrations</h2>
        <p>No hospital information system, laboratory system or FHIR connection is set up. Cases are registered by hand. CareLoop does not claim any integration until one has been built and tested with your systems.</p>
      </section>
    </>
  );
}
