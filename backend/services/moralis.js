const Moralis = require('moralis').default;
const { EvmChain } = require('@moralisweb3/common-evm-utils');

// Chains supported by the tracker (Ethereum + Base per CLAUDE.md)
const SUPPORTED_CHAINS = [
  { id: 1, name: 'Ethereum', moralisChain: EvmChain.ETHEREUM, chainParam: 'eth' },
  { id: 8453, name: 'Base', moralisChain: EvmChain.BASE, chainParam: 'base' },
];

const DUST_THRESHOLD_USD = 1.0;

// Known associations between DeFi protocols (as reported by Moralis getDefiPositionsSummary)
// and the liquid staking / receipt token addresses held in wallets.
// When Moralis detects a protocol but returns no token details, we cross-reference
// wallet tokens using this map to attribute value to the DeFi position.
const DEFI_PROTOCOL_TOKENS = {
  'EtherFi': {
    1: [
      '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee', // weETH
    ],
  },
  'Rocket Pool': {
    1: [
      '0xae78736cd615f374d3085123a210448e74fc6393', // rETH
    ],
  },
  'Lido': {
    1: [
      '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', // wstETH
    ],
  },
};

let moralisInitialized = false;

async function initMoralis() {
  if (moralisInitialized) return;

  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) {
    throw new Error('MORALIS_API_KEY environment variable is required');
  }

  await Moralis.start({ apiKey });
  moralisInitialized = true;
  console.log('[moralis] SDK initialized');
}

// Rate-limit-aware delay helper
async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Batch async calls with delay between batches to respect Moralis 25 req/s limit
async function batchedRequests(queries, batchSize = 20, delayMs = 1100) {
  const results = [];
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
    results.push(...batchResults);

    if (i + batchSize < queries.length) {
      await delay(delayMs);
    }
  }
  return results;
}

// Fetch token balances for a single chain via Moralis SDK
async function getChainTokenBalances(walletAddress, chain) {
  await initMoralis();

  const response = await Moralis.EvmApi.wallets.getWalletTokenBalancesPrice({
    address: walletAddress,
    chain: chain.moralisChain,
  });

  const tokens = response.result.map((token) => ({
    chain: chain.name,
    chainId: chain.id,
    tokenAddress: token.tokenAddress?.lowercase || null,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    balance: token.balance?.toString() || '0',
    balanceFormatted: parseFloat(token.balanceFormatted) || 0,
    usdPrice: token.usdPrice || null,
    usdValue: token.usdValue || null,
    logo: token.logo || null,
    thumbnail: token.thumbnail || null,
    priceSource: token.usdPrice ? 'market' : null,
    nativeToken: token.nativeToken || false,
    portfolioPercentage: token.portfolioPercentage || 0,
  }));

  return tokens;
}

// Fetch balances across all supported chains using Promise.allSettled
async function getMultiChainBalances(walletAddress) {
  await initMoralis();

  const results = await Promise.allSettled(
    SUPPORTED_CHAINS.map((chain) => getChainTokenBalances(walletAddress, chain))
  );

  const allTokens = [];
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      allTokens.push(...result.value);
    } else {
      errors.push({
        chain: SUPPORTED_CHAINS[index].name,
        error: result.reason?.message || 'Unknown error',
      });
      console.error(
        `[moralis] Failed to fetch balances for ${SUPPORTED_CHAINS[index].name}:`,
        result.reason?.message
      );
    }
  });

  // Filter out dust (< $1 USD) — keep tokens with null price for NAV pricing later
  const filtered = allTokens.filter(
    (token) => token.usdValue === null || token.usdValue >= DUST_THRESHOLD_USD
  );

  return { tokens: filtered, errors };
}

// Fetch current price for a single token
async function getTokenPrice(tokenAddress, chain) {
  await initMoralis();

  try {
    const response = await Moralis.EvmApi.token.getTokenPrice({
      address: tokenAddress,
      chain: chain.moralisChain,
    });

    return {
      usdPrice: response.result.usdPrice,
      exchangeName: response.result.exchangeName,
      exchangeAddress: response.result.exchangeAddress,
    };
  } catch (err) {
    // Token may not have a liquidity pool — return null, do NOT mock
    console.warn(
      `[moralis] No price for ${tokenAddress} on ${chain.name}: ${err.message}`
    );
    return null;
  }
}

// Fetch prices for multiple tokens, batched to respect rate limits
async function getTokenPricesBatched(tokenRequests) {
  // tokenRequests: [{ tokenAddress, chain }]
  const priceFns = tokenRequests.map(
    ({ tokenAddress, chain }) =>
      () =>
        getTokenPrice(tokenAddress, chain).then((price) => ({
          tokenAddress,
          chainId: chain.id,
          ...price,
        }))
  );

  const results = await batchedRequests(priceFns);

  const prices = {};
  results.forEach((result) => {
    if (result.status === 'fulfilled' && result.value) {
      const key = `${result.value.chainId}:${result.value.tokenAddress}`;
      prices[key] = result.value;
    }
  });

  return prices;
}

/**
 * Fetch DeFi positions (staked, deposited, LP positions) for a wallet.
 * Uses Moralis Wallet API getDefiPositionsSummary endpoint.
 *
 * @param {string} walletAddress - The 0x wallet address
 * @returns {object} { positions: Array, errors: Array }
 */
async function fetchDefiPositions(walletAddress) {
  await initMoralis();

  const positions = [];
  const errors = [];

  for (const chain of SUPPORTED_CHAINS) {
    try {
      const response = await Moralis.EvmApi.wallets.getDefiPositionsSummary({
        address: walletAddress,
        chain: chain.moralisChain,
      });

      const raw = response.result || [];

      for (const pos of raw) {
        // Moralis nests token data under pos.position (an inner object with label, tokens, balanceUsd).
        // The outer object has protocolName, protocolLogo, etc.
        const positionData = pos.position || {};
        const tokenList = positionData.tokens || pos.tokens || [];

        const mappedTokens = tokenList.map((t) => {
          const balance = parseFloat(
            t.balanceFormatted || t.balance_formatted || t.balance || 0
          );
          const price = t.usdPrice ?? t.usd_price ?? null;
          const valueUsd = t.usdValue ?? t.usd_value ?? null;
          const computedValue =
            valueUsd !== null
              ? valueUsd
              : price !== null && balance > 0
                ? balance * price
                : null;

          return {
            symbol: t.symbol,
            name: t.name,
            balance,
            price,
            valueUsd: computedValue,
            tokenAddress: t.tokenAddress || t.address || t.token_address || null,
            decimals: t.decimals ? Number(t.decimals) : 18,
          };
        });

        const totalFromTokens = mappedTokens.reduce(
          (sum, t) => sum + (t.valueUsd || 0),
          0
        );
        const totalValueUsd =
          positionData.balanceUsd ||
          positionData.balance_usd ||
          pos.totalUsdValue ||
          pos.usdValue ||
          totalFromTokens ||
          0;

        positions.push({
          chain: chain.name,
          chainId: chain.id,
          protocol: pos.protocolName || pos.protocol?.name || 'Unknown',
          protocolLogo: pos.protocolLogo || pos.protocol?.logo || null,
          positionType: positionData.label || pos.positionType || pos.type || 'deposit',
          tokens: mappedTokens,
          totalValueUsd,
        });
      }

      console.log(`[moralis] ${chain.name}: fetched ${raw.length} DeFi positions`);
      if (raw.length > 0) {
        // Log structure of first position for debugging
        const first = raw[0];
        console.log(
          `[moralis]   First position keys: ${Object.keys(first).join(', ')}`
        );
        if (first.position) {
          console.log(
            `[moralis]   position.position keys: ${Object.keys(first.position).join(', ')}`
          );
          const innerTokens = first.position.tokens || [];
          console.log(
            `[moralis]   position.position.tokens count: ${innerTokens.length}`
          );
          if (innerTokens.length > 0) {
            console.log(
              `[moralis]   First token keys: ${Object.keys(innerTokens[0]).join(', ')}`
            );
          }
        }
      }
    } catch (err) {
      const errorMsg = err?.message || String(err);
      errors.push({ chain: chain.name, error: errorMsg });
      console.error(`[moralis] ${chain.name} DeFi positions failed: ${errorMsg}`);
    }
  }

  // Price DeFi position tokens that have addresses but no prices
  const unpricedTokens = [];
  for (const pos of positions) {
    for (const token of pos.tokens) {
      if (token.price === null && token.tokenAddress) {
        unpricedTokens.push({
          token,
          chain: SUPPORTED_CHAINS.find((c) => c.id === pos.chainId),
        });
      }
    }
  }

  if (unpricedTokens.length > 0) {
    console.log(
      `[moralis] Pricing ${unpricedTokens.length} DeFi tokens via getTokenPrice`
    );
    const priceFns = unpricedTokens.map(
      ({ token, chain: chainConfig }) =>
        () =>
          getTokenPrice(token.tokenAddress, chainConfig).then((price) => ({
            tokenAddress: token.tokenAddress,
            price,
          }))
    );

    const priceResults = await batchedRequests(priceFns);
    for (const result of priceResults) {
      if (result.status === 'fulfilled' && result.value?.price?.usdPrice) {
        const { tokenAddress, price } = result.value;
        // Apply price to all matching tokens across positions
        for (const pos of positions) {
          for (const token of pos.tokens) {
            if (
              token.tokenAddress === tokenAddress &&
              token.price === null
            ) {
              token.price = price.usdPrice;
              token.valueUsd =
                token.balance > 0 ? token.balance * price.usdPrice : 0;
            }
          }
          // Recalculate position total
          pos.totalValueUsd = pos.tokens.reduce(
            (sum, t) => sum + (t.valueUsd || 0),
            0
          );
        }
      }
    }
  }

  return { positions, errors };
}

module.exports = {
  initMoralis,
  SUPPORTED_CHAINS,
  DUST_THRESHOLD_USD,
  DEFI_PROTOCOL_TOKENS,
  getMultiChainBalances,
  fetchDefiPositions,
  getTokenPrice,
  getTokenPricesBatched,
  batchedRequests,
  delay,
};
