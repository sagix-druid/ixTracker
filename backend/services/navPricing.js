const { ethers } = require('ethers');
const { getTokenPrice, SUPPORTED_CHAINS, delay } = require('./moralis');

// ──────────────────────────────────────────────────────────────────────
// Reserve Protocol DTF NAV Pricing
//
// Supports TWO contract types:
//
// 1. Yield DTFs (RTokens like ETH+):
//    RToken.main() → Main.basketHandler() → BasketHandler.quote()
//
// 2. Index DTFs (Folios like ixEdel, ixETH):
//    Folio.toAssets(1e18, 0) → (address[] assets, uint256[] amounts)
//
// We detect the type by trying toAssets() first (Folio), then falling
// back to main()→basketHandler()→quote() (RToken).
//
// ixETH contains ixEdel in its basket, so we calculate ixEdel first
// and use that result when pricing ixETH's basket.
// ──────────────────────────────────────────────────────────────────────

// Minimal ABIs — only the functions we actually call

// Folio (Index DTF) ABI
const FOLIO_ABI = [
  'function toAssets(uint256 shares, uint8 rounding) external view returns (address[], uint256[])',
  'function totalAssets() external view returns (address[], uint256[])',
  'function totalSupply() external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
];

// RToken (Yield DTF) ABI
const RTOKEN_ABI = [
  'function main() external view returns (address)',
  'function totalSupply() external view returns (uint256)',
  'function decimals() external view returns (uint8)',
];

const MAIN_ABI = [
  'function basketHandler() external view returns (address)',
];

const BASKET_HANDLER_ABI = [
  'function quote(uint192 amount, uint8 rounding) external view returns (address[] memory, uint256[] memory)',
  'function status() external view returns (uint8)',
];

const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
];

// Known DTF tokens that need NAV pricing.
// type: 'folio' for Index DTFs, 'rtoken' for Yield DTFs
// order matters: ixEdel must be calculated before ixETH (dependency)
const KNOWN_DTFS = {
  1: [
    { symbol: 'ixEdel', address: '0xe4a10951f962e6cb93cb843a4ef05d2f99db1f94', type: 'folio' },
    { symbol: 'ixETH', address: '0x60105cbd0499199ca84f63ee9198b2a2d5441699', type: 'folio' },
  ],
  8453: [],
};

// RSR token address on Ethereum — used for pricing vlRSR and staked RSR tokens
const RSR_ADDRESS = '0x320623b8e4ff03373931769a31fc52a4e78b5d70';

// Tokens whose price is derived from RSR (staked/vote-locked RSR)
const RSR_DERIVED_TOKENS = {
  1: [
    '0xffa151ad0a0e2e40f39f9e5e9f87cf9e45e819dd', // eth+RSR
    '0x744119681198b157a20d3e70ec2a456672bcded4', // vlRSR-ixETH
    '0x9f65716046ba5920f5385ebda9fc532ecd8014b7', // vlRSR-ixEdel
  ],
};

function getProvider(chainId) {
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

// ── Folio (Index DTF) NAV calculation ──
// Calls toAssets(1e18, 0) to get basket composition per share
async function calculateFolioNAV(folioAddress, chainId, priceOverrides = {}) {
  const provider = getProvider(chainId);
  const chain = getChainConfig(chainId);
  if (!chain) throw new Error(`Chain ${chainId} not supported`);

  console.log(`[nav] Calculating Folio NAV for ${folioAddress} on chain ${chainId}`);

  const folio = new ethers.Contract(folioAddress, FOLIO_ABI, provider);
  const decimals = Number(await folio.decimals());
  const oneShare = ethers.parseUnits('1', decimals);

  // toAssets(shares, rounding) — rounding 0 = FLOOR
  const [assetAddresses, assetAmounts] = await folio.toAssets(oneShare, 0);

  console.log(`[nav]   Folio basket has ${assetAddresses.length} underlying tokens`);

  if (assetAddresses.length === 0) {
    console.warn(`[nav]   Empty basket for Folio ${folioAddress}`);
    return null;
  }

  let navUsd = 0;
  let unpricedCount = 0;
  const basketTokens = [];

  for (let i = 0; i < assetAddresses.length; i++) {
    const tokenAddr = assetAddresses[i];
    const rawAmount = assetAmounts[i];
    const addrLower = tokenAddr.toLowerCase();

    // Get token metadata
    const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    let tokenDecimals, tokenSymbol;
    try {
      const [rawDec, rawSym] = await Promise.all([
        tokenContract.decimals(),
        tokenContract.symbol(),
      ]);
      tokenDecimals = Number(rawDec);
      tokenSymbol = rawSym;
    } catch {
      tokenDecimals = 18;
      tokenSymbol = 'UNKNOWN';
    }

    const formattedAmount = parseFloat(ethers.formatUnits(rawAmount, tokenDecimals));

    // Check price overrides first (for nested DTFs like ixEdel inside ixETH)
    let tokenUsdPrice = null;
    if (priceOverrides[addrLower] !== undefined) {
      tokenUsdPrice = priceOverrides[addrLower];
      console.log(`[nav]   ${tokenSymbol}: using override price $${tokenUsdPrice.toFixed(4)}`);
    } else {
      const priceData = await getTokenPrice(tokenAddr, chain);
      tokenUsdPrice = priceData?.usdPrice || null;
      if (i < assetAddresses.length - 1) await delay(100);
    }

    const tokenUsdValue = tokenUsdPrice !== null ? formattedAmount * tokenUsdPrice : null;

    basketTokens.push({
      address: tokenAddr,
      symbol: tokenSymbol,
      decimals: tokenDecimals,
      quantityPerUnit: formattedAmount,
      usdPrice: tokenUsdPrice,
      usdValue: tokenUsdValue,
    });

    if (tokenUsdValue !== null) {
      navUsd += tokenUsdValue;
    } else {
      unpricedCount++;
      console.warn(`[nav]   No price for ${tokenSymbol} (${tokenAddr}) — NAV may be incomplete`);
    }

    console.log(
      `[nav]   ${tokenSymbol}: ${formattedAmount} × $${tokenUsdPrice?.toFixed(4) ?? 'N/A'} = $${tokenUsdValue?.toFixed(4) ?? 'N/A'}`
    );
  }

  if (navUsd <= 0) {
    console.warn(`[nav]   NAV is $0 for Folio ${folioAddress}`);
    return null;
  }

  const pricedCount = basketTokens.length - unpricedCount;
  console.log(
    `[nav]   Folio NAV = $${navUsd.toFixed(4)} (${pricedCount}/${basketTokens.length} priced)`
  );

  return {
    rTokenAddress: folioAddress,
    chainId,
    navPerToken: navUsd,
    basketTokens,
    allUnderlyingPriced: unpricedCount === 0,
    pricedCount,
    totalUnderlying: basketTokens.length,
    basketStatus: 'FOLIO',
  };
}

// ── RToken (Yield DTF) NAV calculation ──
// Uses main() → basketHandler() → quote() path
async function calculateRTokenNAV(rTokenAddress, chainId, priceOverrides = {}) {
  const provider = getProvider(chainId);
  const chain = getChainConfig(chainId);
  if (!chain) throw new Error(`Chain ${chainId} not supported`);

  console.log(`[nav] Calculating RToken NAV for ${rTokenAddress} on chain ${chainId}`);

  const rToken = new ethers.Contract(rTokenAddress, RTOKEN_ABI, provider);
  const mainAddress = await rToken.main();
  const main = new ethers.Contract(mainAddress, MAIN_ABI, provider);
  const basketHandlerAddress = await main.basketHandler();
  const basketHandler = new ethers.Contract(basketHandlerAddress, BASKET_HANDLER_ABI, provider);

  const status = Number(await basketHandler.status());
  if (status === 2) {
    console.warn(`[nav]   Basket is DISABLED for ${rTokenAddress}`);
    return null;
  }

  const FIX_ONE = ethers.parseUnits('1', 18);
  const [erc20Addresses, quantities] = await basketHandler.quote(FIX_ONE, 0);

  if (erc20Addresses.length === 0) {
    console.warn(`[nav]   Empty basket for RToken ${rTokenAddress}`);
    return null;
  }

  console.log(`[nav]   RToken basket has ${erc20Addresses.length} underlying tokens`);

  let navUsd = 0;
  let unpricedCount = 0;
  const basketTokens = [];

  for (let i = 0; i < erc20Addresses.length; i++) {
    const tokenAddr = erc20Addresses[i];
    const rawQuantity = quantities[i];
    const addrLower = tokenAddr.toLowerCase();

    const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    let tokenDecimals, tokenSymbol;
    try {
      const [rawDec, rawSym] = await Promise.all([
        tokenContract.decimals(),
        tokenContract.symbol(),
      ]);
      tokenDecimals = Number(rawDec);
      tokenSymbol = rawSym;
    } catch {
      tokenDecimals = 18;
      tokenSymbol = 'UNKNOWN';
    }

    const formattedQuantity = parseFloat(ethers.formatUnits(rawQuantity, tokenDecimals));

    let tokenUsdPrice = null;
    if (priceOverrides[addrLower] !== undefined) {
      tokenUsdPrice = priceOverrides[addrLower];
    } else {
      const priceData = await getTokenPrice(tokenAddr, chain);
      tokenUsdPrice = priceData?.usdPrice || null;
      if (i < erc20Addresses.length - 1) await delay(100);
    }

    const tokenUsdValue = tokenUsdPrice !== null ? formattedQuantity * tokenUsdPrice : null;

    basketTokens.push({
      address: tokenAddr,
      symbol: tokenSymbol,
      decimals: tokenDecimals,
      quantityPerUnit: formattedQuantity,
      usdPrice: tokenUsdPrice,
      usdValue: tokenUsdValue,
    });

    if (tokenUsdValue !== null) {
      navUsd += tokenUsdValue;
    } else {
      unpricedCount++;
      console.warn(`[nav]   No price for ${tokenSymbol} (${tokenAddr})`);
    }

    console.log(
      `[nav]   ${tokenSymbol}: ${formattedQuantity} × $${tokenUsdPrice?.toFixed(4) ?? 'N/A'} = $${tokenUsdValue?.toFixed(4) ?? 'N/A'}`
    );
  }

  if (navUsd <= 0) return null;

  const pricedCount = basketTokens.length - unpricedCount;
  console.log(
    `[nav]   RToken NAV = $${navUsd.toFixed(4)} (${pricedCount}/${basketTokens.length} priced, basket ${status === 0 ? 'SOUND' : 'IFFY'})`
  );

  return {
    rTokenAddress,
    chainId,
    navPerToken: navUsd,
    basketTokens,
    allUnderlyingPriced: unpricedCount === 0,
    pricedCount,
    totalUnderlying: basketTokens.length,
    basketStatus: status === 0 ? 'SOUND' : status === 1 ? 'IFFY' : 'UNKNOWN',
  };
}

// ── Unified NAV calculator ──
// Tries Folio first (Index DTF), falls back to RToken (Yield DTF)
async function calculateDtfNAV(address, chainId, knownType, priceOverrides = {}) {
  if (knownType === 'folio') {
    return calculateFolioNAV(address, chainId, priceOverrides);
  }
  if (knownType === 'rtoken') {
    return calculateRTokenNAV(address, chainId, priceOverrides);
  }
  // Unknown type — try Folio first, fall back to RToken
  try {
    return await calculateFolioNAV(address, chainId, priceOverrides);
  } catch {
    return calculateRTokenNAV(address, chainId, priceOverrides);
  }
}

// Apply NAV pricing to token balances.
// Handles dependency ordering (ixEdel before ixETH) and RSR-derived tokens.
async function applyNavPricing(tokens, extraDtfAddresses = []) {
  // Build lookup of known DTFs by chain
  const dtfsByChain = {};
  for (const [chainId, dtfs] of Object.entries(KNOWN_DTFS)) {
    dtfsByChain[chainId] = dtfsByChain[chainId] || [];
    dtfsByChain[chainId].push(...dtfs);
  }
  for (const { address, chainId, symbol, type } of extraDtfAddresses) {
    dtfsByChain[chainId] = dtfsByChain[chainId] || [];
    dtfsByChain[chainId].push({ symbol: symbol || 'UNKNOWN', address: address.toLowerCase(), type: type || 'folio' });
  }

  // Build address set for quick lookup
  const dtfAddressSet = {};
  for (const [chainId, dtfs] of Object.entries(dtfsByChain)) {
    dtfAddressSet[chainId] = new Set(dtfs.map((d) => d.address.toLowerCase()));
  }

  // Find tokens needing NAV pricing
  const tokensNeedingNav = tokens.filter((t) => {
    if (t.usdPrice !== null) return false;
    if (!t.tokenAddress) return false;
    const knownSet = dtfAddressSet[t.chainId];
    return knownSet && knownSet.has(t.tokenAddress.toLowerCase());
  });

  console.log(`[nav] ${tokensNeedingNav.length} known DTFs with null price — attempting NAV pricing`);

  // Calculate NAV in dependency order (ixEdel before ixETH)
  // priceOverrides accumulates results so nested DTFs can use parent prices
  const navResults = {};
  const priceOverrides = {};

  for (const [chainId, dtfs] of Object.entries(dtfsByChain)) {
    for (const dtf of dtfs) {
      const matchingToken = tokensNeedingNav.find(
        (t) => t.chainId === Number(chainId) && t.tokenAddress?.toLowerCase() === dtf.address.toLowerCase()
      );
      if (!matchingToken) continue;

      try {
        const nav = await calculateDtfNAV(dtf.address, Number(chainId), dtf.type, priceOverrides);
        if (nav) {
          const key = `${chainId}:${dtf.address}`;
          navResults[key] = nav;
          // Store price so downstream DTFs (ixETH) can price this token in their basket
          priceOverrides[dtf.address.toLowerCase()] = nav.navPerToken;
          console.log(`[nav] ${dtf.symbol} NAV = $${nav.navPerToken.toFixed(4)}`);
        }
      } catch (err) {
        console.log(`[nav] ${dtf.symbol} NAV calculation failed: ${err.message}`);
      }
    }
  }

  // ── RSR-derived token pricing ──
  // vlRSR and staked RSR tokens are worth approximately balance × RSR_price
  const rsrDerivedSet = {};
  for (const [chainId, addrs] of Object.entries(RSR_DERIVED_TOKENS)) {
    rsrDerivedSet[chainId] = new Set(addrs.map((a) => a.toLowerCase()));
  }

  const rsrDerivedTokens = tokens.filter((t) => {
    if (t.usdPrice !== null) return false;
    if (!t.tokenAddress) return false;
    const set = rsrDerivedSet[t.chainId];
    return set && set.has(t.tokenAddress.toLowerCase());
  });

  let rsrPrice = null;
  if (rsrDerivedTokens.length > 0) {
    console.log(`[nav] ${rsrDerivedTokens.length} RSR-derived tokens — fetching RSR price`);
    const chain = getChainConfig(1);
    if (chain) {
      const priceData = await getTokenPrice(RSR_ADDRESS, chain);
      rsrPrice = priceData?.usdPrice || null;
      console.log(`[nav] RSR price: $${rsrPrice?.toFixed(6) ?? 'N/A'}`);
    }
  }

  // Apply all calculated prices to the token array
  const updatedTokens = tokens.map((token) => {
    if (token.usdPrice !== null) return token;
    if (!token.tokenAddress) return token;

    // Check NAV results (DTFs)
    const key = `${token.chainId}:${token.tokenAddress}`;
    const nav = navResults[key];
    if (nav) {
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

    // Check RSR-derived tokens
    const rsrSet = rsrDerivedSet[token.chainId];
    if (rsrPrice && rsrSet && rsrSet.has(token.tokenAddress.toLowerCase())) {
      const usdValue = token.balanceFormatted * rsrPrice;
      return {
        ...token,
        usdPrice: rsrPrice,
        usdValue,
        priceSource: 'rsr-derived',
      };
    }

    return token;
  });

  return updatedTokens;
}

function registerDtf(chainId, symbol, address, type = 'folio') {
  if (!KNOWN_DTFS[chainId]) {
    KNOWN_DTFS[chainId] = [];
  }
  KNOWN_DTFS[chainId].push({ symbol, address, type });
}

function loadDtfsFromEnv() {
  const envDtfs = process.env.DTF_TOKENS;
  if (!envDtfs) return;
  const entries = envDtfs.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [chainId, symbol, address, type] = entry.split(':');
    if (chainId && symbol && address) {
      registerDtf(parseInt(chainId, 10), symbol, address, type || 'folio');
    }
  }
}

module.exports = {
  calculateFolioNAV,
  calculateRTokenNAV,
  calculateDtfNAV,
  applyNavPricing,
  registerDtf,
  loadDtfsFromEnv,
  KNOWN_DTFS,
  RSR_DERIVED_TOKENS,
};
