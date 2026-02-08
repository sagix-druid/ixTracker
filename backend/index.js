const express = require('express');
const cors = require('cors');
require('dotenv').config();

const balancesRouter = require('./routes/balances');
const transactionsRouter = require('./routes/transactions');
const historyRouter = require('./routes/history');
const metricsRouter = require('./routes/metrics');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/balances', balancesRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/history', historyRouter);
app.use('/api/metrics', metricsRouter);

app.listen(PORT, () => {
  console.log(`Sagix Portfolio Tracker API running on port ${PORT}`);
});
