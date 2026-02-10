const express = require('express');
const { fetchDefiPositions } = require('../services/moralis');
const router = express.Router();

/**
 * GET /api/defi-positions?address=0x...
 *
 * Returns all DeFi positions (staked, deposited, LP) for the given wallet.
 */
router.get('/', async (req, res) => {
  const { address } = req.query;

  if (!address) {
    return res.status(400).json({
      error: 'Missing required query parameter: address',
      example: '/api/defi-positions?address=0xYourWalletAddress',
    });
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({
      error: 'Invalid Ethereum address format',
      received: address,
    });
  }

  try {
    console.log(`[defi-positions] Fetching positions for ${address}`);
    const { positions, errors } = await fetchDefiPositions(address);

    const totalValueUsd = positions.reduce((sum, p) => sum + p.totalValueUsd, 0);

    console.log(
      `[defi-positions] ${address}: $${totalValueUsd.toFixed(2)} across ${positions.length} positions`
    );

    res.json({
      address,
      totalValueUsd,
      positionCount: positions.length,
      positions,
      errors,
    });
  } catch (err) {
    console.error(`[defi-positions] Error for ${address}:`, err.message);
    res.status(500).json({
      error: 'Failed to fetch DeFi positions',
      message: err.message,
    });
  }
});

module.exports = router;
