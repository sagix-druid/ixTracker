const Moralis = require('moralis').default;

const SUPPORTED_CHAINS = [
  { id: 1, name: 'Ethereum', moralisChain: '0x1' },
  { id: 8453, name: 'Base', moralisChain: '0x2105' },
  { id: 42161, name: 'Arbitrum', moralisChain: '0xa4b1' },
  { id: 10, name: 'Optimism', moralisChain: '0xa' },
];

const DUST_THRESHOLD_USD = 1.0;

let initialized = false;

async function initMoralis() {
  if (initialized) return;
  await Moralis.start({ apiKey: process.env.MORALIS_API_KEY });
  initialized = true;
}

// Batches async queries with delays to respect Moralis rate limits (25 req/sec free tier)
async function batchedQueries(queries, batchSize = 20, delayMs = 1100) {
  const results = [];
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn => fn()));
    results.push(...batchResults);
    if (i + batchSize < queries.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return results;
}

module.exports = {
  SUPPORTED_CHAINS,
  DUST_THRESHOLD_USD,
  initMoralis,
  batchedQueries,
};
