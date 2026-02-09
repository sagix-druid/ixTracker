require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initMoralis } = require('./services/moralis');
const { loadDtfsFromEnv } = require('./services/navPricing');

const balancesRouter = require('./routes/balances');
const defiPositionsRouter = require('./routes/defiPositions');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
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
      console.log(`[server]   GET /api/defi-positions/:protocolId?address=0x...`);
      console.log(`[server]   GET /api/health`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
