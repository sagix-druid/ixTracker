const express = require('express');
const router = express.Router();
const { getMultiChainBalances, fetchDefiPositions, DUST_THRESHOLD_USD, DEFI_PROTOCOL_TOKENS, getTokenPrice, SUPPORTED_CHAINS } = require('../services/moralis');
const { applyNavPricing } = require('../services/navPricing');
const { recalculatePortfolioPercentages } = require('../services/calculations');

// ── Spam/scam token detection ──
// Heuristic patterns for token names that indicate airdrop scams
const SPAM_NAME_PATTERNS = [
  /t\.me\//i,        // Telegram links in token name
  /https?:\/\//i,    // URLs in token name
  /\.com\b/i,        // Domain names in token name
  /\bvisit\b/i,      // "Visit xyz" scam prompt
];

// Known spam symbols per chain (use sparingly — prefer address-based blocking)
const SPAM_SYMBOLS = {
  1: new Set(['ETHG']),
};

function isSpamToken(token) {
  const chainSpam = SPAM_SYMBOLS[token.chainId];
  if (chainSpam && chainSpam.has(token.symbol)) return true;
  const nameToCheck = `${token.name || ''} ${token.symbol || ''}`;
  return SPAM_NAME_PATTERNS.some((p) => p.test(nameToCheck));
}

// ── Price redirect for tokens with known wrong Moralis market prices ──
// sETHFI: Moralis returns ~$885/token (from a thin/manipulated DEX pool)
// but sETHFI is a staking receipt for ETHFI, so its price ≈ ETHFI price
const PRICE_REDIRECTS = {
  '0x86b5780b606940eb59a062aa85a07959518c0161': {
    chainId: 1,
    lookupAddress: '0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb', // ETHFI
    note: 'sETHFI ≈ ETHFI price (staking receipt)',
  },
};

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

    // ── Step 1b: Filter spam/scam tokens from wallet ──
    const preSpamCount = walletTokens.length;
    walletTokens = walletTokens.filter((t) => {
      if (isSpamToken(t)) {
        console.log(`[balances] Filtered spam: ${t.symbol} ($${(t.usdValue || 0).toFixed(2)}) on ${t.chain}`);
        return false;
      }
      return true;
    });
    if (walletTokens.length < preSpamCount) {
      console.log(`[balances] Removed ${preSpamCount - walletTokens.length} spam token(s)`);
    }

    // ── Step 1c: Fix known mispriced tokens via price redirect ──
    for (const token of walletTokens) {
      if (!token.tokenAddress) continue;
      const redirect = PRICE_REDIRECTS[token.tokenAddress.toLowerCase()];
      if (redirect) {
        const chain = SUPPORTED_CHAINS.find((c) => c.id === redirect.chainId);
        if (chain) {
          try {
            const priceData = await getTokenPrice(redirect.lookupAddress, chain);
            if (priceData?.usdPrice) {
              console.log(
                `[balances] Price redirect: ${token.symbol} $${token.usdPrice?.toFixed(2)} → $${priceData.usdPrice.toFixed(4)} (${redirect.note})`
              );
              token.usdPrice = priceData.usdPrice;
              token.usdValue = token.balanceFormatted * priceData.usdPrice;
              token.priceSource = 'redirect';
            }
          } catch (err) {
            console.warn(`[balances] Price redirect failed for ${token.symbol}: ${err.message}`);
          }
        }
      }
    }

    // ── Step 2: Convert DeFi positions to holdings-compatible format and merge ──
    const defiHoldings = [];
    for (const pos of defiPositions) {
      for (const token of pos.tokens) {
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

    // ── Step 2b: Tag wallet tokens that are known DeFi/staking positions ──
    // Moralis getDefiPositionsSummary detects protocols but often returns unusable
    // token data. Instead of relying on the DeFi response, directly tag wallet
    // tokens using the known protocol-to-token address mapping.
    // Build a logo lookup from detected DeFi positions for UI purposes.
    const protocolLogos = {};
    for (const pos of defiPositions) {
      if (pos.protocolLogo) {
        protocolLogos[pos.protocol] = pos.protocolLogo;
      }
    }

    console.log('[balances] Tagging known staking tokens as DeFi positions...');
    for (const token of walletTokens) {
      if (!token.tokenAddress) continue;
      for (const [protocol, chains] of Object.entries(DEFI_PROTOCOL_TOKENS)) {
        const addresses = chains[token.chainId] || [];
        if (addresses.includes(token.tokenAddress)) {
          token.isDefiPosition = true;
          token.defiProtocol = protocol;
          token.defiProtocolLogo = protocolLogos[protocol] || null;
          token.defiPositionType = 'staking';
          console.log(
            `[balances]   Tagged ${token.symbol} ($${(token.usdValue || 0).toFixed(2)}) as ${protocol} staking position`
          );
        }
      }
    }

    // ── Step 2c: Deduplicate — remove DeFi holdings that duplicate tagged wallet tokens ──
    // When a wallet token (e.g. weETH) is already tagged as EtherFi staking,
    // drop the corresponding DeFi holding to avoid double-counting.
    const taggedKeys = new Set(
      walletTokens
        .filter((t) => t.isDefiPosition)
        .map((t) => `${t.chainId}:${t.symbol}`)
    );
    const dedupedDefi = defiHoldings.filter(
      (t) => !taggedKeys.has(`${t.chainId}:${t.symbol}`)
    );
    if (dedupedDefi.length < defiHoldings.length) {
      console.log(
        `[balances] Deduped: removed ${defiHoldings.length - dedupedDefi.length} DeFi holdings already present as wallet tokens`
      );
    }

    let allTokens = [...walletTokens, ...dedupedDefi];

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
      dedupedDefi.reduce((sum, t) => sum + (t.usdValue || 0), 0) +
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
