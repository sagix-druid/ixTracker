const express = require('express');
const router = express.Router();

// GET /api/metrics?address=0x...
// Returns calculated portfolio metrics (CAGR, Sharpe, PnL)
router.get('/', async (req, res) => {
  // TODO: Implement with real calculations from portfolio data (Sprint 8)
  res.status(501).json({ error: 'Not implemented yet — Sprint 8' });
});

module.exports = router;
