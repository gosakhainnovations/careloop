require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  const allowedOrigins = [
    "http://localhost:5173",
    process.env.FRONTEND_URL,
  ].filter(Boolean);

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (req, res) => res.json({ ok: true, service: "careloop" }));
  app.use("/api/auth", require("./routes/auth"));
  app.use("/api/cases", require("./routes/cases"));
  app.use("/api/referrals", require("./routes/referrals"));
  app.use("/api/escalations", require("./routes/escalations"));
  app.use("/api/followups", require("./routes/followups"));
  app.use("/api/analytics", require("./routes/analytics"));
  app.use("/api/communications", require("./routes/communications"));
  app.use("/api", require("./routes/meta"));
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

  // Serve the built React app (single deployable service).
  const dist = path.join(__dirname, "..", "frontend", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get("*", (req, res) => res.sendFile(path.join(dist, "index.html")));
  }
  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 4000;
  createApp().listen(port, () => console.log(`CareLoop running on port ${port}`));
  require("./lib/scheduler").startScheduler();
}
module.exports = { createApp };
