const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let server, base, db;

before(async () => {
  db = openDb(':memory:');
  server = createApp(db).listen(0);
  // Don't let the listening socket keep the process alive once the tests are done
  // (top-level after() hooks don't run on older Node 18 releases).
  server.unref();
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
});
beforeEach(() => {
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TRIGGER transactions_no_delete');
  db.exec('DELETE FROM transactions; DELETE FROM accounts;');
  db.exec(`CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions
           BEGIN SELECT RAISE(ABORT, 'transactions are immutable'); END;`);
  db.pragma('foreign_keys = ON');
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    // 'connection: close' stops idle keep-alive sockets from holding the test process open.
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const newAccount = async (name = 'Alice') => (await call('POST', '/accounts', { name })).body;
const tx = (id, type, amount, ref) =>
  call('POST', `/accounts/${id}/transactions`, { type, amount, reference_id: ref, description: 'test' });
const balance = async (id) => (await call('GET', `/accounts/${id}/balance`)).body.balance;

test('create account: balance starts at 0, id and created_at generated', async () => {
  const r = await call('POST', '/accounts', { name: 'Alice' });
  assert.equal(r.status, 201);
  assert.equal(r.body.balance, 0);
  assert.ok(r.body.id && r.body.created_at);
});

test('create account: name required, balance cannot be set', async () => {
  assert.equal((await call('POST', '/accounts', {})).status, 400);
  assert.equal((await call('POST', '/accounts', { name: '  ' })).status, 400);
  const r = await call('POST', '/accounts', { name: 'Bob', balance: 999 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION_ERROR');
});

test('account ids are unique', async () => {
  const a = await newAccount();
  const b = await newAccount();
  assert.notEqual(a.id, b.id);
});

test('credit then debit examples from the spec', async () => {
  const { id } = await newAccount();
  await tx(id, 'credit', 100, 'r1');
  assert.equal((await tx(id, 'credit', 50, 'r2')).body.balance, 150);
  assert.equal((await tx(id, 'debit', 30, 'r3')).body.balance, 120);
  assert.equal(await balance(id), 120);
});

test('final balance example: 100+50-30-20 = 100', async () => {
  const { id } = await newAccount();
  await tx(id, 'credit', 100, 'a');
  await tx(id, 'credit', 50, 'b');
  await tx(id, 'debit', 30, 'c');
  await tx(id, 'debit', 20, 'd');
  assert.equal(await balance(id), 100);
});

test('debit larger than balance is rejected and balance unchanged', async () => {
  const { id } = await newAccount();
  await tx(id, 'credit', 100, 'a');
  const r = await tx(id, 'debit', 150, 'b');
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal(await balance(id), 100);
  // rejected transaction was not stored
  const h = await call('GET', `/accounts/${id}/transactions`);
  assert.equal(h.body.pagination.total, 1);
});

test('duplicate reference_id: 409, no new row, balance unchanged', async () => {
  const { id } = await newAccount();
  await tx(id, 'credit', 100, 'same');
  const r = await tx(id, 'credit', 100, 'same');
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DUPLICATE_TRANSACTION');
  assert.equal(await balance(id), 100);
  assert.equal((await call('GET', `/accounts/${id}/transactions`)).body.pagination.total, 1);
});

test('same reference_id is allowed on different accounts', async () => {
  const a = await newAccount('A');
  const b = await newAccount('B');
  assert.equal((await tx(a.id, 'credit', 10, 'shared')).status, 201);
  assert.equal((await tx(b.id, 'credit', 10, 'shared')).status, 201);
});

test('transaction validation', async () => {
  const { id } = await newAccount();
  assert.equal((await tx(id, 'refund', 10, 'r')).status, 400);
  assert.equal((await tx(id, 'credit', 0, 'r')).status, 400);
  assert.equal((await tx(id, 'credit', -5, 'r')).status, 400);
  assert.equal((await tx(id, 'credit', '10', 'r')).status, 400);
  assert.equal((await tx(id, 'credit', 1.234, 'r')).status, 400);
  assert.equal((await call('POST', `/accounts/${id}/transactions`, { type: 'credit', amount: 5 })).status, 400);
  assert.equal((await call('POST', `/accounts/${id}/transactions`, '{bad json')).status, 400);
  assert.equal((await call('POST', `/accounts/${id}/transactions`, [1])).status, 400);
  assert.equal(await balance(id), 0);
});

test('unknown account -> 404', async () => {
  assert.equal((await tx('nope', 'credit', 10, 'r')).status, 404);
  const b = await call('GET', '/accounts/nope/balance');
  assert.equal(b.status, 404);
  assert.equal(b.body.error.code, 'ACCOUNT_NOT_FOUND');
  assert.equal((await call('GET', '/accounts/nope/transactions')).status, 404);
});

test('decimal amounts are exact', async () => {
  const { id } = await newAccount();
  await tx(id, 'credit', 0.1, 'a');
  await tx(id, 'credit', 0.2, 'b');
  assert.equal(await balance(id), 0.3);
});

test('history: latest first, filter, pagination', async () => {
  const { id } = await newAccount();
  for (let i = 1; i <= 5; i++) await tx(id, 'credit', 10, `c${i}`);
  for (let i = 1; i <= 2; i++) await tx(id, 'debit', 1, `d${i}`);

  const all = await call('GET', `/accounts/${id}/transactions?limit=3&page=1`);
  assert.deepEqual(all.body.pagination, { page: 1, limit: 3, total: 7, total_pages: 3 });
  assert.deepEqual(all.body.data.map((t) => t.reference_id), ['d2', 'd1', 'c5']);

  const page3 = await call('GET', `/accounts/${id}/transactions?limit=3&page=3`);
  assert.deepEqual(page3.body.data.map((t) => t.reference_id), ['c1']);

  const credits = await call('GET', `/accounts/${id}/transactions?type=credit`);
  assert.equal(credits.body.pagination.total, 5);
  assert.ok(credits.body.data.every((t) => t.type === 'credit'));
  assert.equal((await call('GET', `/accounts/${id}/transactions?type=debit`)).body.pagination.total, 2);
});

test('history: invalid pagination/filter -> 400', async () => {
  const { id } = await newAccount();
  for (const q of ['page=0', 'page=abc', 'limit=-1', 'limit=1000', 'type=x']) {
    assert.equal((await call('GET', `/accounts/${id}/transactions?${q}`)).status, 400, q);
  }
});

test('transactions cannot be edited or deleted via the API', async () => {
  const { id } = await newAccount();
  const t = (await tx(id, 'credit', 10, 'r')).body.transaction;
  for (const m of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal((await call(m, `/accounts/${id}/transactions/${t.id}`, {})).status, 405);
  }
});

test('database itself refuses to update/delete transactions', async () => {
  const { id } = await newAccount();
  await tx(id, 'credit', 10, 'r');
  assert.throws(() => db.prepare('UPDATE transactions SET amount = 1').run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM transactions').run(), /immutable/);
});

test('database refuses a negative balance', async () => {
  const { id } = await newAccount();
  assert.throws(() => db.prepare('UPDATE accounts SET balance = -1 WHERE id = ?').run(id), /CHECK/);
});

test('transfer moves money and records both sides', async () => {
  const a = await newAccount('A');
  const b = await newAccount('B');
  await tx(a.id, 'credit', 100, 'seed-a');
  await tx(b.id, 'credit', 50, 'seed-b');
  const r = await call('POST', '/transfers', {
    from_account_id: a.id, to_account_id: b.id, amount: 30, reference_id: 't1',
  });
  assert.equal(r.status, 201);
  assert.equal(await balance(a.id), 70);
  assert.equal(await balance(b.id), 80);
});

test('transfer: insufficient funds / missing account roll back everything', async () => {
  const a = await newAccount('A');
  const b = await newAccount('B');
  await tx(a.id, 'credit', 10, 'seed');

  const poor = await call('POST', '/transfers', { from_account_id: a.id, to_account_id: b.id, amount: 30, reference_id: 't' });
  assert.equal(poor.status, 422);

  // destination missing: the debit on the source must be rolled back
  const missing = await call('POST', '/transfers', { from_account_id: a.id, to_account_id: 'ghost', amount: 5, reference_id: 't2' });
  assert.equal(missing.status, 404);

  // destination already has this reference_id: the debit on the source must be rolled back
  await tx(b.id, 'credit', 1, 'clash');
  const clash = await call('POST', '/transfers', { from_account_id: a.id, to_account_id: b.id, amount: 5, reference_id: 'clash' });
  assert.equal(clash.status, 409);

  assert.equal(await balance(a.id), 10);
  assert.equal(await balance(b.id), 1);
  assert.equal((await call('GET', `/accounts/${a.id}/transactions`)).body.pagination.total, 1);
});

test('transfer: duplicate reference and same-account are rejected', async () => {
  const a = await newAccount('A');
  const b = await newAccount('B');
  await tx(a.id, 'credit', 100, 'seed');
  const body = { from_account_id: a.id, to_account_id: b.id, amount: 10, reference_id: 't' };
  assert.equal((await call('POST', '/transfers', body)).status, 201);
  assert.equal((await call('POST', '/transfers', body)).status, 409);
  assert.equal(await balance(a.id), 90);
  assert.equal(await balance(b.id), 10);
  assert.equal((await call('POST', '/transfers', { ...body, to_account_id: a.id, reference_id: 'x' })).status, 400);
});

test('unknown route -> consistent 404 error shape', async () => {
  const r = await call('GET', '/nothing');
  assert.equal(r.status, 404);
  assert.ok(r.body.error.code && r.body.error.message);
});
