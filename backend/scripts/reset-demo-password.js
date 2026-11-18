
require("dotenv").config();

const bcrypt = require("bcryptjs");
const db = require("../config/db");

async function resetDemoPassword() {
  const password = process.env.DEMO_PASSWORD;

  if (!password || password.length < 10) {
    throw new Error("Set DEMO_PASSWORD in backend/.env (minimum 10 characters).");
  }

  const { data: hospital, error: hospitalError } = await db
    .from("businesses")
    .select("id")
    .eq("phone_number", "DEMO-CARELOOP-0001")
    .maybeSingle();

  if (hospitalError) throw hospitalError;
  if (!hospital) throw new Error("Demo hospital not found.");

  const hash = await bcrypt.hash(password, 10);

  const emails = [
    "dr.demo@careloop-demo.invalid",
    "coordinator.demo@careloop-demo.invalid",
    "admin.demo@careloop-demo.invalid",
  ];

  for (const email of emails) {
    const { data, error } = await db
      .from("business_users")
      .update({ password_hash: hash })
      .eq("business_id", hospital.id)
      .eq("email", email)
      .select("email");

    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error(`Demo user not found: ${email}`);
    }

    console.log("Password updated:", email);
  }

  console.log("All demo account passwords updated successfully.");
}

resetDemoPassword()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
