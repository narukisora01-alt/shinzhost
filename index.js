const express = require("express");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || "changeme";
const BOTS_DIR = path.join(__dirname, "bots");

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

const runningBots = new Map();

function authMiddleware(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.use(authMiddleware);

app.post("/api/bots/start", async (req, res) => {
  const { botId, fileUrl } = req.body;
  if (!botId || !fileUrl) return res.status(400).json({ error: "Missing botId or fileUrl" });

  if (runningBots.has(botId)) {
    return res.status(409).json({ error: "Bot is already running" });
  }

  const botDir = path.join(BOTS_DIR, botId);

  try {
    if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });
    fs.mkdirSync(botDir, { recursive: true });

    console.log(`[${botId}] Downloading zip from ${fileUrl}`);
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Failed to download: ${response.status}`);

    const buffer = await response.buffer();
    const zipPath = path.join(botDir, "bot.zip");
    fs.writeFileSync(zipPath, buffer);

    console.log(`[${botId}] Extracting zip...`);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(botDir, true);
    fs.unlinkSync(zipPath);

    let entryDir = botDir;
    const entries = fs.readdirSync(botDir);
    if (entries.length === 1) {
      const single = path.join(botDir, entries[0]);
      if (fs.statSync(single).isDirectory()) entryDir = single;
    }

    const pkgPath = path.join(entryDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      throw new Error("No package.json found in bot archive");
    }

    console.log(`[${botId}] Installing dependencies...`);
    execSync("npm install --production", { cwd: entryDir, timeout: 120000, stdio: "pipe" });

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    let startCmd = "node index.js";
    if (pkg.scripts?.start) {
      startCmd = pkg.scripts.start;
    } else if (pkg.main) {
      startCmd = `node ${pkg.main}`;
    }

    console.log(`[${botId}] Starting with: ${startCmd}`);
    const [cmd, ...args] = startCmd.split(" ");
    const child = spawn(cmd, args, {
      cwd: entryDir,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    const logs = [];
    const maxLogs = 500;

    const pushLog = (type, data) => {
      const line = { type, message: data.toString().trim(), timestamp: new Date().toISOString() };
      logs.push(line);
      if (logs.length > maxLogs) logs.shift();
      console.log(`[${botId}][${type}] ${line.message}`);
    };

    child.stdout.on("data", (data) => pushLog("stdout", data));
    child.stderr.on("data", (data) => pushLog("stderr", data));

    child.on("exit", (code, signal) => {
      pushLog("system", `Process exited with code ${code}, signal ${signal}`);
      runningBots.delete(botId);
    });

    child.on("error", (err) => {
      pushLog("system", `Process error: ${err.message}`);
      runningBots.delete(botId);
    });

    runningBots.set(botId, { process: child, logs, startedAt: Date.now(), entryDir });

    res.json({ success: true, message: "Bot started" });
  } catch (err) {
    console.error(`[${botId}] Start error:`, err.message);
    if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bots/stop", (req, res) => {
  const { botId } = req.body;
  if (!botId) return res.status(400).json({ error: "Missing botId" });

  const bot = runningBots.get(botId);
  if (!bot) return res.status(404).json({ error: "Bot is not running" });

  try {
    bot.process.kill("SIGTERM");
    setTimeout(() => {
      try { bot.process.kill("SIGKILL"); } catch (_) {}
    }, 5000);
    runningBots.delete(botId);
    res.json({ success: true, message: "Bot stopped" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/bots/:botId/status", (req, res) => {
  const bot = runningBots.get(req.params.botId);
  if (!bot) return res.json({ running: false });

  res.json({
    running: true,
    uptime: Math.floor((Date.now() - bot.startedAt) / 1000),
    pid: bot.process.pid,
  });
});

app.get("/api/bots/:botId/logs", (req, res) => {
  const bot = runningBots.get(req.params.botId);
  if (!bot) return res.json({ logs: [] });
  res.json({ logs: bot.logs.slice(-100) });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", runningBots: runningBots.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));
