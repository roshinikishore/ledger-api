const Database = require('better-sqlite3');

// money is stored as integer cents (floats give 0.1 + 0.2 = 0.30000000000000004)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  balance     INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  type          TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  description   TEXT NOT NULL DEFAULT '',
  reference_id  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  UNIQUE (account_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_tx_account_created
  ON transactions (account_id, created_at DESC, seq DESC);

-- transactions can't be edited or deleted
CREATE TRIGGER IF NOT EXISTS transactions_no_update
BEFORE UPDATE ON transactions
BEGIN SELECT RAISE(ABORT, 'transactions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS transactions_no_delete
BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'transactions are immutable'); END;
`;

function openDb(file = process.env.DB_FILE || 'ledger.db') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
