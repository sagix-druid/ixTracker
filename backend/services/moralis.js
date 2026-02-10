const Moralis = require('moralis').default;
const { EvmChain } = require('@moralisweb3/common-evm-utils');

// Chains supported by the tracker (Ethereum + Base per CLAUDE.md)
const SUPPORTED_CHAINS = [
  { id: 1, name: 'Ethereum', moralisChain: EvmChain.ETHEREUM, chainParam: 'eth' },
  { id: 8453, name: 'Base', moralisChain: EvmChain.BASE, chainParam: 'base' },
];

const DUST_THRESHOLD_USD = 1.0;

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

module.exports = {
  initMoralis,
  SUPPORTED_CHAINS,
  DUST_THRESHOLD_USD,
  getMultiChainBalances,
  getTokenPrice,
  getTokenPricesBatched,
  batchedRequests,
  delay,
};
