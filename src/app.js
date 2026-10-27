const path = require('path');
const express = require('express');
const { ApiError } = require('./errors');
const { createLedger } = require('./ledger');
const v = require('./validation');

function createApp(db) {
  const ledger = createLedger(db);
  const app = express();

  app.use(express.json({ limit: '100kb' }));
  // frontend is served from here too, so no CORS needed
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.post('/accounts', (req, res) => {
    res.status(201).json(ledger.createAccount(v.validateAccount(req.body)));
  });

  app.get('/accounts/:id/balance', (req, res) => {
    res.json(ledger.getBalance(req.params.id));
  });

  app.post('/accounts/:id/transactions', (req, res) => {
    const data = v.validateTransaction(req.body);
    res.status(201).json(ledger.addTransaction(req.params.id, data));
  });

  app.get('/accounts/:id/transactions', (req, res) => {
    res.json(ledger.getHistory(req.params.id, v.validateHistoryQuery(req.query)));
  });

  // bonus: transfer
  app.post('/transfers', (req, res) => {
    res.status(201).json(ledger.transfer(v.validateTransfer(req.body)));
  });

  // give a clear 405 for edit/delete instead of a plain 404
  app.all('/accounts/:id/transactions/:txId', (req, res, next) => {
    if (['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next(new ApiError(405, 'IMMUTABLE_TRANSACTION', 'Transactions cannot be edited or deleted'));
    }
    next();
  });

  app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`)));

  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });

  return app;
}

module.exports = { createApp };
