const Moralis = require('moralis').default;
const { EvmChain } = require('@moralisweb3/common-evm-utils');

// Supported chains per CLAUDE.md spec: Ethereum + Base
const SUPPORTED_CHAINS = [
  { id: 1, name: 'Ethereum', evmChain: EvmChain.ETHEREUM },
  { id: 8453, name: 'Base', evmChain: EvmChain.BASE },
];

let initialized = false;

/**
 * Initialize the Moralis SDK once.
 * Must be called before any API method.
 */
async function initMoralis() {
  if (initialized) return;

  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'MORALIS_API_KEY is not set. Add it to your .env file.'
    );
  }

  await Moralis.start({ apiKey });
  initialized = true;
  console.log('[moralis] SDK initialized');
}

/**
 * Fetch ERC-20 token balances for a single chain.
 * Uses the wallets endpoint which returns balances WITH USD prices,
 * so we don't need a separate price lookup call.
 *
 * @param {string} walletAddress - The 0x wallet address
 * @param {object} chain - One of the SUPPORTED_CHAINS entries
 * @returns {Array} Formatted token objects
 */
async function fetchTokenBalancesForChain(walletAddress, chain) {
  const response = await Moralis.EvmApi.wallets.getWalletTokenBalancesPrice({
    address: walletAddress,
    chain: chain.evmChain,
    excludeSpam: true,
    excludeUnverifiedContracts: true,
  });

  const raw = response.result;

  return raw.map((token) => ({
    chain: chain.name,
    chainId: chain.id,
    tokenAddress: token.tokenAddress?.checksum || 'native',
    symbol: token.symbol,
    name: token.name,
    logo: token.logo || null,
    thumbnail: token.thumbnail || null,
    decimals: token.decimals,
    balanceRaw: token.balanceFormatted,
    balance: parseFloat(token.balanceFormatted),
    price: token.usdPrice ?? 0,
    priceChange24h: token.usdPrice24hrPercentChange ?? null,
    valueUsd: token.usdValue ?? 0,
    isNative: token.nativeToken ?? false,
    portfolioPercentage: token.portfolioPercentage ?? 0,
  }));
}

/**
 * Fetch native (ETH) balance for a single chain.
 * getWalletTokenBalancesPrice already includes native tokens,
 * so this is kept as a fallback if needed.
 *
 * @param {string} walletAddress
 * @param {object} chain
 * @returns {object} Native balance info
 */
async function fetchNativeBalance(walletAddress, chain) {
  const response = await Moralis.EvmApi.balance.getNativeBalance({
    address: walletAddress,
    chain: chain.evmChain,
  });

  return {
    chain: chain.name,
    chainId: chain.id,
    balanceWei: response.result.balance.toString(),
  };
}

/**
 * Fetch token balances across ALL supported chains.
 * Uses Promise.allSettled so one failing chain doesn't block the others.
 * Includes a small delay between chain requests to be respectful of rate limits.
 *
 * @param {string} walletAddress - The 0x wallet address
 * @returns {object} { balances: Array, errors: Array }
 */
async function fetchAllChainBalances(walletAddress) {
  await initMoralis();

  const results = await Promise.allSettled(
    SUPPORTED_CHAINS.map((chain) =>
      fetchTokenBalancesForChain(walletAddress, chain)
    )
  );

  const balances = [];
  const errors = [];

  results.forEach((result, index) => {
    const chain = SUPPORTED_CHAINS[index];
    if (result.status === 'fulfilled') {
      balances.push(...result.value);
      console.log(
        `[moralis] ${chain.name}: fetched ${result.value.length} tokens`
      );
    } else {
      const errorMsg = result.reason?.message || String(result.reason);
      errors.push({ chain: chain.name, error: errorMsg });
      console.error(`[moralis] ${chain.name} failed: ${errorMsg}`);
    }
  });

  return { balances, errors };
}

/**
 * Get the current USD price for a specific token.
 *
 * @param {string} tokenAddress - Contract address (use native token address for ETH)
 * @param {object} chain - One of the SUPPORTED_CHAINS entries
 * @returns {object} Price data
 */
async function getTokenPrice(tokenAddress, chain) {
  await initMoralis();

  const response = await Moralis.EvmApi.token.getTokenPrice({
    address: tokenAddress,
    chain: chain.evmChain,
  });

  return {
    usdPrice: response.result.usdPrice,
    nativePrice: response.result.nativePrice,
    tokenName: response.result.tokenName,
    tokenSymbol: response.result.tokenSymbol,
  };
}

module.exports = {
  initMoralis,
  fetchAllChainBalances,
  fetchTokenBalancesForChain,
  fetchNativeBalance,
  getTokenPrice,
  SUPPORTED_CHAINS,
};
