import { Router } from "express";
import axios from "axios";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import { startBot, stopBot, getBotStatus, getBotLogs, BOT_DIR } from "./botManager.js";

export const router = Router();

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

// ─── POST /api/bots/start ────────────────────────────────────────────────────
router.post("/start", async (req, res) => {
  const { botId, fileUrl } = req.body;

  if (!botId || !fileUrl) {
    return res.status(400).json({ error: "botId and fileUrl are required" });
  }

  // Sanitize botId to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(botId)) {
    return res.status(400).json({ error: "botId must be alphanumeric (hyphens/underscores allowed)" });
  }

  try {
    // Download zip
    console.log(`[${botId}] Downloading from ${fileUrl}`);
    const response = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      maxContentLength: MAX_FILE_SIZE_BYTES,
      maxBodyLength: MAX_FILE_SIZE_BYTES,
      timeout: 30000,
    });

    const contentLength = parseInt(response.headers["content-length"] || "0");
    if (contentLength > MAX_FILE_SIZE_BYTES) {
      return res.status(413).json({ error: "File too large (max 50MB)" });
    }

    // Extract zip
    const botDir = path.join(BOT_DIR, botId);
    if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true });
    fs.mkdirSync(botDir, { recursive: true });

    const zip = new AdmZip(Buffer.from(response.data));
    zip.extractAllTo(botDir, true);
    console.log(`[${botId}] Extracted to ${botDir}`);

    // Handle zips that contain a single root folder (common pattern)
    const entries = fs.readdirSync(botDir);
    let workDir = botDir;
    if (entries.length === 1) {
      const candidate = path.join(botDir, entries[0]);
      if (fs.statSync(candidate).isDirectory()) {
        workDir = candidate;
      }
    }

    // Start bot
    const pid = await startBot(botId, workDir);

    return res.status(200).json({ success: true, botId, pid, message: "Bot started" });
  } catch (err) {
    console.error(`[${botId}] Start error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bots/stop ─────────────────────────────────────────────────────
router.post("/stop", (req, res) => {
  const { botId } = req.body;

  if (!botId) {
    return res.status(400).json({ error: "botId is required" });
  }

  try {
    stopBot(botId);

    // Clean up bot directory
    const botDir = path.join(BOT_DIR, botId);
    if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true });

    return res.status(200).json({ success: true, botId, message: "Bot stopped" });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});

// ─── GET /api/bots/:botId/status ─────────────────────────────────────────────
router.get("/:botId/status", (req, res) => {
  const { botId } = req.params;
  const status = getBotStatus(botId);
  return res.status(200).json({ botId, ...status });
});

// ─── GET /api/bots/:botId/logs ───────────────────────────────────────────────
router.get("/:botId/logs", (req, res) => {
  const { botId } = req.params;
  const logs = getBotLogs(botId);

  if (!logs.length) {
    return res.status(200).json({ botId, logs: [], message: "No logs yet or bot not found" });
  }

  return res.status(200).json({ botId, logs });
});
