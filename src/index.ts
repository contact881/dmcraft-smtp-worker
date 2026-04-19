import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// HEALTH
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// TRIGGER (QUESTO È QUELLO CHE TI MANCA)
app.post("/trigger", (req, res) => {
  console.log("Trigger ricevuto:", req.body);

  // per ora rispondiamo subito OK
  return res.status(202).json({
    success: true,
    message: "Worker trigger ricevuto",
  });
});

app.listen(PORT, () => {
  console.log(`Worker running on port ${PORT}`);
});
