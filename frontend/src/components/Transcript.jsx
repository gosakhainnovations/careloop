export default function Transcript({ turns }) {
  return (
    <div className="tr" role="log" aria-label="Simulated call transcript">
      <div className="tr-banner">SIMULATION. No real call was made. This shows what the call layer is allowed to say and do.</div>
      {turns.map((t, i) => (
        <div key={i} className={`tr-row ${t.who}`}>
          <span className="tr-who">{t.who === "assistant" ? "Assistant (simulated)" : t.who === "patient" ? "Patient (simulated)" : "System"}</span>
          <div className="tr-bubble">{t.text}</div>
        </div>
      ))}
    </div>
  );
}
