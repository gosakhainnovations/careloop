import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorNote } from "./ui";
import Transcript from "./Transcript";

const SCENARIOS = [
  ["acknowledged", "Patient understands and picks an appointment slot"],
  ["question", "Patient asks a medical question (the assistant must not answer)"],
  ["no_answer", "Nobody answers"],
  ["identity_failed", "Date of birth does not match"],
  ["declines", "Patient does not want follow-up"],
];

export default function CallPanel({ c, patient, reload }) {
  const { can } = useAuth();
  const [scenario, setScenario] = useState("acknowledged");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState(null);
  const eligible = ["released", "patient_contacted"].includes(c.status);
  if (!can("case.transition") || (!eligible && !result)) return null;   // keep showing the transcript after the call moves the case on
  const problems = [];
  if (!c.ai_contact_allowed) problems.push("This case is reserved for human handling, so automated contact is switched off.");
  if (patient && (!patient.contact_consent || !(patient.consent_channels || []).includes("voice"))) problems.push("The patient has not agreed to be contacted by phone.");
  if (patient && patient.preferred_language !== "en") problems.push("Arabic voice is not available yet. Contact this patient by staff.");
  if (patient && !patient.date_of_birth) problems.push("A date of birth is needed to verify identity before any health information is shared.");

  const run = async () => {
    setBusy(true); setError(""); setResult(null);
    try { setResult(await api(`/cases/${c.id}/simulate-call`, { method: "POST", body: { scenario } })); await reload(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <section className="panel" aria-labelledby="ch">
      <h2 id="ch">Patient call (simulation)</h2>
      <p className="hint" style={{ marginTop: 0 }}>The assistant checks the patient's date of birth first, then says only the clinician-approved next step, asks the patient to repeat it back, and records the outcome. It never answers medical questions, never decides anything clinical, and only <em>requests</em> a consultation that staff must confirm. Real calls are not built yet.</p>
      <ErrorNote error={error} />
      {!eligible ? null : problems.length > 0 ? <div className="flag" role="note">{problems.map((p) => <div key={p}>{p}</div>)}</div> : (
        <fieldset style={{ border: 0, padding: 0, margin: "0 0 .6rem" }}>
          <legend className="sr">Call scenario</legend>
          {SCENARIOS.map(([v, l]) => <label key={v} className="check" style={{ marginBottom: ".35rem" }}><input type="radio" name="sc" checked={scenario === v} onChange={() => setScenario(v)} />{l}</label>)}
          <button className="primary" onClick={run} disabled={busy} style={{ marginTop: ".5rem" }}>{busy ? "Running..." : "Run simulated call"}</button>
        </fieldset>)}
      {result && (
        <>
          <Transcript turns={result.transcript} />
          <div className="ok" role="status" style={{ marginTop: ".7rem" }}>
            Recorded: {result.steps.map((s) => s.replace(/_/g, " ")).join(", then ")}.
            {result.referral_requested ? " A consultation request was created for staff to confirm." : ""}{result.question_routed ? " The patient's question was routed to staff." : ""}
          </div>
        </>)}
    </section>
  );
}
