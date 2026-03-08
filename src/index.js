import express from "express";
import { router } from "./routes.js";

const app = express();
const PORT = process.env.PORT || 3000;

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
