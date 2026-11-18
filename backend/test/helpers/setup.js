// Must be required BEFORE any app module: swaps the real Supabase client for the in-memory fake.
process.env.CARELOOP_JWT_SECRET = "test-secret-careloop";
process.env.ENTITLEMENT_TTL_MS = "0";
const path = require("path");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./fakeSupabase");

const fake = createFakeSupabase();
const dbPath = require.resolve(path.join(__dirname, "../../config/db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake };

const { createApp } = require("../../server");
const { signToken } = require("../../middleware/auth");

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const U = {
  coordA: "c0000000-0000-4000-8000-0000000000a1", clinA: "c0000000-0000-4000-8000-0000000000a2",
  adminA: "c0000000-0000-4000-8000-0000000000a3", coordB: "c0000000-0000-4000-8000-0000000000b1",
  clinB: "c0000000-0000-4000-8000-0000000000b2",
};
const tokenFor = (userId, role, businessId, extra = {}) => signToken({ userId, role, businessId, name: role, ...extra });
const tokens = () => ({
  coordA: tokenFor(U.coordA, "receptionist", A), clinA: tokenFor(U.clinA, "doctor", A), adminA: tokenFor(U.adminA, "admin", A),
  coordB: tokenFor(U.coordB, "receptionist", B), clinB: tokenFor(U.clinB, "doctor", B),
});
const baseSeed = () => ({
  businesses: [
    { id: A, business_name: "Hospital A", is_active: true, products: ["careloop"], is_demo: false },
    { id: B, business_name: "Hospital B", is_active: true, products: ["careloop"], is_demo: false },
  ],
  business_users: [
    { id: U.coordA, business_id: A, email: "coord.a@a.test", role: "receptionist", password_hash: "SECRET-HASH" },
    { id: U.clinA, business_id: A, email: "dr.a@a.test", role: "doctor", password_hash: "SECRET-HASH" },
    { id: U.adminA, business_id: A, email: "admin.a@a.test", role: "admin", password_hash: "SECRET-HASH" },
    { id: U.coordB, business_id: B, email: "coord.b@b.test", role: "receptionist", password_hash: "SECRET-HASH" },
    { id: U.clinB, business_id: B, email: "dr.b@b.test", role: "doctor", password_hash: "SECRET-HASH" },
  ],
  cl_departments: [], cl_patients: [], cl_cases: [], cl_case_events: [], cl_audit_log: [],
});
module.exports = { fake, createApp, tokens, tokenFor, baseSeed, A, B, U, jwt };
