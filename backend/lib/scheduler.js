// Runs the follow-up checks for every CareLoop hospital on a timer. Single-instance by design:
// running two backends would double-run the checks, but open tasks are de-duplicated by a unique
// index so it cannot create duplicate reminders.
const db = require("../config/db");
const { runFollowUps } = require("./followups");

function startScheduler(minutes = Number(process.env.FOLLOWUP_INTERVAL_MIN ?? 15)) {
  if (!minutes || minutes <= 0) return null;
  const tick = async () => {
    try {
      const { data } = await db.from("businesses").select("id, products, is_active");
      for (const b of (data || []).filter((x) => x.is_active !== false && (x.products || []).includes("careloop"))) {
        await runFollowUps(b.id).catch((e) => console.error("follow-up run failed", b.id, e.message));
      }
    } catch (e) { console.error("scheduler error", e.message); }
  };
  setTimeout(tick, 15000);
  return setInterval(tick, minutes * 60000);
}
module.exports = { startScheduler };
