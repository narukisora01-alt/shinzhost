import express from "express";
import { router } from "./routes.js";

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — allow requests from any origin (including Lovable)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

app.use(express.json());

// API key middleware
app.use((req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing x-api-key" });
  }
  next();
});

app.use("/api/bots", router);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.listen(PORT, () => {
  console.log(`ShinzHost API running on port ${PORT}`);
});
