import { useState } from "react";
import { useAuth } from "../auth";
import { ErrorNote } from "../components/ui";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError("");
    try { await login(email, password); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <section className="intro">
        <h1>Make sure every actionable screening result reaches care.</h1>
        <p>CareLoop tracks each result from registration to documented closure, with a named owner on every case and a clinician deciding when a case is done.</p>
      </section>
      <section className="form">
        <form onSubmit={submit} aria-labelledby="signin">
          <h2 id="signin">Sign in to CareLoop</h2>
          <ErrorNote error={error} />
          <div className="field"><label htmlFor="email">Work email</label><input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label htmlFor="pw">Password</label><input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          <button className="primary" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
        </form>
      </section>
    </div>
  );
}
