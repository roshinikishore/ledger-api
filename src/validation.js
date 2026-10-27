const { validation } = require('./errors');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function requireBody(body) {
  if (!isObject(body)) throw validation('Request body must be a JSON object');
  return body;
}

function requireString(value, field, max = 255) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validation(`'${field}' is required and must be a non-empty string`);
  }
  if (value.trim().length > max) throw validation(`'${field}' must be at most ${max} characters`);
  return value.trim();
}

// 12.34 -> 1234 cents, max 2 decimal places
function toCents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw validation("'amount' must be a number");
  }
  if (amount <= 0) throw validation("'amount' must be greater than 0");
  const cents = Math.round(amount * 100);
  if (Math.abs(cents / 100 - amount) > 1e-9) {
    throw validation("'amount' can have at most 2 decimal places");
  }
  if (cents < 1 || !Number.isSafeInteger(cents)) throw validation("'amount' is out of range");
  return cents;
}

function parsePositiveInt(raw, field, def, max) {
  if (raw === undefined) return def;
  if (!/^\d+$/.test(String(raw))) throw validation(`'${field}' must be a positive integer`);
  const n = Number(raw);
  if (n < 1) throw validation(`'${field}' must be a positive integer`);
  if (max && n > max) throw validation(`'${field}' must be at most ${max}`);
  return n;
}

function validateAccount(body) {
  requireBody(body);
  if ('balance' in body) throw validation("'balance' cannot be set by the client");
  return { name: requireString(body.name, 'name') };
}

function validateTransaction(body) {
  requireBody(body);
  if (body.type !== 'credit' && body.type !== 'debit') {
    throw validation("'type' must be either 'credit' or 'debit'");
  }
  return {
    type: body.type,
    amount: toCents(body.amount),
    description: body.description === undefined ? '' : requireString(String(body.description), 'description', 1000),
    reference_id: requireString(body.reference_id, 'reference_id'),
  };
}

function validateTransfer(body) {
  requireBody(body);
  const from = requireString(body.from_account_id, 'from_account_id');
  const to = requireString(body.to_account_id, 'to_account_id');
  if (from === to) throw validation('Cannot transfer to the same account');
  return {
    from,
    to,
    amount: toCents(body.amount),
    description: body.description === undefined ? '' : requireString(String(body.description), 'description', 1000),
    reference_id: requireString(body.reference_id, 'reference_id'),
  };
}

function validateHistoryQuery(query) {
  const { type } = query;
  if (type !== undefined && type !== 'credit' && type !== 'debit') {
    throw validation("'type' filter must be either 'credit' or 'debit'");
  }
  return {
    type,
    page: parsePositiveInt(query.page, 'page', 1),
    limit: parsePositiveInt(query.limit, 'limit', 10, 100),
  };
}

module.exports = { validateAccount, validateTransaction, validateTransfer, validateHistoryQuery };
