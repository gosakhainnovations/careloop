// Maps the existing Sakha business_users.role values onto CareLoop roles, so no
// change to the shared users table is needed. A configurable per-tenant role
// table can replace this later without touching the route code (routes only
// ever check permission strings).
const ROLE_TO_CL = {
  admin: "cl_admin",
  manager: "cl_admin",
  receptionist: "care_coordinator",
  staff: "care_coordinator",
  doctor: "clinician",
};

const PERMS = {
  care_coordinator: ["case.view", "case.create", "case.update", "case.transition", "case.escalate", "referral.create", "referral.update", "note.add"],
  clinician: [
    "case.view", "case.create", "case.update", "case.transition", "case.escalate", "case.assign",
    "case.release", "case.review", "case.close", "referral.create", "referral.update", "followup.configure", "analytics.view", "note.add",
  ],
  cl_admin: [
    "case.view", "case.create", "case.update", "case.transition", "case.escalate", "case.assign",
    "referral.create", "referral.update", "followup.configure", "analytics.view", "audit.view", "staff.view", "department.manage", "note.add",
  ],
};

const CL_ROLE_LABELS = {
  care_coordinator: "Care coordinator",
  clinician: "Clinician",
  cl_admin: "Administrator",
};

const clRoleFor = (role) => ROLE_TO_CL[role] || null;
const permsFor = (role) => PERMS[clRoleFor(role)] || [];

module.exports = { ROLE_TO_CL, PERMS, CL_ROLE_LABELS, clRoleFor, permsFor };
