require('dotenv').config();

const express = require('express');
const cors = require('cors');
const balancesRouter = require('./routes/balances');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS — allow frontend dev server and any future embed origins
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
  })
);

app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/balances', balancesRouter);

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[server] Sagix Portfolio Tracker backend running on port ${PORT}`);
});
