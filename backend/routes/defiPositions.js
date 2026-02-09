const express = require('express');
const router = express.Router();
const {
  getMultiChainDefiPositions,
  getMultiChainDefiSummary,
  getDefiPositionsByProtocol,
  defiPositionsToHoldings,
} = require('../services/defi');
const { SUPPORTED_CHAINS } = require('../services/moralis');

// GET /api/defi-positions?address=0x...
//
// Returns all DeFi positions across supported chains.
// Includes staked, supplied, LP, and reward positions from protocols
// like Aave, Lido, Uniswap, Stake.link, Sky, Ether.fi, Symbiotic,
// Frankencoin, Frax, Morpho, Renzo, etc.
//
// The response includes both raw position data (grouped by protocol)
// and a flattened holdings-compatible array for merging into balances.
router.get('/', async (req, res) => {
  const { address } = req.query;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({
      error: 'Valid Ethereum address required (query param: address)',
    });
  }

  const walletAddress = address.toLowerCase();

  try {
    console.log(
      `\n[defi-positions] Fetching DeFi positions for ${walletAddress}`
    );

    // Fetch both summary and detailed positions in parallel
    const [summaryResult, positionsResult] = await Promise.allSettled([
      getMultiChainDefiSummary(walletAddress),
      getMultiChainDefiPositions(walletAddress),
    ]);

    let summary = null;
    let positions = [];
    const allErrors = [];

    if (summaryResult.status === 'fulfilled') {
      summary = summaryResult.value;
      allErrors.push(
        ...summaryResult.value.errors.map((e) => ({ source: 'summary', ...e }))
      );
    } else {
      allErrors.push({
        source: 'summary',
        error:
          summaryResult.reason?.message || 'Failed to fetch DeFi summary',
      });
    }

    if (positionsResult.status === 'fulfilled') {
      positions = positionsResult.value.positions;
      allErrors.push(
        ...positionsResult.value.errors.map((e) => ({
          source: 'positions',
          ...e,
        }))
      );
    } else {
      allErrors.push({
        source: 'positions',
        error:
          positionsResult.reason?.message || 'Failed to fetch DeFi positions',
      });
    }

    // Convert to holdings-compatible format
    const holdings = defiPositionsToHoldings(positions);

    // Group positions by protocol for the structured view
    const byProtocol = {};
    for (const pos of positions) {
      const key = pos.protocolId || pos.protocolName;
      if (!byProtocol[key]) {
        byProtocol[key] = {
          protocolName: pos.protocolName,
          protocolId: pos.protocolId,
          protocolUrl: pos.protocolUrl,
          protocolLogo: pos.protocolLogo,
          positions: [],
          totalUsdValue: 0,
        };
      }
      byProtocol[key].positions.push(pos);
      byProtocol[key].totalUsdValue += pos.totalUsdValue || 0;
    }

    const totalDefiValue = holdings.reduce(
      (sum, h) => sum + (h.usdValue || 0),
      0
    );

    console.log(
      `[defi-positions] Found ${positions.length} positions across ${Object.keys(byProtocol).length} protocols`
    );
    console.log(`[defi-positions] Total DeFi value: $${totalDefiValue.toFixed(2)}`);

    res.json({
      address: walletAddress,
      totalDefiValue,
      summary: summary
        ? {
            activeProtocols: summary.totalActiveProtocols,
            totalPositions: summary.totalPositions,
            totalUsdValue: summary.totalUsdValue,
            totalUnclaimedUsdValue: summary.totalUnclaimedUsdValue,
          }
        : null,
      protocolCount: Object.keys(byProtocol).length,
      positionCount: positions.length,
      protocols: Object.values(byProtocol),
      // Flattened holdings array — same shape as tokens in /api/balances
      holdings,
      errors: allErrors.length > 0 ? allErrors : undefined,
    });
  } catch (err) {
    console.error('[defi-positions] Unhandled error:', err);
    res.status(500).json({
      error: 'Failed to fetch DeFi positions',
      message: err.message,
    });
  }
});

// GET /api/defi-positions/:protocolId?address=0x...&chain=eth
//
// Returns detailed positions for a specific protocol
router.get('/:protocolId', async (req, res) => {
  const { address, chain: chainParam } = req.query;
  const { protocolId } = req.params;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({
      error: 'Valid Ethereum address required (query param: address)',
    });
  }

  const walletAddress = address.toLowerCase();

  try {
    // If chain is specified, query only that chain; otherwise query all
    const chainsToQuery = chainParam
      ? SUPPORTED_CHAINS.filter((c) => c.chainParam === chainParam)
      : SUPPORTED_CHAINS;

    if (chainsToQuery.length === 0) {
      return res.status(400).json({
        error: `Unsupported chain: ${chainParam}. Supported: ${SUPPORTED_CHAINS.map((c) => c.chainParam).join(', ')}`,
      });
    }

    const results = await Promise.allSettled(
      chainsToQuery.map((chain) =>
        getDefiPositionsByProtocol(walletAddress, protocolId, chain)
      )
    );

    const positions = [];
    const errors = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        positions.push(...result.value);
      } else {
        errors.push({
          chain: chainsToQuery[index].name,
          error: result.reason?.message || 'Unknown error',
        });
      }
    });

    res.json({
      address: walletAddress,
      protocolId,
      positionCount: positions.length,
      positions,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error(`[defi-positions/${protocolId}] Unhandled error:`, err);
    res.status(500).json({
      error: `Failed to fetch positions for ${protocolId}`,
      message: err.message,
    });
  }
});

module.exports = router;
