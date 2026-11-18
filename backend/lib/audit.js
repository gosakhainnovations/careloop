// Append-only audit trail for sensitive actions (also enforced at DB level by trigger).
// Best-effort: an audit write failure is logged loudly but does not block patient care.
const db = require("../config/db");

async function audit(user, action, entityType, entityId, metadata = {}, ip = null) {
  try {
    const { error } = await db.from("cl_audit_log").insert({
      business_id: user.businessId,
      actor_id: user.userId,
      actor_role: user.role,
      action,
      entity_type: entityType,
      entity_id: entityId,
      ip,
      metadata,
    });
    if (error) console.error("AUDIT WRITE FAILED:", action, error.message);
  } catch (e) {
    console.error("AUDIT WRITE FAILED:", action, e.message);
  }
}

module.exports = { audit };
