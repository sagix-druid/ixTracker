const express = require('express');
const router = express.Router();
const { getMultiChainBalances, fetchDefiPositions, DUST_THRESHOLD_USD, DEFI_PROTOCOL_TOKENS } = require('../services/moralis');
const { applyNavPricing } = require('../services/navPricing');
const { recalculatePortfolioPercentages } = require('../services/calculations');

// GET /api/balances?address=0x...
//
// Returns the full merged portfolio:
//   1. Wallet token balances from Moralis (multi-chain)
//   2. DeFi positions (staked, supplied, LP'd) from Moralis DeFi API
//   3. NAV-priced DTF tokens (ixEDEL, ixETH, etc.) via on-chain calls
//
// Response shape:
// {
//   address, totalUsdValue, tokens: [...],
//   defiPositionsIncluded: true,
//   navPricingApplied: true,
//   disclaimer, errors
// }
router.get('/', async (req, res) => {
  const { address } = req.query;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({
      error: 'Valid Ethereum address required (query param: address)',
    });
  }

  const walletAddress = address.toLowerCase();

  try {
    console.log(`\n[balances] Fetching full portfolio for ${walletAddress}`);

    // ── Step 1: Fetch wallet token balances + DeFi positions in parallel ──
    const [balancesResult, defiResult] = await Promise.allSettled([
      getMultiChainBalances(walletAddress),
      fetchDefiPositions(walletAddress),
    ]);

    let walletTokens = [];
    let defiPositions = [];
    const allErrors = [];

    if (balancesResult.status === 'fulfilled') {
      walletTokens = balancesResult.value.tokens;
      allErrors.push(...balancesResult.value.errors);
    } else {
      allErrors.push({
        source: 'balances',
        error: balancesResult.reason?.message || 'Failed to fetch balances',
      });
      console.error(
        '[balances] Balance fetch failed:',
        balancesResult.reason?.message
      );
    }

    if (defiResult.status === 'fulfilled') {
      defiPositions = defiResult.value.positions;
      allErrors.push(
        ...defiResult.value.errors.map((e) => ({ source: 'defi', ...e }))
      );
      console.log(
        `[balances] Fetched ${defiPositions.length} DeFi positions`
      );
    } else {
      allErrors.push({
        source: 'defi',
        error: defiResult.reason?.message || 'Failed to fetch DeFi positions',
      });
      console.error(
        '[balances] DeFi fetch failed:',
        defiResult.reason?.message
      );
    }

    // ── Step 2: Convert DeFi positions to holdings-compatible format and merge ──
    const defiHoldings = [];
    for (const pos of defiPositions) {
      for (const token of pos.tokens) {
        // Allow tokens with null price through (they may get priced later by NAV pricing).
        // Only filter out tokens that have a known value below dust threshold.
        if (token.valueUsd !== null && token.valueUsd < DUST_THRESHOLD_USD) continue;
        defiHoldings.push({
          chain: pos.chain,
          chainId: pos.chainId,
          tokenAddress: token.tokenAddress,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals || null,
          balance: String(token.balance),
          balanceFormatted: token.balance,
          usdPrice: token.price ?? null,
          usdValue: token.valueUsd ?? null,
          logo: null,
          thumbnail: null,
          priceSource: token.price ? 'defi' : null,
          nativeToken: false,
          portfolioPercentage: 0,
          isDefiPosition: true,
          defiProtocol: pos.protocol,
          defiProtocolLogo: pos.protocolLogo,
          defiPositionType: pos.positionType,
        });
      }
    }

    // ── Step 2b: Enrich empty DeFi positions from wallet tokens ──
    // Moralis getDefiPositionsSummary often detects protocols (EtherFi, Lido, etc.)
    // but returns empty token arrays. When this happens, cross-reference wallet tokens
    // with known protocol-to-token mappings to attribute value to the DeFi position.
    for (const pos of defiPositions) {
      // Skip only if Moralis returned tokens with actual value.
      // Moralis often returns tokens with zero price/value — those still need enrichment.
      const hasValuedTokens = pos.tokens.some((t) => (t.valueUsd || 0) >= DUST_THRESHOLD_USD);
      if (hasValuedTokens) continue;

      const protocolAddresses = DEFI_PROTOCOL_TOKENS[pos.protocol]?.[pos.chainId] || [];
      for (const tokenAddr of protocolAddresses) {
        const walletToken = walletTokens.find(
          (t) => t.tokenAddress === tokenAddr && t.chainId === pos.chainId
        );
        if (walletToken && (walletToken.usdValue || 0) >= DUST_THRESHOLD_USD) {
          // Tag the wallet token as belonging to this DeFi protocol.
          // This does NOT duplicate the token — it annotates the existing entry.
          walletToken.isDefiPosition = true;
          walletToken.defiProtocol = pos.protocol;
          walletToken.defiProtocolLogo = pos.protocolLogo;
          walletToken.defiPositionType = pos.positionType;
          console.log(
            `[balances] Matched ${walletToken.symbol} ($${(walletToken.usdValue || 0).toFixed(2)}) to DeFi protocol ${pos.protocol}`
          );
        }
      }
    }

    let allTokens = [...walletTokens, ...defiHoldings];

    console.log(
      `[balances] Merged: ${walletTokens.length} wallet + ${defiHoldings.length} DeFi = ${allTokens.length} total`
    );

    // ── Step 3: Apply NAV pricing for tokens with null price ──
    // This attempts on-chain Reserve Protocol calls for DTF tokens
    const nullPriceCount = allTokens.filter((t) => t.usdPrice === null).length;
    if (nullPriceCount > 0) {
      console.log(
        `[balances] ${nullPriceCount} tokens with null price — applying NAV pricing`
      );
      allTokens = await applyNavPricing(allTokens);
    }

    // ── Step 4: Final dust filter (after NAV pricing may have filled in values) ──
    allTokens = allTokens.filter(
      (t) => t.usdValue === null || t.usdValue >= DUST_THRESHOLD_USD
    );

    // ── Step 5: Recalculate portfolio percentages across the merged set ──
    allTokens = recalculatePortfolioPercentages(allTokens);

    // ── Step 6: Sort by USD value descending ──
    allTokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));

    // ── Compute totals ──
    const totalUsdValue = allTokens.reduce(
      (sum, t) => sum + (t.usdValue || 0),
      0
    );
    // DeFi value = tokens from DeFi holdings + wallet tokens tagged as DeFi positions
    const totalDefiValue =
      defiHoldings.reduce((sum, t) => sum + (t.usdValue || 0), 0) +
      walletTokens
        .filter((t) => t.isDefiPosition)
        .reduce((sum, t) => sum + (t.usdValue || 0), 0);
    const totalWalletValue = allTokens.reduce(
      (sum, t) => sum + (t.usdValue || 0),
      0
    ) - totalDefiValue;
    const navPricedTokens = allTokens.filter(
      (t) => t.priceSource === 'nav'
    );
    const navPricedValue = navPricedTokens.reduce(
      (sum, t) => sum + (t.usdValue || 0),
      0
    );

    console.log(`[balances] Portfolio summary:`);
    console.log(`[balances]   Wallet tokens: $${totalWalletValue.toFixed(2)}`);
    console.log(`[balances]   DeFi positions: $${totalDefiValue.toFixed(2)}`);
    console.log(`[balances]   NAV-priced: $${navPricedValue.toFixed(2)} (${navPricedTokens.length} tokens)`);
    console.log(`[balances]   Total: $${totalUsdValue.toFixed(2)}`);
    console.log(`[balances]   Tokens: ${allTokens.length}`);

    res.json({
      address: walletAddress,
      totalUsdValue,
      breakdown: {
        walletTokensValue: totalWalletValue,
        defiPositionsValue: totalDefiValue,
        navPricedValue,
      },
      tokenCount: allTokens.length,
      tokens: allTokens,
      defiPositionsIncluded: defiResult.status === 'fulfilled',
      navPricingApplied: navPricedTokens.length > 0,
      disclaimer:
        'Cost basis estimated from on-chain data. DeFi positions sourced from Moralis. NAV pricing calculated from on-chain basket composition.',
      errors: allErrors.length > 0 ? allErrors : undefined,
    });
  } catch (err) {
    console.error('[balances] Unhandled error:', err);
    res.status(500).json({
      error: 'Failed to fetch portfolio data',
      message: err.message,
    });
  }
});

module.exports = router;
