const express = require("express");
const multer = require("multer");
const unzipper = require("unzipper");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Upload storage
const upload = multer({ dest: "uploads/" });

// Track running bot process
let botProcess = null;
let botStatus = "idle"; // idle | installing | running | error | stopped
let botLogs = [];
let botStartTime = null;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  botLogs.push(line);
  if (botLogs.length > 200) botLogs.shift(); // keep last 200 lines
}

function killBot() {
  if (botProcess) {
    botProcess.kill("SIGTERM");
    botProcess = null;
    botStatus = "stopped";
    log("Bot process killed.");
  }
}

// Auto-stop after 24 hours
function scheduleAutoStop() {
  setTimeout(() => {
    log("⏰ 24 hours reached. Auto-stopping bot.");
    killBot();
  }, 24 * 60 * 60 * 1000);
}

// POST /upload — accepts a .zip file, extracts + runs npm install + npm start
app.post("/upload", upload.single("bot"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  // Kill existing bot if running
  killBot();
  botLogs = [];
  botStatus = "installing";
  botStartTime = new Date();

  const zipPath = req.file.path;
  const extractDir = path.join("bots", Date.now().toString());

  log(`📦 Received zip: ${req.file.originalname}`);
  log(`📂 Extracting to: ${extractDir}`);

  try {
    // Extract ZIP
    await fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();

    fs.unlinkSync(zipPath); // clean up upload

    // Find the actual bot folder (handle nested zip structure)
    let botDir = extractDir;
    const entries = fs.readdirSync(extractDir);
    if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
      botDir = path.join(extractDir, entries[0]);
    }

    // Check for package.json
    if (!fs.existsSync(path.join(botDir, "package.json"))) {
      botStatus = "error";
      return res.status(400).json({ error: "No package.json found in zip." });
    }

    log("📦 Running npm install...");

    // npm install
    const install = spawn("npm", ["install"], { cwd: botDir, shell: true });

    install.stdout.on("data", (d) => log(`[npm install] ${d.toString().trim()}`));
    install.stderr.on("data", (d) => log(`[npm install ERR] ${d.toString().trim()}`));

    install.on("close", (code) => {
      if (code !== 0) {
        botStatus = "error";
        log(`❌ npm install failed with code ${code}`);
        return;
      }

      log("✅ npm install done. Starting bot...");
      botStatus = "running";

      // npm start
      botProcess = spawn("npm", ["start"], { cwd: botDir, shell: true });

      botProcess.stdout.on("data", (d) => log(`[bot] ${d.toString().trim()}`));
      botProcess.stderr.on("data", (d) => log(`[bot ERR] ${d.toString().trim()}`));

      botProcess.on("close", (exitCode) => {
        log(`⚠️ Bot exited with code ${exitCode}`);
        botStatus = exitCode === 0 ? "stopped" : "error";
        botProcess = null;
      });

      scheduleAutoStop();
    });

    res.json({ success: true, message: "Bot uploading and starting..." });

  } catch (err) {
    botStatus = "error";
    log(`❌ Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /status — returns current bot status + logs
app.get("/status", (req, res) => {
  const uptime = botStartTime
    ? Math.floor((Date.now() - botStartTime) / 1000)
    : 0;

  const timeLeft = botStartTime
    ? Math.max(0, 86400 - uptime)
    : 0;

  res.json({
    status: botStatus,
    uptime,
    timeLeft,
    logs: botLogs.slice(-50), // last 50 lines
  });
});

// POST /stop — manually stop the bot
app.post("/stop", (req, res) => {
  killBot();
  res.json({ success: true, message: "Bot stopped." });
});

// Health check
app.get("/", (req, res) => res.json({ ok: true, message: "Bot host running." }));

// Create necessary folders
["uploads", "bots"].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.listen(PORT, () => console.log(`🚀 Bot host server running on port ${PORT}`));
