const { ethers } = require('ethers');
const { getTokenPrice, SUPPORTED_CHAINS, delay } = require('./moralis');

// ──────────────────────────────────────────────────────────────────────
// Reserve Protocol DTF NAV Pricing
//
// For tokens like ixEDEL, ixETH that have no liquidity pool, Moralis
// returns null price. These are Reserve Protocol "RTokens" (DTFs) whose
// value equals the sum of their underlying basket tokens.
//
// On-chain call path:
//   RToken.main() → Main.basketHandler() → BasketHandler.quote()
//   which returns (address[] erc20s, uint256[] quantities) for 1 unit
//
// We then price each underlying via Moralis and sum for the NAV.
// ──────────────────────────────────────────────────────────────────────

// Minimal ABIs — only the functions we actually call
const RTOKEN_ABI = [
  'function main() external view returns (address)',
  'function totalSupply() external view returns (uint256)',
  'function decimals() external view returns (uint8)',
];

const MAIN_ABI = [
  'function basketHandler() external view returns (address)',
  'function assetRegistry() external view returns (address)',
];

const BASKET_HANDLER_ABI = [
  // quote(uint192 amount, uint8 rounding) returns (address[] erc20s, uint256[] quantities)
  // RoundingMode: 0 = FLOOR, 1 = CEIL, 2 = ROUND
  'function quote(uint192 amount, uint8 rounding) external view returns (address[] memory, uint256[] memory)',
  'function status() external view returns (uint8)',
  'function nonce() external view returns (uint48)',
];

const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function name() external view returns (string)',
  'function decimals() external view returns (uint8)',
];

// Known DTF tokens — add new ones here as needed.
// These are the Reserve Protocol RTokens that need NAV pricing.
// Addresses must be checksummed or lowercase.
const KNOWN_DTFS = {
  // Ethereum mainnet
  1: [
    // Add ixEDEL, ixETH, ETH+ addresses here when known.
    // Example format:
    // { symbol: 'ixEDEL', address: '0x...' },
    // { symbol: 'ETH+', address: '0xE72B141DF173b999AE7c1aDcbF60Cc9833Ce56a8' },
  ],
  // Base
  8453: [
    // Base-deployed DTFs
  ],
};

// FIX_ONE in Reserve Protocol = 1e18 (UFixed192 representation of 1.0)
const FIX_ONE = ethers.parseUnits('1', 18);

function getProvider(chainId) {
  // Use public RPCs; users should set their own for production
  const rpcUrls = {
    1: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
    8453: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  };

  const url = rpcUrls[chainId];
  if (!url) throw new Error(`No RPC URL configured for chain ${chainId}`);

  return new ethers.JsonRpcProvider(url);
}

function getChainConfig(chainId) {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId);
}

// Core function: Calculate NAV for a single RToken by reading the basket on-chain
async function calculateRTokenNAV(rTokenAddress, chainId) {
  const provider = getProvider(chainId);
  const chain = getChainConfig(chainId);
  if (!chain) throw new Error(`Chain ${chainId} not supported`);

  console.log(
    `[nav] Calculating NAV for RToken ${rTokenAddress} on chain ${chainId}`
  );

  // Step 1: Get RToken decimals
  // ethers v6 returns BigInt for uint8 — cast to Number for parseUnits
  const rToken = new ethers.Contract(rTokenAddress, RTOKEN_ABI, provider);
  const rTokenDecimals = Number(await rToken.decimals());
  const oneUnit = ethers.parseUnits('1', rTokenDecimals);

  // Step 2: Get Main contract
  const mainAddress = await rToken.main();
  console.log(`[nav]   Main contract: ${mainAddress}`);

  // Step 3: Get BasketHandler
  const main = new ethers.Contract(mainAddress, MAIN_ABI, provider);
  const basketHandlerAddress = await main.basketHandler();
  console.log(`[nav]   BasketHandler: ${basketHandlerAddress}`);

  // Step 4: Call quote() for 1 unit of RToken to get basket composition
  // quote() returns the amounts of each underlying token needed for `amount` basket units
  const basketHandler = new ethers.Contract(
    basketHandlerAddress,
    BASKET_HANDLER_ABI,
    provider
  );

  // Check basket status (0 = SOUND, 1 = IFFY, 2 = DISABLED)
  // ethers v6 returns BigInt for uint8 — cast to Number for safe comparison
  const status = Number(await basketHandler.status());
  if (status === 2) {
    console.warn(`[nav]   Basket is DISABLED for ${rTokenAddress}`);
    return null;
  }

  // Get the basket for 1 RToken unit (FIX_ONE = 1e18 in Reserve's fixed-point)
  const [erc20Addresses, quantities] = await basketHandler.quote(
    FIX_ONE,
    0 // FLOOR rounding
  );

  console.log(
    `[nav]   Basket has ${erc20Addresses.length} underlying tokens`
  );

  if (erc20Addresses.length === 0) {
    console.warn(`[nav]   Empty basket for ${rTokenAddress}`);
    return null;
  }

  // Step 5: For each underlying token, get its decimals and price
  let navUsd = 0;
  const basketTokens = [];

  for (let i = 0; i < erc20Addresses.length; i++) {
    const tokenAddr = erc20Addresses[i];
    const rawQuantity = quantities[i];

    // Get token decimals
    const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    let tokenDecimals, tokenSymbol;
    try {
      const [rawDecimals, rawSymbol] = await Promise.all([
        tokenContract.decimals(),
        tokenContract.symbol(),
      ]);
      tokenDecimals = Number(rawDecimals);
      tokenSymbol = rawSymbol;
    } catch (err) {
      console.warn(
        `[nav]   Could not read metadata for ${tokenAddr}: ${err.message}`
      );
      tokenDecimals = 18;
      tokenSymbol = 'UNKNOWN';
    }

    // Convert raw quantity to human-readable
    const formattedQuantity = parseFloat(
      ethers.formatUnits(rawQuantity, tokenDecimals)
    );

    // Get price from Moralis
    const priceData = await getTokenPrice(tokenAddr, chain);

    // Rate limit: small delay between price calls
    if (i < erc20Addresses.length - 1) {
      await delay(100);
    }

    const tokenUsdPrice = priceData?.usdPrice || null;
    const tokenUsdValue =
      tokenUsdPrice !== null ? formattedQuantity * tokenUsdPrice : null;

    basketTokens.push({
      address: tokenAddr,
      symbol: tokenSymbol,
      decimals: Number(tokenDecimals),
      quantityPerUnit: formattedQuantity,
      usdPrice: tokenUsdPrice,
      usdValue: tokenUsdValue,
    });

    if (tokenUsdValue !== null) {
      navUsd += tokenUsdValue;
    } else {
      // If we can't price even one underlying token, the NAV is unreliable
      console.warn(
        `[nav]   No price for underlying ${tokenSymbol} (${tokenAddr}) — NAV may be incomplete`
      );
    }

    console.log(
      `[nav]   ${tokenSymbol}: ${formattedQuantity} × $${tokenUsdPrice ?? 'N/A'} = $${tokenUsdValue?.toFixed(4) ?? 'N/A'}`
    );
  }

  // Only return NAV if we priced all underlying tokens
  const pricedCount = basketTokens.filter((t) => t.usdPrice !== null).length;
  const allPriced = pricedCount === basketTokens.length;

  if (navUsd <= 0) {
    console.warn(`[nav]   NAV is $0 for ${rTokenAddress} — cannot price`);
    return null;
  }

  const result = {
    rTokenAddress,
    chainId,
    navPerToken: navUsd,
    basketTokens,
    allUnderlyingPriced: allPriced,
    pricedCount,
    totalUnderlying: basketTokens.length,
    basketStatus: status === 0 ? 'SOUND' : status === 1 ? 'IFFY' : 'UNKNOWN',
  };

  console.log(
    `[nav]   NAV = $${navUsd.toFixed(6)} (${pricedCount}/${basketTokens.length} priced, basket ${result.basketStatus})`
  );

  return result;
}

// Apply NAV pricing to an array of token balances.
// For any token with null price, check if it's a known DTF and calculate NAV.
// Also accepts an optional array of extra addresses to try NAV pricing on.
async function applyNavPricing(tokens, extraDtfAddresses = []) {
  // Build a set of addresses to check for NAV pricing
  const dtfAddressesByChain = {};

  // Add known DTFs
  for (const [chainId, dtfs] of Object.entries(KNOWN_DTFS)) {
    dtfAddressesByChain[chainId] = dtfAddressesByChain[chainId] || new Set();
    for (const dtf of dtfs) {
      dtfAddressesByChain[chainId].add(dtf.address.toLowerCase());
    }
  }

  // Add any extra addresses provided at runtime
  for (const { address, chainId } of extraDtfAddresses) {
    dtfAddressesByChain[chainId] = dtfAddressesByChain[chainId] || new Set();
    dtfAddressesByChain[chainId].add(address.toLowerCase());
  }

  // Find tokens with null price that are known DTFs.
  // Only attempt on-chain NAV calls for tokens we know are RTokens —
  // calling quote() on random unpriced tokens would be slow and noisy.
  const tokensNeedingNav = tokens.filter((t) => {
    if (t.usdPrice !== null) return false;
    if (!t.tokenAddress) return false;

    const knownSet = dtfAddressesByChain[t.chainId];
    return knownSet && knownSet.has(t.tokenAddress.toLowerCase());
  });

  console.log(
    `[nav] ${tokensNeedingNav.length} known DTFs with null price — attempting NAV pricing`
  );

  // Calculate NAV for each, with error handling per token
  const navResults = {};
  for (const token of tokensNeedingNav) {
    try {
      const nav = await calculateRTokenNAV(token.tokenAddress, token.chainId);
      if (nav) {
        navResults[`${token.chainId}:${token.tokenAddress}`] = nav;
      }
    } catch (err) {
      // Not an RToken or contract call failed — that's fine, skip it
      console.log(
        `[nav] ${token.symbol || token.tokenAddress} is not an RToken or call failed: ${err.message}`
      );
    }
  }

  // Apply NAV prices to the token array
  const updatedTokens = tokens.map((token) => {
    const key = `${token.chainId}:${token.tokenAddress}`;
    const nav = navResults[key];

    if (nav && token.usdPrice === null) {
      const usdPrice = nav.navPerToken;
      const usdValue = token.balanceFormatted * usdPrice;

      return {
        ...token,
        usdPrice,
        usdValue,
        priceSource: 'nav',
        navDetails: {
          basketTokens: nav.basketTokens,
          allUnderlyingPriced: nav.allUnderlyingPriced,
          basketStatus: nav.basketStatus,
        },
      };
    }

    return token;
  });

  return updatedTokens;
}

// Convenience: register a DTF address at runtime (e.g., from env vars or config)
function registerDtf(chainId, symbol, address) {
  if (!KNOWN_DTFS[chainId]) {
    KNOWN_DTFS[chainId] = [];
  }
  KNOWN_DTFS[chainId].push({ symbol, address });
  console.log(`[nav] Registered DTF: ${symbol} at ${address} on chain ${chainId}`);
}

// Load DTF addresses from environment variables
// Format: DTF_TOKENS=chainId:symbol:address,chainId:symbol:address,...
function loadDtfsFromEnv() {
  const envDtfs = process.env.DTF_TOKENS;
  if (!envDtfs) return;

  const entries = envDtfs.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [chainId, symbol, address] = entry.split(':');
    if (chainId && symbol && address) {
      registerDtf(parseInt(chainId, 10), symbol, address);
    } else {
      console.warn(`[nav] Invalid DTF_TOKENS entry: "${entry}" — expected chainId:symbol:address`);
    }
  }
}

module.exports = {
  calculateRTokenNAV,
  applyNavPricing,
  registerDtf,
  loadDtfsFromEnv,
  KNOWN_DTFS,
};
