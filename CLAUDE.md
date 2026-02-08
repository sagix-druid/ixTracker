# Sagix Portfolio Tracker Widget

## ⚠️ CRITICAL: NO MOCK DATA — ENGINE FIRST

### The Problem with AI-Generated Code
There is a massive risk that Claude (or any LLM) will go the "lazy" route. LLMs prioritize the "look" of the code over the "plumbing" because the plumbing (calculating cost basis across multiple chains) is computationally expensive to think through.

**Why it happens:**
1. **Complexity Shielding**: The model thinks it's "helping" by not overwhelming you with a 400-line function
2. **Context Limits**: Full logic for Moralis integration hits output token limits, so the AI short-circuits to placeholders
3. **Ambiguity**: "Build a dashboard" makes the AI focus on UI rather than the data engine

**There is nothing more frustrating than a beautiful UI filled with:**
```javascript
const price = 50000; // Mock data
const sharpeRatio = 1.24; // TODO: Calculate
```

This is a movie set, not a functional building.

### The Rule: ENGINE FIRST, UI SECOND

**Do NOT write any UI component until the data layer is complete and returns real data.**

When building this project:
1. Start with `backend/services/moralis.js` — real API calls, real responses
2. Then `backend/services/calculations.js` — real math, tested formulas
3. Then `backend/routes/*.js` — real endpoints returning real data
4. Only THEN build React components that consume real data

### Explicit Instructions for Claude

**READ THIS BEFORE WRITING ANY CODE:**

> "I do not want any mock data or UI placeholders. If a function requires an API call to Moralis, write the full async logic, handle the headers, and map the real JSON response. If the math is complex, write the full utility function, not a return statement with a hardcoded number."

**For Moralis calls:**
- Initialize the SDK properly
- Use real endpoint paths
- Handle rate limits with delays
- Parse actual response schemas
- If you don't know the schema, ASK for a sample response

**For calculations:**
- Write the full mathematical implementation
- No placeholder returns
- Include edge case handling (division by zero, empty arrays, etc.)

### Strict Math Requirements

**CAGR — must be calculated, not mocked:**
```javascript
// WRONG ❌
const cagr = 0.15; // 15% placeholder

// RIGHT ✅
function calculateCAGR(beginningValue, endingValue, years) {
  if (beginningValue <= 0 || years <= 0) return 0;
  return Math.pow(endingValue / beginningValue, 1 / years) - 1;
}
```

**Sharpe Ratio — full implementation required:**

Formula: `Sharpe = (Rp - Rf) / σp`

Where:
- `Rp` = annualized portfolio return
- `Rf` = risk-free rate (0.045 for US T-bills)
- `σp` = standard deviation of daily log returns, annualized

```javascript
// WRONG ❌
const sharpeRatio = 1.24;

// RIGHT ✅
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
  const meanReturn = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  
  // Standard deviation of daily returns
  const squaredDiffs = logReturns.map(r => Math.pow(r - meanReturn, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (logReturns.length - 1);
  const dailyStdDev = Math.sqrt(variance);
  
  // Annualize (252 trading days)
  const annualizedReturn = meanReturn * 252;
  const annualizedStdDev = dailyStdDev * Math.sqrt(252);
  
  if (annualizedStdDev === 0) return null;
  
  return (annualizedReturn - riskFreeRate) / annualizedStdDev;
}
```

**Do NOT use a placeholder value. Write the function to calculate σp from an array of historical values.**

### Anti-Lazy Sprint Prompts

When starting Sprint 2 (Moralis Integration), use this prompt:

> "We are starting the Sagix Portfolio Tracker. We are skipping the UI for now. Write a production-ready Node.js service for `balances.js`. This service must:
> 
> 1. Initialize the Moralis SDK
> 2. Loop through the SUPPORTED_CHAINS array
> 3. Call `getWalletTokenBalances` for each chain using Promise.allSettled
> 4. Merge results into a single array, filtering out dust (balances < $1)
> 5. Include error handling for rate limits (use delay if needed)
> 
> Do NOT use mock data. If you don't have the full Moralis response schema, ask me to provide a sample so you can map it accurately."

### Data Flow Blueprint (Verify Before UI)

Before writing ANY React component, this flow must work end-to-end with real data:

```
1. Wallet connects → get address
2. Backend receives address
3. Backend calls Moralis getWalletTokenBalances (all 4 chains)
4. Backend calls Moralis getWalletHistory (for cost basis)
5. Backend calculates: cost basis, PnL per token
6. Backend calls Moralis historical prices (for time series)
7. Backend calculates: daily portfolio values, CAGR, Sharpe
8. API returns complete, real data object
9. ONLY THEN: Frontend renders that data
```

Test each step in isolation. Use `console.log` liberally. Verify real numbers before moving on.

---

## Project Overview

### Goal
Build an embeddable portfolio tracker widget that shows crypto investors their true risk-adjusted performance. Users connect their wallet, see holdings across chains, and get metrics that matter: cost basis, PnL, CAGR, and Sharpe ratio.

### Strategic Purpose
This is a Sagix Club distribution tool. When users see their portfolio's Sharpe ratio, they can simulate adding ixEDEL and see improvement. The widget proves the defensive thesis with the user's own data.

### Target Deployment
- Embeddable widget for Ghost website (sagix.io)
- Standalone page option
- Mobile responsive

---

## Core Features (MVP)

### 1. Wallet Connection
- Connect via WalletConnect / MetaMask
- Support multiple chains: Ethereum, Base, Arbitrum, Optimism, Gnosis

### 2. Holdings Table
| Column | Description |
|--------|-------------|
| Asset | Token symbol + icon |
| Date Acquired | First purchase date |
| Quantity | Number of tokens held |
| Cost Basis | Total USD spent to acquire |
| Avg Buy Price | Cost basis / quantity |
| Current Price | Live price from Moralis |
| Current Value | Quantity × current price |
| PnL ($) | Current value - cost basis |
| PnL (%) | (Current value - cost basis) / cost basis |

### 3. Portfolio Charts
- **Stacked Area Chart**: Portfolio value over time, colored by asset
- **Pie Chart**: Current allocation by asset

### 4. Portfolio Metrics
- **Total Value**: Sum of all holdings
- **Total Cost Basis**: Sum of all money invested
- **Total PnL**: Total value - total cost basis
- **CAGR**: Compound annual growth rate
- **Sharpe Ratio**: Risk-adjusted return (excess return / standard deviation)

---

## Technical Architecture

### Frontend
- **Framework**: React (for Ghost embed compatibility)
- **Styling**: Tailwind CSS
- **Charts**: Recharts or Chart.js
- **Wallet**: RainbowKit + wagmi (simplest wallet connection)

### Backend
- **Runtime**: Node.js or serverless functions
- **API**: Moralis Web3 Data API
- **No database needed**: All data derived from on-chain + Moralis

### Data Flow
```
User connects wallet
        ↓
Frontend calls backend with wallet address
        ↓
Backend queries Moralis:
  - Get current balances (multi-chain)
  - Get transaction history (for cost basis)
  - Get historical prices (for charts)
        ↓
Backend calculates:
  - Cost basis per token
  - Historical portfolio value
  - CAGR and Sharpe ratio
        ↓
Frontend renders:
  - Holdings table
  - Stacked area chart
  - Pie chart
  - Metrics cards
```

### Moralis API Endpoints Needed
1. `getWalletTokenBalances` - Current holdings
2. `getWalletHistory` - Transaction history for cost basis
3. `getTokenPrice` - Current prices
4. `getTokenPrice` with `to_block` - Historical prices

### Chains Configuration
```javascript
const SUPPORTED_CHAINS = [
  { id: 1, name: 'Ethereum', moralisChain: 'eth' },
  { id: 8453, name: 'Base', moralisChain: 'base' },
  { id: 42161, name: 'Arbitrum', moralisChain: 'arbitrum' },
  { id: 10, name: 'Optimism', moralisChain: 'optimism' },
];
```

### Multi-Chain Fetching Pattern
Use `Promise.allSettled` when fetching balances across multiple chains so one slow chain doesn't hang the whole UI:
```javascript
const results = await Promise.allSettled(
  SUPPORTED_CHAINS.map(chain => fetchBalances(walletAddress, chain))
);

const balances = results
  .filter(r => r.status === 'fulfilled')
  .flatMap(r => r.value);
```

### Dust Filter
Filter out any token balances worth less than $1.00. This prevents the UI from being cluttered with spam airdrops and dust left over from old swaps:
```javascript
const DUST_THRESHOLD_USD = 1.00;

const filteredBalances = balances.filter(
  token => token.valueUsd >= DUST_THRESHOLD_USD
);
```

### Ghost CSS Scoping
Since this is for a Ghost embed, ensure all Tailwind classes are prefixed or use Shadow DOM. The widget's CSS must not affect the Sagix website's styling.

Option 1 - Tailwind Prefix:
```javascript
// tailwind.config.js
module.exports = {
  prefix: 'spw-', // sagix-portfolio-widget
  // ...
}
```

Option 2 - Shadow DOM (preferred for true isolation):
```javascript
// Wrap widget in Shadow DOM to fully isolate styles
const shadowRoot = hostElement.attachShadow({ mode: 'open' });
```

---

## Calculations Reference

### Cost Basis
For each token:
1. Get all incoming transfers (buys, receives)
2. For swaps: value = USD value of token sent
3. For direct buys: value = ETH/USD spent
4. Sum all acquisition costs

### CAGR (Compound Annual Growth Rate)
```
CAGR = (Ending Value / Beginning Value)^(1/years) - 1
```
- Beginning Value = Total cost basis
- Ending Value = Current portfolio value
- Years = Time since first transaction

### Sharpe Ratio
```
Sharpe = (Portfolio Return - Risk Free Rate) / Standard Deviation of Returns
```
- **Input: Array of TOTAL PORTFOLIO VALUES per day** (not individual token prices)
- Each daily value = sum of (token_balance × token_price) for ALL tokens
- Use daily log returns for standard deviation
- Risk free rate = ~4.5% (current US T-bill rate)
- Annualize: multiply mean daily return by 252, multiply daily std dev by √252
- Need minimum 30 days of data for meaningful Sharpe

### Historical Portfolio Value (for stacked area chart)
For each day/week in range:
1. Get holdings at that block (from tx history)
2. Get price of each token at that block
3. Sum (holdings × price) per token
4. Stack by token for chart

---

## Sprint Breakdown

### Sprint 1: Project Setup
**Goal**: Boilerplate with wallet connection working

**Tasks**:
1. Initialize React project with Vite
2. Install dependencies: wagmi, rainbowkit, tailwindcss
3. Configure RainbowKit with supported chains
4. Create basic layout component
5. Add "Connect Wallet" button
6. Display connected address when connected

**Deliverable**: Page with working wallet connect/disconnect

---

### Sprint 2: Moralis Integration
**Goal**: Fetch and display current balances

**Tasks**:
1. Set up Moralis API key (environment variable)
2. Create backend API route: `/api/balances`
3. Implement `getWalletTokenBalances` for all chains
4. Aggregate balances across chains
5. Return formatted token list with prices
6. Display raw balance data in frontend (JSON for now)

**Deliverable**: Console log showing all token balances with prices

---

### Sprint 3: Holdings Table
**Goal**: Render holdings in a sortable table

**Tasks**:
1. Create HoldingsTable component
2. Map balance data to table rows
3. Add columns: Asset, Quantity, Current Price, Current Value
4. Add token icons (Moralis provides these)
5. Format numbers (USD formatting, decimal places)
6. Add sorting by column click
7. Style with Tailwind

**Deliverable**: Clean holdings table showing current positions

---

### Sprint 4: Transaction History & Cost Basis
**Goal**: Calculate cost basis from on-chain history

**⚠️ CRITICAL RULE FOR SWAPS**: 
> If a transaction is a swap, the cost basis of the received token is the USD value of the **spent** token at the time of the swap. Do NOT assume cost = 0.

This is the #1 mistake AI makes when calculating crypto PnL — it treats swaps as "received for free" because it doesn't see a "buy" event.

**Example:**
```
User swaps 1 ETH ($3,000) for 1,500 USDC
→ Cost basis of 1,500 USDC = $3,000 (the value of what was spent)
→ NOT $0 because "no fiat was spent"
```

**Tasks**:
1. Create backend route: `/api/transactions`
2. Implement `getWalletHistory` for all chains
3. Filter for relevant transaction types (transfers in, swaps)
4. **For each token, calculate total cost basis:**
   - Direct buys: cost = fiat/ETH spent
   - **Swaps: cost = USD value of token SENT at time of swap**
   - Transfers received: cost = USD price at time of transfer
   - Airdrops: cost = 0 (but flag as airdrop)
5. Handle edge cases:
   - Multi-hop swaps (A → B → C)
   - Partial sells (reduce cost basis proportionally)
   - Bridge transactions
6. Return cost basis per token
7. Add Cost Basis, Avg Price, PnL columns to table

**Deliverable**: Holdings table with full PnL data

---

### Sprint 5: Pie Chart
**Goal**: Show current allocation visualization

**Tasks**:
1. Install Recharts
2. Create AllocationPieChart component
3. Transform holdings data to pie chart format
4. Add colors per asset (consistent palette)
5. Add labels with percentages
6. Add legend
7. Add tooltip on hover
8. Handle "Other" category for small holdings (<2%)

**Deliverable**: Interactive pie chart of current allocation

---

### Sprint 6: Historical Data Collection
**Goal**: Build time series of portfolio value

**⚠️ RATE LIMIT WARNING**: If a user has 10 tokens and you want 30 days of history, that's 300 calls to `getTokenPrice`. On Moralis free tier (25 req/sec), this will trigger rate limits even with `Promise.allSettled`.

**Required: Implement batching with delays:**
```javascript
async function batchedPriceQueries(queries, batchSize = 20, delayMs = 1000) {
  const results = [];
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(q => fetchPrice(q)));
    results.push(...batchResults);
    
    // Delay between batches to avoid rate limits
    if (i + batchSize < queries.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return results;
}
```

**Tasks**:
1. Create backend route: `/api/history`
2. Determine date range (first tx to today)
3. Sample at reasonable intervals (daily for <1yr, weekly for >1yr)
4. **Implement batched price fetching with delays**
5. For each sample point:
   - Calculate holdings at that block
   - Fetch historical prices (batched)
   - Calculate **TOTAL PORTFOLIO VALUE** (sum of all holdings × prices)
6. Structure data for stacked area chart
7. Cache results (expensive query — consider localStorage or backend cache)

**Critical for Sharpe**: The Sharpe ratio needs **total portfolio value per day**, not individual token prices. You must sum `(token_balance × token_price)` for ALL tokens on EACH day to get the daily portfolio values array.

**Deliverable**: API returning portfolio value time series by asset

---

### Sprint 7: Stacked Area Chart
**Goal**: Visualize portfolio growth over time

**Tasks**:
1. Create PortfolioChart component
2. Configure Recharts AreaChart with stacking
3. Map historical data to chart format
4. Add X-axis (dates) with proper formatting
5. Add Y-axis (USD value) with formatting
6. Color each asset area (match pie chart colors)
7. Add tooltip showing breakdown on hover
8. Add legend
9. Handle loading state

**Deliverable**: Stacked area chart showing portfolio evolution

---

### Sprint 8: Portfolio Metrics
**Goal**: Calculate and display CAGR and Sharpe

**Tasks**:
1. Create backend route: `/api/metrics`
2. Implement CAGR calculation
3. Implement daily returns calculation
4. Implement Sharpe ratio calculation
5. Create MetricsCard component
6. Display: Total Value, Cost Basis, PnL, CAGR, Sharpe
7. Add tooltips explaining each metric
8. Color code (green for positive, red for negative)

**Deliverable**: Metrics dashboard with all KPIs

---

### Sprint 9: Widget Embed Mode
**Goal**: Make embeddable in Ghost

**Tasks**:
1. Create embed entry point (iframe-friendly)
2. Add URL parameters for configuration:
   - `?theme=dark|light`
   - `?hide=pie,table` (optional component hiding)
3. Handle responsive sizing
4. Test embed in Ghost post
5. Create embed code snippet generator
6. Handle cross-origin considerations

**Deliverable**: Working embed in Ghost website

---

### Sprint 10: Polish & Edge Cases
**Goal**: Production-ready quality

**Tasks**:
1. Add loading skeletons
2. Add error states with retry
3. Handle empty wallet (no tokens)
4. Handle unsupported tokens (no price data)
5. Add "Last updated" timestamp
6. Add manual refresh button
7. Mobile responsive testing
8. Performance optimization (memoization, lazy loading)
9. Add Sagix branding (subtle)

**Deliverable**: Polished, production-ready widget

---

## File Structure
```
sagix-portfolio-tracker/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── WalletConnect.jsx
│   │   │   ├── HoldingsTable.jsx
│   │   │   ├── AllocationPieChart.jsx
│   │   │   ├── PortfolioChart.jsx
│   │   │   ├── MetricsCard.jsx
│   │   │   └── Layout.jsx
│   │   ├── hooks/
│   │   │   ├── usePortfolio.js
│   │   │   └── useMetrics.js
│   │   ├── utils/
│   │   │   ├── formatting.js
│   │   │   └── calculations.js
│   │   ├── providers.jsx
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── index.html
│   ├── tailwind.config.js
│   └── package.json
├── backend/
│   ├── routes/
│   │   ├── balances.js
│   │   ├── transactions.js
│   │   ├── history.js
│   │   └── metrics.js
│   ├── services/
│   │   ├── moralis.js
│   │   └── calculations.js
│   ├── index.js
│   └── package.json
├── CLAUDE.md
└── README.md
```

### Providers Pattern
Keep App.jsx clean by wrapping Web3 context in a dedicated providers file:

```javascript
// frontend/src/providers.jsx
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { config } from './wagmi.config';

const queryClient = new QueryClient();

export function Providers({ children }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({
          accentColor: '#d4a017', // Sagix gold
          borderRadius: 'medium',
        })}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
```

```javascript
// frontend/src/main.jsx
import { Providers } from './providers';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(
  <Providers>
    <App />
  </Providers>
);
```

This keeps wallet state management separate from UI logic.

---

## Environment Variables
```
# Frontend
VITE_WALLETCONNECT_PROJECT_ID=xxx
VITE_API_URL=http://localhost:3001

# Backend
MORALIS_API_KEY=xxx
PORT=3001
```

---

## Design Guidelines

### Colors (Dark Theme - matches Sagix branding)
- Background: #0a0a0a
- Card Background: #1a1a1a
- Border: #333333
- Text Primary: #e8e8e8
- Text Secondary: #888888
- Accent Gold: #d4a017
- Positive: #7dce7d
- Negative: #ce7d7d

### Chart Colors (for assets)
```javascript
const ASSET_COLORS = [
  '#d4a017', // Gold (primary)
  '#627EEA', // Ethereum blue
  '#F7931A', // Bitcoin orange
  '#2775CA', // USDC blue
  '#26A17B', // Tether green
  '#8A2BE2', // Purple
  '#FF6B6B', // Coral
  '#4ECDC4', // Teal
];
```

### Typography
- Font: System fonts (-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)
- Headings: Semi-bold
- Numbers: Tabular figures for alignment

---

## Testing Checklist

### Wallet Scenarios
- [ ] Fresh wallet (no history)
- [ ] Single chain wallet
- [ ] Multi-chain wallet
- [ ] Whale wallet (many tokens)
- [ ] Wallet with DTF tokens (ixEDEL, ETH+)
- [ ] Wallet with unsupported tokens

### Edge Cases
- [ ] Token with no price data
- [ ] Very old transactions (2020+)
- [ ] Recent transactions (same day)
- [ ] Negative PnL display
- [ ] Very small holdings (<$1)
- [ ] Very large holdings (>$1M)

### Performance
- [ ] Initial load < 3 seconds
- [ ] Chart renders smoothly
- [ ] No memory leaks on refresh

---

## Future Enhancements (Post-MVP)

1. **ixEDEL Simulator**: "What if you added 10% ixEDEL?" - show improved Sharpe
2. **Export**: CSV download of holdings
3. **Alerts**: Price/PnL notifications
4. **Compare**: Benchmark vs BTC, ETH, S&P500
5. **Tax Report**: Cost basis report for tax purposes
6. **Multi-wallet**: Track multiple addresses
7. **DeFi Positions**: Show LP positions, staking, etc.

---

## Notes for Claude

### ABSOLUTE RULES — READ FIRST
1. **NO MOCK DATA** — Every value displayed must come from a real API call or real calculation
2. **ENGINE FIRST** — Do not write UI until the data layer returns real data
3. **ASK IF UNSURE** — If you don't know a Moralis response schema, ask for a sample

### When building, prioritize:
1. Real data > Working > Perfect
2. Backend complete before frontend starts
3. One sprint at a time — verify data is real before moving on
4. Console.log everything — prove the numbers are real
5. Comments explaining "why" not "what"

### Red flags that indicate lazy code:
- `// Mock data` or `// TODO` comments
- Hardcoded numbers for prices, returns, ratios
- Empty function bodies with `return placeholder`
- UI components that don't consume real props

### If you hit complexity limits:
- STOP and ask for clarification
- Break the function into smaller pieces
- Do NOT substitute a placeholder "to be filled in later"

### Common Moralis gotchas:
- Rate limits: 25 requests/second on free tier — add delays
- Some tokens return null price — filter them, don't mock
- Historical prices need block number, not timestamp
- Multi-chain queries should be parallelized with Promise.allSettled

### Cost basis complexity:
- Perfect cost basis is hard (CEX transfers, bridges, etc.)
- MVP: Best effort from on-chain data
- Show disclaimer: "Cost basis estimated from on-chain data"
- But the calculation logic must be REAL, not mocked
