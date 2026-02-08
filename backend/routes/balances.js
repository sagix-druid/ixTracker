const express = require('express');
const router = express.Router();

// GET /api/balances?address=0x...
// Returns aggregated token balances across all supported chains
router.get('/', async (req, res) => {
  // TODO: Implement with real Moralis getWalletTokenBalances calls (Sprint 2)
  res.status(501).json({ error: 'Not implemented yet — Sprint 2' });
});

module.exports = router;
