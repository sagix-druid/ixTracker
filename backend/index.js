require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initMoralis } = require('./services/moralis');
const { loadDtfsFromEnv } = require('./services/navPricing');

const balancesRouter = require('./routes/balances');
const defiPositionsRouter = require('./routes/defi-positions');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS — restrict origins in production via ALLOWED_ORIGINS env var
// Comma-separated list, e.g. "https://sagix.io,https://www.sagix.io"
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null; // null = allow all in dev

app.use(
  cors({
    origin: allowedOrigins
      ? (origin, cb) => {
          if (!origin || allowedOrigins.includes(origin)) {
            cb(null, true);
          } else {
            cb(new Error(`Origin ${origin} not allowed by CORS`));
          }
        }
      : true,
  })
);
app.use(express.json());

// Routes
app.use('/api/balances', balancesRouter);
app.use('/api/defi-positions', defiPositionsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
async function start() {
  try {
    // Load DTF token addresses from environment
    loadDtfsFromEnv();

    // Initialize Moralis SDK
    await initMoralis();

    app.listen(PORT, () => {
      console.log(`[server] Sagix Portfolio Tracker API running on port ${PORT}`);
      console.log(`[server] Endpoints:`);
      console.log(`[server]   GET /api/balances?address=0x...`);
      console.log(`[server]   GET /api/defi-positions?address=0x...`);
      console.log(`[server]   GET /api/health`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
