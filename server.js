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

const upload = multer({ dest: "uploads/" });

let botProcess = null;
let botStatus = "idle";
let botLogs = [];
let botStartTime = null;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  botLogs.push(line);
  if (botLogs.length > 200) botLogs.shift();
}

function killBot() {
  if (botProcess) {
    botProcess.kill("SIGTERM");
    botProcess = null;
    botStatus = "stopped";
    log("Bot process killed.");
  }
}

function scheduleAutoStop() {
  setTimeout(() => {
    log("⏰ 24 hours reached. Auto-stopping bot.");
    killBot();
  }, 24 * 60 * 60 * 1000);
}

// Parse a .env file into an object
function parseDotEnv(filePath) {
  const result = {};
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = value;
  }
  return result;
}

app.post("/upload", upload.single("bot"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  // Env vars from dashboard (override .env file if same key)
  let dashboardEnv = {};
  try {
    if (req.body.env) dashboardEnv = JSON.parse(req.body.env);
  } catch { /* ignore */ }

  killBot();
  botLogs = [];
  botStatus = "installing";
  botStartTime = new Date();

  const zipPath = req.file.path;
  const extractDir = path.join("bots", Date.now().toString());

  log(`📦 Received zip: ${req.file.originalname}`);
  log(`📂 Extracting to: ${extractDir}`);

  try {
    await fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();

    fs.unlinkSync(zipPath);

    // Handle nested folder in zip
    let botDir = extractDir;
    const entries = fs.readdirSync(extractDir);
    if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
      botDir = path.join(extractDir, entries[0]);
    }

    if (!fs.existsSync(path.join(botDir, "package.json"))) {
      botStatus = "error";
      return res.status(400).json({ error: "No package.json found in zip." });
    }

    // Load .env from zip if present
    let zipEnv = {};
    const envFilePath = path.join(botDir, ".env");
    if (fs.existsSync(envFilePath)) {
      log("🔍 Found .env in zip — loading...");
      zipEnv = parseDotEnv(envFilePath);
      for (const [key, value] of Object.entries(zipEnv)) {
        const isPlaceholder = value === "" || value.toLowerCase().includes("your_") || value.toLowerCase().includes("_here");
        if (isPlaceholder) {
          log(`⚠️  PLACEHOLDER: ${key}="${value}" — fill this in your .env before zipping!`);
        } else {
          log(`✅ .env loaded: ${key}`);
        }
      }
    } else {
      log("ℹ️  No .env in zip — using dashboard env vars only.");
    }

    // Merge: zip .env is base, dashboard vars override
    const finalEnv = { ...process.env, ...zipEnv, ...dashboardEnv };

    if (Object.keys(dashboardEnv).length > 0) {
      log(`🔑 Dashboard overrides applied for: ${Object.keys(dashboardEnv).join(", ")}`);
    }

    log("📦 Running npm install...");

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

      botProcess = spawn("npm", ["start"], {
        cwd: botDir,
        shell: true,
        env: finalEnv,
      });

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

app.get("/status", (req, res) => {
  const uptime = botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0;
  const timeLeft = botStartTime ? Math.max(0, 86400 - uptime) : 0;
  res.json({ status: botStatus, uptime, timeLeft, logs: botLogs.slice(-50) });
});

app.post("/stop", (req, res) => {
  killBot();
  res.json({ success: true, message: "Bot stopped." });
});

app.get("/", (req, res) => res.json({ ok: true, message: "Bot host running." }));

["uploads", "bots"].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.listen(PORT, () => console.log(`🚀 Bot host server running on port ${PORT}`));
