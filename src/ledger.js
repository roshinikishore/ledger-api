const { randomUUID } = require('crypto');
const { ApiError, accountNotFound, insufficientBalance } = require('./errors');

const toMoney = (cents) => cents / 100;

const presentAccount = (a) => ({
  id: a.id,
  name: a.name,
  balance: toMoney(a.balance),
  created_at: a.created_at,
});

const presentTx = (t) => ({
  id: t.id,
  account_id: t.account_id,
  type: t.type,
  amount: toMoney(t.amount),
  description: t.description,
  reference_id: t.reference_id,
  created_at: t.created_at,
});

const duplicate = (tx, balance) =>
  new ApiError(409, 'DUPLICATE_TRANSACTION', 'A transaction with this reference_id already exists for this account', {
    transaction: presentTx(tx),
    balance: toMoney(balance),
  });

function createLedger(db) {
  const getAccount = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const insertAccount = db.prepare('INSERT INTO accounts (id, name, balance, created_at) VALUES (?, ?, 0, ?)');
  const findByRef = db.prepare('SELECT * FROM transactions WHERE account_id = ? AND reference_id = ?');
  const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM transactions');
  const insertTx = db.prepare(`INSERT INTO transactions
    (id, account_id, type, amount, description, reference_id, created_at, seq)
    VALUES (@id, @account_id, @type, @amount, @description, @reference_id, @created_at, @seq)`);
  const setBalance = db.prepare('UPDATE accounts SET balance = ? WHERE id = ?');

  // must run inside db.transaction(); any throw rolls everything back
  function applyTransaction(accountId, { type, amount, description, reference_id }) {
    const account = getAccount.get(accountId);
    if (!account) throw accountNotFound(accountId);

    const existing = findByRef.get(accountId, reference_id);
    if (existing) throw duplicate(existing, account.balance);

    const newBalance = type === 'credit' ? account.balance + amount : account.balance - amount;
    if (newBalance < 0) throw insufficientBalance(toMoney(account.balance), toMoney(amount));

    const tx = {
      id: randomUUID(),
      account_id: accountId,
      type,
      amount,
      description,
      reference_id,
      created_at: new Date().toISOString(),
      seq: nextSeq.get().n,
    };
    insertTx.run(tx);
    setBalance.run(newBalance, accountId);
    return { tx, balance: newBalance };
  }

  // immediate = take the write lock first, so two debits can't spend the same balance
  const addTransactionTx = db.transaction((accountId, data) => applyTransaction(accountId, data)).immediate;
  const transferTx = db.transaction((t) => {
    const out = applyTransaction(t.from, {
      type: 'debit', amount: t.amount, description: t.description, reference_id: t.reference_id,
    });
    const into = applyTransaction(t.to, {
      type: 'credit', amount: t.amount, description: t.description, reference_id: t.reference_id,
    });
    return { out, into };
  }).immediate;

  return {
    createAccount({ name }) {
      const account = { id: randomUUID(), name, created_at: new Date().toISOString() };
      insertAccount.run(account.id, account.name, account.created_at);
      return presentAccount(getAccount.get(account.id));
    },

    getBalance(accountId) {
      const account = getAccount.get(accountId);
      if (!account) throw accountNotFound(accountId);
      return { account_id: account.id, balance: toMoney(account.balance) };
    },

    addTransaction(accountId, data) {
      const { tx, balance } = addTransactionTx(accountId, data);
      return { transaction: presentTx(tx), balance: toMoney(balance) };
    },

    getHistory(accountId, { type, page, limit }) {
      if (!getAccount.get(accountId)) throw accountNotFound(accountId);
      const where = type ? 'account_id = ? AND type = ?' : 'account_id = ?';
      const params = type ? [accountId, type] : [accountId];
      const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`).get(...params).n;
      const rows = db
        .prepare(`SELECT * FROM transactions WHERE ${where} ORDER BY created_at DESC, seq DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, (page - 1) * limit);
      return {
        data: rows.map(presentTx),
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
      };
    },

    transfer(t) {
      const { out, into } = transferTx(t);
      return {
        reference_id: t.reference_id,
        amount: toMoney(t.amount),
        from: { account_id: t.from, balance: toMoney(out.balance), transaction: presentTx(out.tx) },
        to: { account_id: t.to, balance: toMoney(into.balance), transaction: presentTx(into.tx) },
      };
    },
  };
}

module.exports = { createLedger };
