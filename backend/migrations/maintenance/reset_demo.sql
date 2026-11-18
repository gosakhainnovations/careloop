-- ============================================================
-- Removes the SIMULATED demo hospital and all of its CareLoop data so it can be re-seeded.
-- Refuses to touch any hospital that is not flagged is_demo = true.
-- CareLoop's events and audit log are append-only, so this temporarily disables those two
-- triggers inside one transaction. Run in the Supabase SQL editor, as the project owner.
-- Afterwards run:  npm run seed:demo
-- ============================================================
BEGIN;
DO $$
DECLARE b uuid;
BEGIN
  SELECT id INTO b FROM businesses WHERE phone_number = 'DEMO-CARELOOP-0001' AND is_demo = true;
  IF b IS NULL THEN RAISE NOTICE 'No demo hospital found - nothing to do.'; RETURN; END IF;

  ALTER TABLE cl_case_events DISABLE TRIGGER cl_events_immutable;
  ALTER TABLE cl_audit_log   DISABLE TRIGGER cl_audit_immutable;

  DELETE FROM cl_escalations WHERE business_id = b;
  DELETE FROM cl_referrals   WHERE business_id = b;
  DELETE FROM cl_case_events WHERE business_id = b;
  DELETE FROM cl_audit_log   WHERE business_id = b;
  DELETE FROM cl_cases       WHERE business_id = b;
  DELETE FROM cl_patients    WHERE business_id = b;
  DELETE FROM cl_departments WHERE business_id = b;
  DELETE FROM business_users WHERE business_id = b;
  DELETE FROM businesses     WHERE id = b;

  ALTER TABLE cl_case_events ENABLE TRIGGER cl_events_immutable;
  ALTER TABLE cl_audit_log   ENABLE TRIGGER cl_audit_immutable;
  RAISE NOTICE 'Demo hospital removed.';
END $$;
COMMIT;
