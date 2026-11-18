// Dev/QA helper: runs the REAL app (API + built UI) against the in-memory fake DB seeded with the demo data.
// Used for browser testing only. Never connects to Supabase.  node test/helpers/serveDemo.js [port]
const { fake, createApp } = require("./setup");
const { seedDemo } = require("../../scripts/seed-demo");
seedDemo(fake, { password: "Demo-Pass-123!" }).then(async (r) => {
  await require("../../lib/followups").runFollowUps(r.businessId);
  const port = process.argv[2] || 4100;
  createApp().listen(port, () => console.log("demo server on " + port));
});
