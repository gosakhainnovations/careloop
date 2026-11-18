import { useEffect, useState } from "react";
import { api } from "../api";
import { ErrorNote, Loading } from "../components/ui";

const PERM_TEXT = {
  "case.view": "View cases", "case.create": "Register cases", "case.update": "Edit case details", "case.transition": "Record contact, booking and consultation outcomes",
  "case.escalate": "Escalate for clinician review", "case.assign": "Transfer case ownership", "case.release": "Release results for patient contact (clinical decision)",
  "case.review": "Review escalations and change clinical details after release", "case.close": "Close cases (clinical decision)",
  "analytics.view": "View analytics", "audit.view": "View the audit log", "staff.view": "View staff", "department.manage": "Manage departments", "note.add": "Add notes",
};

export default function StaffRoles() {
  const [staff, setStaff] = useState(null), [error, setError] = useState("");
  useEffect(() => { api("/staff").then((r) => setStaff(r.staff)).catch((e) => setError(e.message)); }, []);
  if (error) return <ErrorNote error={error} />;
  if (!staff) return <Loading />;
  const roles = [...new Map(staff.map((s) => [s.role, s])).values()];
  return (
    <>
      <div className="page-head"><div><h1>Staff and roles</h1><p className="muted">Staff use their existing Sakha sign-in. Clinical decisions such as releasing a result or closing a case are limited to clinicians.</p></div></div>
      <section className="panel flat"><div className="tablewrap"><table>
        <caption className="sr">Staff with CareLoop access</caption>
        <thead><tr><th>Name</th><th>Email</th><th>CareLoop role</th></tr></thead>
        <tbody>{staff.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.email}</td><td>{s.role_label}</td></tr>)}</tbody>
      </table></div></section>
      {roles.map((r) => (
        <section className="panel" key={r.role}><h2>{r.role_label}: what this role can do</h2>
          <ul>{r.permissions.map((p) => <li key={p}>{PERM_TEXT[p] || p}</li>)}</ul></section>))}
      <p className="muted">Role changes and custom roles per hospital are planned; today roles follow each person's existing account role.</p>
    </>
  );
}
