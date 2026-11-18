-- ============================================================
-- CareLoop 002 - referrals and escalation register (idempotent, additive only)
-- Requires 001. Run in the Supabase SQL editor (staging first).
-- ============================================================

CREATE TABLE IF NOT EXISTS cl_referrals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL REFERENCES businesses(id),
  case_id               uuid NOT NULL REFERENCES cl_cases(id),
  department_id         uuid NOT NULL REFERENCES cl_departments(id),
  assigned_to           uuid,                         -- receiving clinician (business_users.id)
  reason                text NOT NULL,                -- from the authorised clinical instruction
  status                text NOT NULL DEFAULT 'requested' CHECK (status IN
                          ('requested','accepted','scheduled','attended','completed','rejected','cancelled')),
  requested_by          uuid,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at           timestamptz,
  accepted_by           uuid,
  scheduled_for         timestamptz,
  scheduled_by          uuid,
  attended_at           timestamptz,
  attended_note         text,                         -- evidence the patient was actually seen
  completed_at          timestamptz,
  completed_by          uuid,
  outcome_note          text,
  rejection_reason_code text CHECK (rejection_reason_code IN ('capacity','not_clinically_appropriate','incomplete_information','other')),
  rejection_note        text,
  delay_reason_code     text CHECK (delay_reason_code IN ('capacity','patient_unavailable','awaiting_documents','transport','other')),
  delay_note            text,
  delayed_at            timestamptz,
  missed_count          integer NOT NULL DEFAULT 0,
  cancelled_note        text,
  data_origin           text NOT NULL DEFAULT 'live' CHECK (data_origin IN ('live','simulated')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- A booked appointment is not a completed referral:
  CONSTRAINT cl_ref_scheduled_needs_time CHECK (status <> 'scheduled' OR scheduled_for IS NOT NULL),
  CONSTRAINT cl_ref_attended_needs_evidence CHECK (status NOT IN ('attended','completed')
    OR (attended_at IS NOT NULL AND length(btrim(coalesce(attended_note,''))) >= 3)),
  CONSTRAINT cl_ref_completed_needs_outcome CHECK (status <> 'completed'
    OR (completed_at IS NOT NULL AND completed_by IS NOT NULL AND length(btrim(coalesce(outcome_note,''))) >= 3)),
  CONSTRAINT cl_ref_rejected_needs_reason CHECK (status <> 'rejected' OR rejection_reason_code IS NOT NULL)
);
-- At most one open referral per case.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_ref_one_open ON cl_referrals (case_id)
  WHERE status IN ('requested','accepted','scheduled','attended');
CREATE INDEX IF NOT EXISTS idx_cl_ref_tenant_status ON cl_referrals (business_id, status);
CREATE INDEX IF NOT EXISTS idx_cl_ref_case ON cl_referrals (case_id);

CREATE TABLE IF NOT EXISTS cl_escalations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id),
  case_id           uuid NOT NULL REFERENCES cl_cases(id),
  raised_from_status text,
  raised_by_type    text NOT NULL CHECK (raised_by_type IN ('staff','ai','system')),
  raised_by_id      uuid,
  raised_by_name    text,
  reason            text NOT NULL,
  assigned_to       uuid,                             -- clinician asked to review
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed')),
  raised_at         timestamptz NOT NULL DEFAULT now(),
  reviewed_at       timestamptz,
  reviewed_by       uuid,
  review_note       text,                             -- the documented clinical review
  resumed_to        text,
  data_origin       text NOT NULL DEFAULT 'live' CHECK (data_origin IN ('live','simulated')),
  CONSTRAINT cl_esc_reviewed_needs_note CHECK (status <> 'reviewed'
    OR (reviewed_at IS NOT NULL AND length(btrim(coalesce(review_note,''))) >= 3))
);
CREATE INDEX IF NOT EXISTS idx_cl_esc_tenant_status ON cl_escalations (business_id, status, raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_cl_esc_case ON cl_escalations (case_id);

ALTER TABLE cl_referrals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cl_escalations ENABLE ROW LEVEL SECURITY;
