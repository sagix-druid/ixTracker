function calculateCAGR(beginningValue, endingValue, years) {
  if (beginningValue <= 0 || years <= 0) return 0;
  return Math.pow(endingValue / beginningValue, 1 / years) - 1;
}

function calculateSharpeRatio(dailyValues, riskFreeRate = 0.045) {
  if (dailyValues.length < 2) return null;

  const logReturns = [];
  for (let i = 1; i < dailyValues.length; i++) {
    if (dailyValues[i - 1] > 0 && dailyValues[i] > 0) {
      logReturns.push(Math.log(dailyValues[i] / dailyValues[i - 1]));
    }
  }

  if (logReturns.length < 2) return null;

  const meanReturn = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;

  const squaredDiffs = logReturns.map(r => Math.pow(r - meanReturn, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (logReturns.length - 1);
  const dailyStdDev = Math.sqrt(variance);

  const annualizedReturn = meanReturn * 252;
  const annualizedStdDev = dailyStdDev * Math.sqrt(252);

  if (annualizedStdDev === 0) return null;

  return (annualizedReturn - riskFreeRate) / annualizedStdDev;
}

module.exports = {
  calculateCAGR,
  calculateSharpeRatio,
};
