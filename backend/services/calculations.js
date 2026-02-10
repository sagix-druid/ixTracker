// ──────────────────────────────────────────────────────────────────────
// Portfolio Calculations — REAL math, no mock data
//
// All functions take arrays of real data and return computed values.
// ──────────────────────────────────────────────────────────────────────

function calculateCAGR(beginningValue, endingValue, years) {
  if (beginningValue <= 0 || years <= 0) return 0;
  return Math.pow(endingValue / beginningValue, 1 / years) - 1;
}

// Sharpe ratio from an array of daily total portfolio values.
// Requires at least 30 data points for a meaningful result.
function calculateSharpeRatio(dailyValues, riskFreeRate = 0.045) {
  if (dailyValues.length < 2) return null;

  // Calculate daily log returns
  const logReturns = [];
  for (let i = 1; i < dailyValues.length; i++) {
    if (dailyValues[i - 1] > 0 && dailyValues[i] > 0) {
      logReturns.push(Math.log(dailyValues[i] / dailyValues[i - 1]));
    }
  }

  if (logReturns.length < 2) return null;

  // Mean daily return
  const meanReturn =
    logReturns.reduce((a, b) => a + b, 0) / logReturns.length;

  // Standard deviation of daily returns (sample std dev)
  const squaredDiffs = logReturns.map((r) => Math.pow(r - meanReturn, 2));
  const variance =
    squaredDiffs.reduce((a, b) => a + b, 0) / (logReturns.length - 1);
  const dailyStdDev = Math.sqrt(variance);

  // Annualize (252 trading days — crypto trades 365 but we use the
  // traditional finance convention to match industry Sharpe ratios)
  const annualizedReturn = meanReturn * 252;
  const annualizedStdDev = dailyStdDev * Math.sqrt(252);

  if (annualizedStdDev === 0) return null;

  return (annualizedReturn - riskFreeRate) / annualizedStdDev;
}

// Recalculate portfolio percentages after merging token sources
function recalculatePortfolioPercentages(tokens) {
  const totalValue = tokens.reduce((sum, t) => sum + (t.usdValue || 0), 0);
  if (totalValue <= 0) return tokens;

  return tokens.map((t) => ({
    ...t,
    portfolioPercentage:
      t.usdValue !== null ? (t.usdValue / totalValue) * 100 : 0,
  }));
}

module.exports = {
  calculateCAGR,
  calculateSharpeRatio,
  recalculatePortfolioPercentages,
};
