import { spawn, exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execAsync = promisify(exec);

// Map<botId, { process, startedAt, logs: string[] }>
const bots = new Map();

const MAX_LOG_LINES = 100;
const BOT_DIR = process.env.BOT_DIR || "/tmp/bots";

function getBotDir(botId) {
  return path.join(BOT_DIR, botId);
}

function appendLog(botId, data) {
  if (!bots.has(botId)) return;
  const entry = bots.get(botId);
  const lines = data.toString().split("\n").filter(Boolean);
  entry.logs.push(...lines);
  if (entry.logs.length > MAX_LOG_LINES) {
    entry.logs = entry.logs.slice(-MAX_LOG_LINES);
  }
}

export async function startBot(botId, extractedDir) {
  if (bots.has(botId)) {
    throw new Error(`Bot ${botId} is already running`);
  }

  // Run npm install first
  console.log(`[${botId}] Running npm install...`);
  await execAsync("npm install --omit=dev", { cwd: extractedDir });

  // Determine entry point
  let entryPoint = "index.js";
  const pkgPath = path.join(extractedDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.scripts?.start) {
        // Use npm start
        entryPoint = null;
      } else if (pkg.main) {
        entryPoint = pkg.main;
      }
    } catch (_) {}
  }

  const proc = entryPoint
    ? spawn("node", [entryPoint], { cwd: extractedDir })
    : spawn("npm", ["start"], { cwd: extractedDir, shell: true });

  const entry = {
    process: proc,
    startedAt: Date.now(),
    logs: [],
    exitCode: null,
  };

  bots.set(botId, entry);

  proc.stdout.on("data", (d) => appendLog(botId, d));
  proc.stderr.on("data", (d) => appendLog(botId, `[stderr] ${d}`));

  proc.on("exit", (code) => {
    console.log(`[${botId}] Process exited with code ${code}`);
    if (bots.has(botId)) {
      bots.get(botId).exitCode = code;
      bots.get(botId).process = null;
    }
  });

  console.log(`[${botId}] Bot started (pid ${proc.pid})`);
  return proc.pid;
}

export function stopBot(botId) {
  const entry = bots.get(botId);
  if (!entry || !entry.process) {
    throw new Error(`Bot ${botId} is not running`);
  }
  entry.process.kill("SIGTERM");
  bots.delete(botId);
  console.log(`[${botId}] Bot stopped`);
}

export function getBotStatus(botId) {
  const entry = bots.get(botId);
  if (!entry) return { running: false, uptime: 0 };

  const running = entry.process !== null && entry.exitCode === null;
  const uptime = running ? Math.floor((Date.now() - entry.startedAt) / 1000) : 0;
  return { running, uptime, pid: entry.process?.pid ?? null };
}

export function getBotLogs(botId) {
  const entry = bots.get(botId);
  if (!entry) return [];
  return entry.logs;
}

export function getBotDir2(botId) {
  return getBotDir(botId);
}

export { BOT_DIR };
