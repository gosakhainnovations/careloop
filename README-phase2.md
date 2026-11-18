# Sakha AI CareLoop (Phases 1 and 2)

Screening-to-care coordination: makes sure an actionable screening result leads to patient
contact, a completed consultation or referral, and a documented closure by a clinician.

This is a **separate project** from Sakha AI Front Desk. It shares only the Supabase project and
the `businesses` / `business_users` tables (so hospital staff keep their existing logins). It adds
`cl_*` tables and never changes Sakha's tables, apart from two additive columns on `businesses`
(`products`, `is_demo`).

```
GoSakha/
  sakha-ai/     existing Front Desk project
  careloop/     this project
    backend/    Express API (also serves the built UI)
    frontend/   React (Vite) UI
```

## What works (tested)

- Sign in with existing Sakha staff accounts (own token, own secret; Sakha tokens are refused)
- Register screening cases manually; patient, consent, result, authorised interpretation, owner, urgency, deadline
- Case lifecycle with enforced rules: awaiting clinical release, released, contacted, acknowledged,
  booked, consultation completed, referral completed, closure review, closed, plus escalated /
  unreachable / declined
- Clinician-only release and closure; closure needs a reason and written evidence; "care completed"
  needs a recorded consultation; AI/automation can never release, complete a referral or close
- Urgent/critical cases are flagged human-only
- Ownership, ownership transfer with reason, notes, full patient-journey timeline, audit log
- Overview with journey rail and "needs attention", filters, overdue flags, escalations and closure pages
- Staff and roles (read-only), departments, simulated-data labelling, demo seed

**Phase 2 additions**
- Referrals: request, accept, schedule, record attendance (with written evidence), complete (clinician records the outcome),
  reject, cancel, record a delay, record a missed appointment. Reasons are recorded for delays and rejections.
- A booked appointment is never treated as completed: scheduling moves the case to "booked" only; "consultation completed"
  needs attendance evidence on the referral; "referral completed" needs a clinician.
- One open referral per case. While one is open, booking/consultation/completion must go through the referral (so the case and
  referral can never disagree), and the case cannot be closed.
- Rejecting a referral raises a clinical escalation automatically.
- Escalation register: who raised it (staff, AI or system), why, when, which clinician was asked to review, how long it has been
  open, and the documented review that closes it.
- Referral worklist and Overview flag: appointment time passed with no attendance recorded, referral waiting too long for
  acceptance or scheduling, delays.

## Not built yet (shown as "Phase N" in the menu)

AI patient calls and reminders (Phase 3), follow-up rules engine and staff notifications
(Phase 4), analytics (Phase 5), Arabic UI/voice, custom roles per hospital, HIS/FHIR integrations.
Nothing here claims regulatory compliance; that needs review by UAE healthcare counsel.

## Setup

1. **Environment** (`backend/.env`, copy from `.env.example`): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   (same values as Sakha) and a new random `CARELOOP_JWT_SECRET` (must differ from Sakha's `JWT_SECRET`).
2. **Database**: run `backend/migrations/001_careloop_foundation.sql`, then `002_referrals_escalations.sql`, in the Supabase
   SQL editor (staging first). Both are safe to run twice. If you already ran Phase 1, run only 002.
3. **Demo data** (optional): `cd backend && npm install && npm run seed:demo`. Prints three demo logins
   and a password once. Safe to run twice. If the demo hospital already exists (seeded in Phase 1) it is topped up with the Phase 2
   referrals and escalation. To rebuild the demo data from scratch, run `backend/migrations/maintenance/reset_demo.sql` (it refuses to
   touch any hospital not flagged as a demo) and then seed again.
4. **Build the UI**: `npm run build:ui` (from `backend`).
5. **Run**: `npm start` then open http://localhost:4000

Development with hot reload: `npm start` in `backend`, and `npm run dev` in `frontend` (port 5173).

### Deploy (Railway, one service)

Root directory `careloop/backend`, build command `npm install && npm run build:ui`, start command
`npm start`, variables as in step 1. To enable CareLoop for a real hospital:
`update businesses set products = array['frontdesk','careloop'] where id = '...';`

## Roles

Existing `business_users.role` maps to CareLoop roles: `doctor` = Clinician, `receptionist` / `staff` =
Care coordinator, `admin` / `manager` = Administrator. Only clinicians release and close cases.

## Demo story (5 minutes)

Sign in as `dr.demo@careloop-demo.invalid`.
1. Overview: the journey rail and "needs attention". CL-DEMO01 (diabetes, HbA1c 7.4%) was booked, but the appointment time
   passed with no attendance recorded, and the follow-up deadline passed too.
2. Open CL-DEMO01: the timeline shows registration, clinician release, simulated AI call and acknowledgement, referral
   requested, accepted, scheduled, then nothing. Record attendance with evidence, then complete the referral as the clinician.
3. Referrals page: flagged referrals sort first (stalled appointment, delayed referral).
4. Case Closure: open CL-DEMO03, close it as a clinician with evidence (a one-line note is rejected).
5. Register a new case, release it, record contact and acknowledgement, create a referral, then reject it: the case is escalated
   automatically and appears in the Escalations register. Resume it as the clinician with a documented review.
6. Sign in as the coordinator (`coordinator.demo@...`): no Release, Close or Complete-referral options.

All AI steps in the seed are **simulated records**, marked as such. No real call is made in Phase 1.

## Tests

`cd backend && npm test` runs 65 tests (lifecycle and referral rules, permissions, tenant isolation, closure guards,
escalations, auth, seed integrity, a full diabetes journey through the API). Both SQL migrations were run twice on
PostgreSQL 16 and their safety constraints (closure evidence, append-only events/audit log, referral evidence, one open referral
per case) were exercised, as was the demo reset script. `node test/helpers/serveDemo.js 4100` serves the real app on an in-memory database for
browser testing.

## Known limits

- Entitlement (hospital switched off) is checked on every request with a 60 second cache; tokens last 8 hours.
- Login rate limiting is in memory (single instance).
- Appointment times are typed in by staff; CareLoop does not read hospital scheduling systems.
- Escalations raised automatically (rejected referral) have no named reviewer until someone is assigned; staff are not
  notified yet (Phase 4). They appear on the Overview and in the Escalations register.
- Audit writes are best-effort (logged if they fail); the DB blocks edits/deletes of audit rows.
- Tenant isolation is enforced in application code, plus RLS enabled with no public policies on all `cl_*`
  tables. Sakha's own tables are not changed by this project.
