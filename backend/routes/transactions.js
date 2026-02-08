const express = require('express');
const router = express.Router();

// GET /api/transactions?address=0x...
// Returns transaction history and cost basis per token
router.get('/', async (req, res) => {
  // TODO: Implement with real Moralis getWalletHistory calls (Sprint 4)
  res.status(501).json({ error: 'Not implemented yet — Sprint 4' });
});

module.exports = router;
