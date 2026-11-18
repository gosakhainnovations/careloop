export default function ComingSoon({ title, phase, body }) {
  return (
    <>
      <div className="page-head"><div><h1>{title}</h1><p className="muted">Planned for {phase}. Not available yet.</p></div></div>
      <div className="panel"><p style={{ maxWidth: "62ch" }}>{body}</p></div>
    </>
  );
}
