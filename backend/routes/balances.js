const express = require('express');
const { fetchAllChainBalances } = require('../services/moralis');

const router = express.Router();

// Minimum USD value for a token to be included in results.
// Filters out spam airdrops and dust from old swaps.
const DUST_THRESHOLD_USD = 1.0;

/**
 * GET /api/balances?address=0x...
 *
 * Returns all token balances for the given wallet address across
 * Ethereum and Base chains. Filters out dust (< $1 USD).
 *
 * Response shape:
 * {
 *   address: string,
 *   totalValueUsd: number,
 *   tokenCount: number,
 *   balances: Array<{
 *     chain, chainId, tokenAddress, symbol, name, logo, thumbnail,
 *     decimals, balance, price, priceChange24h, valueUsd, isNative,
 *     portfolioPercentage
 *   }>,
 *   errors: Array<{ chain, error }>,  // chains that failed to fetch
 *   dustFilteredCount: number          // how many tokens were below threshold
 * }
 */
router.get('/', async (req, res) => {
  const { address } = req.query;

  if (!address) {
    return res.status(400).json({
      error: 'Missing required query parameter: address',
      example: '/api/balances?address=0xYourWalletAddress',
    });
  }

  // Basic validation: must look like an Ethereum address
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({
      error: 'Invalid Ethereum address format',
      received: address,
    });
  }

  try {
    console.log(`[balances] Fetching balances for ${address}`);

    const { balances: allBalances, errors } =
      await fetchAllChainBalances(address);

    // Filter out dust — tokens worth less than the threshold
    const filteredBalances = allBalances.filter(
      (token) => token.valueUsd >= DUST_THRESHOLD_USD
    );
    const dustFilteredCount = allBalances.length - filteredBalances.length;

    // Sort by USD value descending so highest value positions appear first
    filteredBalances.sort((a, b) => b.valueUsd - a.valueUsd);

    // Calculate total portfolio value
    const totalValueUsd = filteredBalances.reduce(
      (sum, token) => sum + token.valueUsd,
      0
    );

    // Recalculate portfolio percentages based on filtered set
    const balances = filteredBalances.map((token) => ({
      ...token,
      portfolioPercentage:
        totalValueUsd > 0
          ? parseFloat(((token.valueUsd / totalValueUsd) * 100).toFixed(2))
          : 0,
    }));

    console.log(
      `[balances] ${address}: $${totalValueUsd.toFixed(2)} across ${balances.length} tokens (${dustFilteredCount} dust filtered)`
    );

    res.json({
      address,
      totalValueUsd,
      tokenCount: balances.length,
      balances,
      errors,
      dustFilteredCount,
    });
  } catch (err) {
    console.error(`[balances] Error for ${address}:`, err.message);
    res.status(500).json({
      error: 'Failed to fetch balances',
      message: err.message,
    });
  }
});

module.exports = router;
