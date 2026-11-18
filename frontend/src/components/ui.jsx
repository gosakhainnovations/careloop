import { useAuth } from "../auth";

const STATUS_CLASS = {
  pending_clinical_release: "p-wait", released: "p-active", patient_contacted: "p-active", acknowledged: "p-active",
  consult_booked: "p-active", consult_completed: "p-active", referral_completed: "p-done", pending_closure_review: "p-wait",
  closed: "p-done", escalated: "p-crit", unreachable: "p-idle", declined: "p-idle",
};
export function StatusPill({ status }) {
  const { meta } = useAuth();
  const label = meta ? (meta.statuses.find((s) => s.value === status) || {}).label : status;
  return <span className={`pill ${STATUS_CLASS[status] || "p-idle"}`}>{label || status}</span>;
}
const URG = { routine: ["p-idle", "Routine"], soon: ["p-active", "Soon"], urgent: ["p-wait", "Urgent"], critical: ["p-crit", "Critical"] };
export function UrgencyPill({ urgency }) {
  const [cls, label] = URG[urgency] || ["p-idle", urgency];
  return <span className={`pill ${cls}`}>{label}</span>;
}
export const OriginBadge = ({ origin }) => (origin === "simulated" ? <span className="origin">Simulated</span> : null);

export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "Not set");
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
export const ErrorNote = ({ error }) => (error ? <div className="err" role="alert">{error}</div> : null);
export const Loading = () => <p className="muted" role="status">Loading...</p>;

const REF_CLASS = { requested: "p-wait", accepted: "p-active", scheduled: "p-active", attended: "p-active", completed: "p-done", rejected: "p-crit", cancelled: "p-idle" };
const REF_LABEL = { requested: "Requested", accepted: "Accepted", scheduled: "Appointment scheduled", attended: "Attended", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled" };
export const ReferralPill = ({ status }) => <span className={`pill ${REF_CLASS[status] || "p-idle"}`}>{REF_LABEL[status] || status}</span>;
export const REJECT_REASONS = [["capacity", "No capacity"], ["not_clinically_appropriate", "Not clinically appropriate"], ["incomplete_information", "Incomplete information"], ["other", "Other"]];
export const DELAY_REASONS = [["capacity", "Clinic capacity"], ["patient_unavailable", "Patient unavailable"], ["awaiting_documents", "Awaiting documents"], ["transport", "Transport"], ["other", "Other"]];
export const reasonLabel = (list, v) => (list.find(([k]) => k === v) || [])[1] || v;
