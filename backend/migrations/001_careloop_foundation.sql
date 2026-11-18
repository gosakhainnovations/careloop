-- ============================================================
-- CareLoop 001 - foundation (idempotent, additive only)
-- Creates cl_* tables only. Existing Sakha AI tables are not altered,
-- except two additive columns on businesses (safe defaults).
-- Run in the Supabase SQL editor (staging first).
-- ============================================================

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS products text[] NOT NULL DEFAULT ARRAY['frontdesk']::text[];
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- ---------- departments ----------
CREATE TABLE IF NOT EXISTS cl_departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
);

-- ---------- patients (data minimisation: no national ID numbers) ----------
CREATE TABLE IF NOT EXISTS cl_patients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id),
  full_name           text NOT NULL,
  phone               text,
  email               text,
  date_of_birth       date,                    -- used for identity verification before any health info is shared
  preferred_language  text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en','ar')),
  contact_consent     boolean NOT NULL DEFAULT false,
  consent_channels    text[] NOT NULL DEFAULT '{}',
  consent_recorded_at timestamptz,
  external_ref        text,                    -- hospital MRN / lab ID, for future HIS/FHIR linking
  data_origin         text NOT NULL DEFAULT 'live' CHECK (data_origin IN ('live','simulated')),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------- cases ----------
CREATE TABLE IF NOT EXISTS cl_cases (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id             uuid NOT NULL REFERENCES businesses(id),
  case_ref                text NOT NULL,
  patient_id              uuid NOT NULL REFERENCES cl_patients(id),
  screening_type          text NOT NULL,
  screening_date          date NOT NULL,
  result_summary          text NOT NULL,
  clinical_interpretation text,                -- authorised by a clinician; AI never writes this
  recommended_next_step   text,
  department_id           uuid REFERENCES cl_departments(id),
  owner_id                uuid NOT NULL,       -- accountable staff member (business_users.id; no FK so Sakha user management is unaffected)
  urgency                 text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine','soon','urgent','critical')),
  ai_contact_allowed      boolean NOT NULL DEFAULT true,
  follow_up_due           date,
  status                  text NOT NULL DEFAULT 'pending_clinical_release' CHECK (status IN (
    'pending_clinical_release','released','patient_contacted','acknowledged','consult_booked',
    'consult_completed','referral_completed','pending_closure_review','closed','escalated','unreachable','declined')),
  status_changed_at       timestamptz NOT NULL DEFAULT now(),
  released_at             timestamptz,
  first_contact_at        timestamptz,
  acknowledged_at         timestamptz,
  consult_booked_at       timestamptz,
  consult_completed_at    timestamptz,
  closed_at               timestamptz,
  closure_reason          text CHECK (closure_reason IN ('completed_care','patient_declined_documented','unreachable_after_attempts','transferred_elsewhere','clinically_not_required')),
  closure_evidence        text,
  closed_by               uuid,
  data_origin             text NOT NULL DEFAULT 'live' CHECK (data_origin IN ('live','simulated')),
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, case_ref),
  -- Defence in depth: a case cannot be closed without a reason, written evidence and a closer.
  CONSTRAINT cl_closed_requires_evidence CHECK (
    status <> 'closed' OR (
      closure_reason IS NOT NULL AND closed_by IS NOT NULL AND closed_at IS NOT NULL
      AND length(btrim(coalesce(closure_evidence,''))) >= 10)
  )
);
CREATE INDEX IF NOT EXISTS idx_cl_cases_tenant_status ON cl_cases (business_id, status);
CREATE INDEX IF NOT EXISTS idx_cl_cases_tenant_owner  ON cl_cases (business_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_cl_cases_tenant_due    ON cl_cases (business_id, follow_up_due);
CREATE INDEX IF NOT EXISTS idx_cl_cases_patient       ON cl_cases (patient_id);

-- ---------- case events (patient journey timeline; append-only) ----------
CREATE TABLE IF NOT EXISTS cl_case_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  case_id     uuid NOT NULL REFERENCES cl_cases(id),
  event_type  text NOT NULL,
  from_status text,
  to_status   text,
  actor_type  text NOT NULL CHECK (actor_type IN ('staff','ai','system')),
  actor_id    uuid,
  actor_name  text,
  note        text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_events_case ON cl_case_events (business_id, case_id, created_at);

-- ---------- audit log (append-only) ----------
CREATE TABLE IF NOT EXISTS cl_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  entity_type text,
  entity_id   uuid,
  ip          text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_audit_tenant_time ON cl_audit_log (business_id, created_at DESC);

-- ---------- immutability for events and audit ----------
CREATE OR REPLACE FUNCTION cl_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cl_events_immutable ON cl_case_events;
CREATE TRIGGER cl_events_immutable BEFORE UPDATE OR DELETE ON cl_case_events
  FOR EACH ROW EXECUTE FUNCTION cl_block_mutation();
DROP TRIGGER IF EXISTS cl_audit_immutable ON cl_audit_log;
CREATE TRIGGER cl_audit_immutable BEFORE UPDATE OR DELETE ON cl_audit_log
  FOR EACH ROW EXECUTE FUNCTION cl_block_mutation();

-- ---------- row level security ----------
-- Enabled with NO policies: the public/anon API key can read nothing.
-- The CareLoop backend uses the service key (bypasses RLS) and enforces tenancy itself.
ALTER TABLE cl_departments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cl_patients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cl_cases        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cl_case_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cl_audit_log    ENABLE ROW LEVEL SECURITY;
