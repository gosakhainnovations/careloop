// Outcome measures computed from the real case timestamps. Pure function: easy to test.
const DAY = 86400000;
const avgDays = (rows, fromFn, toFn) => {
  const v = rows.map((c) => (Date.parse(toFn(c)) - Date.parse(fromFn(c))) / DAY).filter((x) => Number.isFinite(x) && x >= 0);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const tally = (items, labels) => Object.entries(items.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {})).map(([key, count]) => ({ key, label: labels[key] || key, count })).sort((a, b) => b.count - a.count);

const DELAY = { capacity: "Clinic capacity", patient_unavailable: "Patient unavailable", awaiting_documents: "Awaiting documents", transport: "Transport", other: "Other" };
const REJECT = { capacity: "Referral rejected: no capacity", not_clinically_appropriate: "Referral rejected: not clinically appropriate", incomplete_information: "Referral rejected: incomplete information", other: "Referral rejected: other" };
const CLOSE = { patient_declined_documented: "Closed: patient declined", unreachable_after_attempts: "Closed: unreachable after attempts", transferred_elsewhere: "Closed: transferred elsewhere", clinically_not_required: "Closed: clinically not required" };

function computeAnalytics({ cases, referrals, escalations, departments, now = Date.now() }) {
  const today = new Date(now).toISOString().slice(0, 10);
  const active = cases.filter((c) => c.status !== "closed");
  const contacted = cases.filter((c) => c.first_contact_at), acknowledged = cases.filter((c) => c.acknowledged_at);
  const booked = cases.filter((c) => c.consult_booked_at), consulted = cases.filter((c) => c.consult_completed_at);
  const closed = cases.filter((c) => c.status === "closed"), overdue = active.filter((c) => c.follow_up_due && c.follow_up_due < today);
  const refDone = referrals.filter((r) => r.status === "completed");
  const reasons = [
    ...tally(referrals.filter((r) => r.delay_reason_code).map((r) => r.delay_reason_code), DELAY).map((x) => ({ ...x, group: "Delay" })),
    ...tally(referrals.filter((r) => r.rejection_reason_code).map((r) => r.rejection_reason_code), REJECT).map((x) => ({ ...x, group: "Rejection" })),
    ...tally(closed.filter((c) => c.closure_reason && c.closure_reason !== "completed_care").map((c) => c.closure_reason), CLOSE).map((x) => ({ ...x, group: "Drop-off" })),
  ];
  const statusDrop = ["unreachable", "declined"].map((s) => ({ key: s, label: s === "unreachable" ? "Currently unreachable" : "Currently declined", count: cases.filter((c) => c.status === s).length, group: "Drop-off" })).filter((x) => x.count);
  const deptName = Object.fromEntries(departments.map((d) => [d.id, d.name]));
  const byDept = [...new Set(cases.map((c) => c.department_id || ""))].map((id) => {
    const cs = cases.filter((c) => (c.department_id || "") === id);
    return { department: id ? deptName[id] || "Unknown" : "No department", cases: cs.length, contacted: cs.filter((c) => c.first_contact_at).length, consulted: cs.filter((c) => c.consult_completed_at).length, closed: cs.filter((c) => c.status === "closed").length, overdue: cs.filter((c) => c.status !== "closed" && c.follow_up_due && c.follow_up_due < today).length };
  }).sort((a, b) => b.cases - a.cases);
  const reviewed = escalations.filter((e) => e.status === "reviewed" && e.reviewed_at);
  return {
    totals: { cases: cases.length, active: active.length, closed: closed.length, overdue: overdue.length, unresolved: active.length },
    contact: { contacted: contacted.length, contacted_rate: pct(contacted.length, cases.length), acknowledged: acknowledged.length, acknowledgement_rate: pct(acknowledged.length, contacted.length) },
    times: { avg_days_to_notification: avgDays(contacted, (c) => c.screening_date, (c) => c.first_contact_at), avg_days_to_consultation: avgDays(consulted, (c) => c.screening_date, (c) => c.consult_completed_at) },
    consultations: { booked: booked.length, completed: consulted.length },
    referrals: { total: referrals.length, accepted: referrals.filter((r) => r.accepted_at).length, completed: refDone.length, rejected: referrals.filter((r) => r.status === "rejected").length, missed_appointments: referrals.reduce((n, r) => n + (r.missed_count || 0), 0), completion_rate: pct(refDone.length, referrals.length) },
    closure: { closed: closed.length, closed_completed_care: closed.filter((c) => c.closure_reason === "completed_care").length, closure_rate: pct(closed.length, cases.length) },
    escalations: { total: escalations.length, open: escalations.filter((e) => e.status === "open").length, avg_hours_to_review: reviewed.length ? Math.round(reviewed.reduce((n, e) => n + (Date.parse(e.reviewed_at) - Date.parse(e.raised_at)) / 3600000, 0) / reviewed.length * 10) / 10 : null },
    funnel: [["Registered", cases.length], ["Released by clinician", cases.filter((c) => c.released_at).length], ["Patient contacted", contacted.length], ["Acknowledged", acknowledged.length], ["Consultation booked", booked.length], ["Consultation completed", consulted.length], ["Closed", closed.length]].map(([label, count]) => ({ label, count })),
    reasons: [...reasons, ...statusDrop],
    by_department: byDept,
    origin: { live: cases.filter((c) => c.data_origin === "live").length, simulated: cases.filter((c) => c.data_origin === "simulated").length },
  };
}
module.exports = { computeAnalytics };
