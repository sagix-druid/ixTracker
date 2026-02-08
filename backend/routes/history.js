const express = require('express');
const router = express.Router();

// GET /api/history?address=0x...
// Returns historical portfolio value time series
router.get('/', async (req, res) => {
  // TODO: Implement with batched Moralis historical price calls (Sprint 6)
  res.status(501).json({ error: 'Not implemented yet — Sprint 6' });
});

module.exports = router;
