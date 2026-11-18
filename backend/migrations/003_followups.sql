-- CareLoop 003 - follow-up engine (idempotent, additive). Requires 001 and 002.
CREATE TABLE IF NOT EXISTS cl_followup_rules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id             uuid NOT NULL REFERENCES businesses(id),
  rule_key                text NOT NULL,
  enabled                 boolean NOT NULL DEFAULT true,
  reminder_after_days     integer NOT NULL CHECK (reminder_after_days BETWEEN 0 AND 90),
  escalate_enabled        boolean NOT NULL DEFAULT false,   -- automatic escalation: needs a clinician's authorisation
  escalate_after_days     integer CHECK (escalate_after_days BETWEEN 0 AND 180),
  escalation_authorised_by uuid,
  escalation_authorised_at timestamptz,
  updated_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, rule_key),
  CONSTRAINT cl_rule_escalation_authorised CHECK (NOT escalate_enabled
    OR (escalate_after_days IS NOT NULL AND escalation_authorised_by IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS cl_followup_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  case_id       uuid NOT NULL REFERENCES cl_cases(id),
  rule_key      text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('reminder','escalation')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  message       text NOT NULL,
  assigned_to   uuid,
  resolution    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  data_origin   text NOT NULL DEFAULT 'live' CHECK (data_origin IN ('live','simulated'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_task_one_open ON cl_followup_tasks (case_id, rule_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_cl_task_tenant ON cl_followup_tasks (business_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS cl_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  user_id     uuid NOT NULL,
  case_id     uuid REFERENCES cl_cases(id),
  task_id     uuid REFERENCES cl_followup_tasks(id),
  kind        text NOT NULL CHECK (kind IN ('reminder','escalation')),
  title       text NOT NULL,
  body        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_cl_notif_user ON cl_notifications (business_id, user_id, read_at, created_at DESC);
ALTER TABLE cl_followup_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE cl_followup_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cl_notifications  ENABLE ROW LEVEL SECURITY;
