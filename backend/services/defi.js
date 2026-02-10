const { initMoralis, SUPPORTED_CHAINS, delay } = require('./moralis');

// Moralis DeFi Positions API — direct HTTP calls since the SDK
// may not expose these newer endpoints yet.
const MORALIS_API_BASE = 'https://deep-index.moralis.io/api/v2.2';

function getApiKey() {
  const key = process.env.MORALIS_API_KEY;
  if (!key) throw new Error('MORALIS_API_KEY environment variable is required');
  return key;
}

async function moralisFetch(path, params = {}) {
  const url = new URL(`${MORALIS_API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'X-API-Key': getApiKey(),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Moralis API ${response.status}: ${response.statusText} — ${body}`
    );
  }

  return response.json();
}

// GET /wallets/{address}/defi/summary?chain=<chain>
// Returns: { active_protocols, total_positions, total_usd_value,
//            total_unclaimed_usd_value, protocols: [...] }
async function getDefiSummary(walletAddress, chain) {
  const data = await moralisFetch(
    `/wallets/${walletAddress}/defi/summary`,
    { chain: chain.chainParam }
  );

  console.log(
    `[defi] Summary for ${chain.name}: ${data.active_protocols || 0} protocols, $${data.total_usd_value || 0}`
  );

  return {
    chain: chain.name,
    chainId: chain.id,
    activeProtocols: data.active_protocols || 0,
    totalPositions: data.total_positions || 0,
    totalUsdValue: data.total_usd_value || 0,
    totalUnclaimedUsdValue: data.total_unclaimed_usd_value || 0,
    protocols: (data.protocols || []).map((p) => ({
      protocolName: p.protocol_name,
      protocolId: p.protocol_id,
      protocolUrl: p.protocol_url || null,
      protocolLogo: p.protocol_logo || null,
      totalUsdValue: p.total_usd_value || 0,
      totalUnclaimedUsdValue: p.total_unclaimed_usd_value || 0,
      positions: p.positions || 0,
    })),
  };
}

// GET /wallets/{address}/defi/positions?chain=<chain>
// Returns array of position objects with protocol info, tokens, values
async function getDefiPositions(walletAddress, chain) {
  const data = await moralisFetch(
    `/wallets/${walletAddress}/defi/positions`,
    { chain: chain.chainParam }
  );

  // The response is an array of protocol position groups
  const positions = Array.isArray(data) ? data : data.result || [];

  return positions.map((pos) => normalizePosition(pos, chain));
}

// GET /wallets/{address}/defi/{protocol_id}/positions?chain=<chain>
// Returns detailed positions for a specific protocol
async function getDefiPositionsByProtocol(walletAddress, protocolId, chain) {
  const data = await moralisFetch(
    `/wallets/${walletAddress}/defi/${protocolId}/positions`,
    { chain: chain.chainParam }
  );

  const positions = Array.isArray(data) ? data : data.result || [];
  return positions.map((pos) => normalizePosition(pos, chain));
}

// Normalize a single position object from Moralis into our consistent format.
// Moralis returns various shapes depending on protocol — we handle the common fields.
function normalizePosition(raw, chain) {
  // The position may be nested under a "position" key or be top-level
  const pos = raw.position || raw;

  const tokens = (pos.tokens || []).map((t) => ({
    tokenType: t.token_type || 'unknown', // supply, borrow, reward, lp, etc.
    name: t.name || null,
    symbol: t.symbol || null,
    contractAddress: t.contract_address || t.token_address || null,
    decimals: t.decimals || 18,
    balance: t.balance || '0',
    balanceFormatted: parseFloat(t.balance_formatted) || 0,
    usdPrice: t.usd_price !== undefined ? t.usd_price : null,
    usdValue: t.usd_value !== undefined ? t.usd_value : null,
    logo: t.logo || null,
  }));

  return {
    chain: chain.name,
    chainId: chain.id,
    protocolName: raw.protocol_name || pos.protocol_name || 'Unknown',
    protocolId: raw.protocol_id || pos.protocol_id || null,
    protocolUrl: raw.protocol_url || pos.protocol_url || null,
    protocolLogo: raw.protocol_logo || pos.protocol_logo || null,
    label: pos.label || raw.label || 'Position',
    tokens,
    totalUsdValue: pos.total_usd_value || raw.total_usd_value || null,
    positionDetails: pos.position_details || raw.position_details || null,
  };
}

// Fetch DeFi positions across all supported chains
async function getMultiChainDefiPositions(walletAddress) {
  const results = await Promise.allSettled(
    SUPPORTED_CHAINS.map((chain) => getDefiPositions(walletAddress, chain))
  );

  const allPositions = [];
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      allPositions.push(...result.value);
    } else {
      errors.push({
        chain: SUPPORTED_CHAINS[index].name,
        error: result.reason?.message || 'Unknown error',
      });
      console.error(
        `[defi] Failed to fetch positions for ${SUPPORTED_CHAINS[index].name}:`,
        result.reason?.message
      );
    }
  });

  return { positions: allPositions, errors };
}

// Fetch DeFi summary across all supported chains
async function getMultiChainDefiSummary(walletAddress) {
  const results = await Promise.allSettled(
    SUPPORTED_CHAINS.map((chain) => getDefiSummary(walletAddress, chain))
  );

  const summaries = [];
  const errors = [];
  let totalUsdValue = 0;
  let totalUnclaimedUsdValue = 0;
  let totalActiveProtocols = 0;
  let totalPositions = 0;

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      const summary = result.value;
      summaries.push(summary);
      totalUsdValue += summary.totalUsdValue;
      totalUnclaimedUsdValue += summary.totalUnclaimedUsdValue;
      totalActiveProtocols += summary.activeProtocols;
      totalPositions += summary.totalPositions;
    } else {
      errors.push({
        chain: SUPPORTED_CHAINS[index].name,
        error: result.reason?.message || 'Unknown error',
      });
      console.error(
        `[defi] Failed to fetch summary for ${SUPPORTED_CHAINS[index].name}:`,
        result.reason?.message
      );
    }
  });

  return {
    totalUsdValue,
    totalUnclaimedUsdValue,
    totalActiveProtocols,
    totalPositions,
    chains: summaries,
    errors,
  };
}

// Convert DeFi positions into a "holdings-compatible" format so they can be
// merged into the balances response. Each supply/deposit/staked position becomes
// an entry that looks like a token balance with extra metadata.
function defiPositionsToHoldings(positions) {
  const holdings = [];

  for (const pos of positions) {
    for (const token of pos.tokens) {
      // Only include supply/deposit/staked positions (not borrows or rewards separately)
      // Rewards are included but flagged
      const isDeposit = ['supply', 'deposit', 'staked', 'lp'].includes(
        token.tokenType
      );
      const isReward = token.tokenType === 'reward';

      if (!isDeposit && !isReward) continue;
      if (token.usdValue !== null && token.usdValue < 1.0) continue; // dust filter

      holdings.push({
        chain: pos.chain,
        chainId: pos.chainId,
        tokenAddress: token.contractAddress,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        balance: token.balance,
        balanceFormatted: token.balanceFormatted,
        usdPrice: token.usdPrice,
        usdValue: token.usdValue,
        logo: token.logo,
        thumbnail: null,
        priceSource: token.usdPrice ? 'market' : null,
        nativeToken: false,
        portfolioPercentage: 0, // recalculated after merge
        // DeFi-specific metadata
        isDefiPosition: true,
        defiProtocol: pos.protocolName,
        defiProtocolId: pos.protocolId,
        defiProtocolLogo: pos.protocolLogo,
        defiLabel: pos.label,
        defiTokenType: token.tokenType,
      });
    }
  }

  return holdings;
}

module.exports = {
  getDefiSummary,
  getDefiPositions,
  getDefiPositionsByProtocol,
  getMultiChainDefiPositions,
  getMultiChainDefiSummary,
  defiPositionsToHoldings,
};
