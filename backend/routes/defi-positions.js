const express = require('express');
const { fetchDefiPositions, getMultiChainBalances, DEFI_PROTOCOL_TOKENS } = require('../services/moralis');
const router = express.Router();

/**
 * GET /api/defi-positions?address=0x...
 *
 * Returns all DeFi positions (staked, deposited, LP) for the given wallet.
 * When Moralis returns positions with empty token arrays, enriches them by
 * cross-referencing wallet token balances with known protocol-token mappings.
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

    // Fetch DeFi positions and wallet balances in parallel so we can
    // enrich empty positions with wallet token data
    const [defiResult, balancesResult] = await Promise.allSettled([
      fetchDefiPositions(address),
      getMultiChainBalances(address),
    ]);

    let positions = [];
    let errors = [];

    if (defiResult.status === 'fulfilled') {
      positions = defiResult.value.positions;
      errors = defiResult.value.errors;
    } else {
      throw new Error(defiResult.reason?.message || 'Failed to fetch DeFi positions');
    }

    // Enrich empty positions from wallet tokens
    if (balancesResult.status === 'fulfilled') {
      const walletTokens = balancesResult.value.tokens;

      for (const pos of positions) {
        const hasValuedTokens = pos.tokens.some((t) => (t.valueUsd || 0) >= 1.0);
        if (hasValuedTokens) continue;

        const protocolAddresses = DEFI_PROTOCOL_TOKENS[pos.protocol]?.[pos.chainId] || [];
        for (const tokenAddr of protocolAddresses) {
          const walletToken = walletTokens.find(
            (t) => t.tokenAddress === tokenAddr && t.chainId === pos.chainId
          );
          if (walletToken && (walletToken.usdValue || 0) > 0) {
            pos.tokens.push({
              symbol: walletToken.symbol,
              name: walletToken.name,
              balance: walletToken.balanceFormatted,
              price: walletToken.usdPrice,
              valueUsd: walletToken.usdValue,
              tokenAddress: walletToken.tokenAddress,
              decimals: walletToken.decimals,
            });
            pos.totalValueUsd += walletToken.usdValue || 0;
            console.log(
              `[defi-positions] Enriched ${pos.protocol} with ${walletToken.symbol} ($${(walletToken.usdValue || 0).toFixed(2)})`
            );
          }
        }
      }
    }

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
