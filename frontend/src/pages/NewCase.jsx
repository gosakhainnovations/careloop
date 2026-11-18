import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorNote } from "../components/ui";

const CHANNELS = [["voice", "Phone call"], ["sms", "SMS"], ["whatsapp", "WhatsApp"], ["email", "Email"]];
const today = new Date().toISOString().slice(0, 10);

export default function NewCase() {
  const nav = useNavigate();
  const { user, meta } = useAuth();
  const [depts, setDepts] = useState([]), [staff, setStaff] = useState([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [p, setP] = useState({ full_name: "", phone: "", email: "", date_of_birth: "", preferred_language: "en", contact_consent: false, consent_channels: [] });
  const [c, setC] = useState({ screening_type: "", screening_date: today, result_summary: "", clinical_interpretation: "", recommended_next_step: "", department_id: "", urgency: "routine", follow_up_due: "", owner_id: user.id });
  useEffect(() => {
    api("/departments").then((r) => setDepts(r.departments)).catch(() => {});
    api("/staff").then((r) => setStaff(r.staff)).catch(() => {});
  }, []);
  const toggleCh = (v) => setP((x) => ({ ...x, consent_channels: x.consent_channels.includes(v) ? x.consent_channels.filter((y) => y !== v) : [...x.consent_channels, v] }));

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const body = { ...c, department_id: c.department_id || undefined, follow_up_due: c.follow_up_due || undefined, patient: p };
      const r = await api("/cases", { method: "POST", body });
      nav(`/cases/${r.case.id}`);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <>
      <div className="page-head"><div><h1>Register a screening case</h1>
        <p className="muted">{user.business.is_demo ? "This workspace is a simulation. Use synthetic patient details only." : "Enter the result and the interpretation authorised by the clinician."}</p></div>
        <Link className="btn" to="/cases">Cancel</Link></div>
      <form onSubmit={submit}>
        <ErrorNote error={error} />
        <fieldset className="panel" style={{ border: "1px solid var(--line)" }}>
          <legend><strong>Patient</strong></legend>
          <div className="grid2">
            <div className="field"><label htmlFor="pn">Full name</label><input id="pn" value={p.full_name} onChange={(e) => setP({ ...p, full_name: e.target.value })} required /></div>
            <div className="field"><label htmlFor="dob">Date of birth</label><input id="dob" type="date" max={today} value={p.date_of_birth} onChange={(e) => setP({ ...p, date_of_birth: e.target.value })} />
              <p className="hint">Used to verify identity before any health information is shared.</p></div>
            <div className="field"><label htmlFor="ph">Phone</label><input id="ph" type="tel" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /></div>
            <div className="field"><label htmlFor="em">Email</label><input id="em" type="email" value={p.email} onChange={(e) => setP({ ...p, email: e.target.value })} /></div>
            <div className="field"><label htmlFor="lg">Preferred language</label><select id="lg" value={p.preferred_language} onChange={(e) => setP({ ...p, preferred_language: e.target.value })}><option value="en">English</option><option value="ar">Arabic</option></select></div>
          </div>
          <label className="check"><input type="checkbox" checked={p.contact_consent} onChange={(e) => setP({ ...p, contact_consent: e.target.checked, consent_channels: e.target.checked ? p.consent_channels : [] })} />The patient agreed to be contacted about their result</label>
          {p.contact_consent && <div role="group" aria-label="Contact channels the patient agreed to" style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap", margin: ".6rem 0 0 1.5rem" }}>
            {CHANNELS.map(([v, l]) => <label key={v} className="check"><input type="checkbox" checked={p.consent_channels.includes(v)} onChange={() => toggleCh(v)} />{l}</label>)}</div>}
        </fieldset>

        <fieldset className="panel" style={{ border: "1px solid var(--line)" }}>
          <legend><strong>Screening result</strong></legend>
          <div className="grid2">
            <div className="field"><label htmlFor="st">Screening type</label><select id="st" value={c.screening_type} onChange={(e) => setC({ ...c, screening_type: e.target.value })} required><option value="">Choose a type</option>{(meta?.screening_types || []).map((t) => <option key={t}>{t}</option>)}</select></div>
            <div className="field"><label htmlFor="sd">Screening date</label><input id="sd" type="date" max={today} value={c.screening_date} onChange={(e) => setC({ ...c, screening_date: e.target.value })} required /></div>
          </div>
          <div className="field"><label htmlFor="rs">Result</label><textarea id="rs" value={c.result_summary} onChange={(e) => setC({ ...c, result_summary: e.target.value })} required /></div>
          <div className="field"><label htmlFor="ci">Authorised clinical interpretation</label><textarea id="ci" value={c.clinical_interpretation} onChange={(e) => setC({ ...c, clinical_interpretation: e.target.value })} />
            <p className="hint">Copy what the responsible clinician approved. CareLoop never writes or changes clinical interpretations. A clinician must release the case before the patient is contacted.</p></div>
          <div className="field"><label htmlFor="ns">Recommended next step</label><input id="ns" value={c.recommended_next_step} onChange={(e) => setC({ ...c, recommended_next_step: e.target.value })} /></div>
        </fieldset>

        <fieldset className="panel" style={{ border: "1px solid var(--line)" }}>
          <legend><strong>Ownership and timing</strong></legend>
          <div className="grid3">
            <div className="field"><label htmlFor="dp">Department</label><select id="dp" value={c.department_id} onChange={(e) => setC({ ...c, department_id: e.target.value })}><option value="">Not assigned</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
            <div className="field"><label htmlFor="ow">Accountable owner</label><select id="ow" value={c.owner_id} onChange={(e) => setC({ ...c, owner_id: e.target.value })}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.role_label})</option>)}</select></div>
            <div className="field"><label htmlFor="ur">Urgency</label><select id="ur" value={c.urgency} onChange={(e) => setC({ ...c, urgency: e.target.value })}><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent (human handling only)</option><option value="critical">Critical (human handling only)</option></select></div>
          </div>
          <div className="field" style={{ maxWidth: 260 }}><label htmlFor="fu">Follow-up deadline</label><input id="fu" type="date" min={c.screening_date} value={c.follow_up_due} onChange={(e) => setC({ ...c, follow_up_due: e.target.value })} /></div>
        </fieldset>
        <button className="primary" disabled={busy}>{busy ? "Saving..." : "Register case"}</button>
      </form>
    </>
  );
}
