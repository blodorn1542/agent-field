'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createFieldReader, assertReadOnly, READ_METHODS, isReadOnlyDocument,
} = require('..');
const { MUTATING } = require('../lib/interface');
const { createReadTransport } = require('../lib/transport');

/** A credentials port with one connected tenant, so reads get as far as the wire. */
function creds(apiKey = 'pom_live_testkey00000000000000000000000000000') {
  return {
    get: () => ({ api_key: apiKey }),
    save: () => {},
    remove: () => {},
  };
}

/** A fetch that records every call and never lets one out. */
function spyFetch(payload = { data: {} }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
  };
  impl.calls = calls;
  return impl;
}

const TEST_ENDPOINT = 'https://pom.test/graphql';

function reader(fetchImpl = spyFetch()) {
  // The endpoint is required now - there is no default in the package.
  return createFieldReader({ credentials: creds(), fetchImpl, endpoint: TEST_ENDPOINT });
}

/* ------------------------------------------------- the surface is the list -- */

test('fieldReader exposes exactly the four reads and nothing else', () => {
  const field = reader();
  const callable = Object.keys(field).filter((k) => typeof field[k] === 'function');
  assert.deepStrictEqual(callable.sort(), [...READ_METHODS].sort());
  assert.deepStrictEqual([...READ_METHODS].sort(),
    ['getAppointments', 'getServiceReports', 'getServiceTypes', 'getSites']);
});

test('no method on fieldReader is named like a write', () => {
  const field = reader();
  for (const key of Object.keys(field)) {
    assert.ok(!MUTATING.test(key), 'reader exposes a mutating-sounding key: ' + key);
  }
});

test('fieldReader is frozen and cannot have a write bolted on', () => {
  const field = reader();
  assert.ok(Object.isFrozen(field));
  assert.throws(() => { field.createAppointment = async () => 'boom'; }, TypeError);
  assert.throws(() => { field.getAppointments = async () => 'swapped'; }, TypeError);
  assert.throws(() => { delete field.getSites; }, TypeError);
  assert.strictEqual(field.createAppointment, undefined);
});

/* ------------------------------------ the object graph contains no write path -- */

test('nothing reachable from a fieldReader is a write', () => {
  const field = reader();
  const seen = new Set();
  const offenders = [];

  (function walk(node, path, depth) {
    if (node === null || depth > 6) return;
    const t = typeof node;
    if (t !== 'object' && t !== 'function') return;
    if (seen.has(node)) return;
    seen.add(node);

    for (const key of Reflect.ownKeys(node)) {
      if (typeof key === 'symbol') continue;
      if (['constructor', 'prototype', 'caller', 'callee', 'arguments'].includes(key)) continue;

      const here = path + '.' + key;
      let value;
      try { value = node[key]; } catch { continue; }

      // A credential is allowed to be reachable; a write is not.
      if (MUTATING.test(key) && typeof value === 'function' && !here.startsWith('.credentials')) {
        offenders.push(here);
      }
      // The write transport must not exist anywhere in the reader's graph.
      if (/writeTransport|writeMutation|createFieldWriter/i.test(key)) offenders.push(here);

      walk(value, here, depth + 1);
    }
  })(field, '', 0);

  assert.deepStrictEqual(offenders, [],
    'reachable write-shaped members: ' + offenders.join(', '));
});

test('a reader carries no reference to the writer factory', () => {
  const field = reader();
  assert.strictEqual(field.createFieldWriter, undefined);
  assert.strictEqual(field.writer, undefined);
  assert.strictEqual(field.writeTransport, undefined);
  // There is no escape hatch to the adapter underneath, either: adapterFor
  // stays in index.js's closure so an agent cannot walk past the allow-list.
  assert.strictEqual(field.adapterFor, undefined);
  assert.strictEqual(field.adapters, undefined);
  assert.strictEqual(field.adapter, undefined);
});

test('the adapter behind the reader declares only the four reads', () => {
  const pomAdapter = require('../lib/adapters/pom')
    .create({ credentials: creds(), readTransport: async () => ({}) });
  assert.strictEqual(pomAdapter.writes, undefined);
  assert.deepStrictEqual(Object.keys(pomAdapter.reads).sort(),
    ['getAppointments', 'getServiceReports', 'getServiceTypes', 'getSites']);
});

/* --------------------------------------------- the wire refuses a mutation -- */

test('the read transport throws on a mutation and never reaches the network', async () => {
  const fetchImpl = spyFetch();
  const transport = createReadTransport({ endpoint: 'https://example.invalid/graphql', fetchImpl });

  await assert.rejects(
    () => transport('pom_live_x', 'mutation M { createAppointment(input: {}) { id } }'),
    /carries reads only/);
  await assert.rejects(
    () => transport('pom_live_x', 'query A { a } mutation B { b }'),
    /carries reads only/);
  await assert.rejects(
    () => transport('pom_live_x', 'subscription S { s }'),
    /carries reads only/);

  assert.strictEqual(fetchImpl.calls.length, 0,
    'a refused operation must not produce an HTTP request');
});

test('a mutation hidden in a string or comment is still classified correctly', () => {
  // These are reads that merely mention the word, and must not be refused.
  assert.ok(isReadOnlyDocument('{ a(note: "mutation { hack }") }'));
  assert.ok(isReadOnlyDocument('# mutation M { x }\n{ a }'));
  // These are genuine writes.
  assert.ok(!isReadOnlyDocument('mutation M { x }'));
  assert.ok(!isReadOnlyDocument('  \n  mutation  M { x }'));
  // An empty document is not a valid read either.
  assert.ok(!isReadOnlyDocument(''));
});

test('every document the POM adapter ships is a query', () => {
  const { queries } = require('../lib/adapters/pom');
  for (const [name, doc] of Object.entries(queries)) {
    assert.ok(isReadOnlyDocument(doc), name + ' is not a read-only document');
  }
});

test('reads actually issued by the reader are queries', async () => {
  const fetchImpl = spyFetch({ data: { infiniteTypes: { pageInfo: {}, edges: [] } } });
  const field = reader(fetchImpl);
  await field.getServiceTypes({ tenant: 't' });
  assert.strictEqual(fetchImpl.calls.length, 1);
  assert.ok(isReadOnlyDocument(fetchImpl.calls[0].body.query));
});

/* ----------------------------------------- construction-time adapter checks -- */

test('assertReadOnly refuses an adapter that exposes writes', () => {
  assert.throws(
    () => assertReadOnly({ name: 'pom', reads: {}, writes: { createAppointment() {} } }),
    /exposes a writes object/);
});

test('assertReadOnly refuses a read named after a mutating verb', () => {
  for (const bad of ['createThing', 'updateThing', 'scheduleVisit', 'cancelVisit',
    'markComplete', 'assignTech', 'sendReport']) {
    assert.throws(
      () => assertReadOnly({ name: 'pom', reads: { [bad]: () => {} } }),
      /reads like a write/, bad + ' should have been refused');
  }
});

test('assertReadOnly passes a clean adapter', () => {
  const a = { name: 'pom', reads: { getSites: () => {} } };
  assert.strictEqual(assertReadOnly(a), a);
});

/* ------------------------------------------------------ per-tenant framing -- */

test('every read requires a tenant', async () => {
  const field = reader();
  for (const m of READ_METHODS) {
    const args = m === 'getAppointments'
      ? { startDate: '2026-09-01', endDate: '2026-09-30' } : {};
    await assert.rejects(() => field[m](args), /every read is per tenant/);
  }
});

test('getAppointments refuses an unbounded window', async () => {
  const fetchImpl = spyFetch();
  const field = reader(fetchImpl);
  await assert.rejects(() => field.getAppointments({ tenant: 't' }), /startDate, endDate/);
  assert.strictEqual(fetchImpl.calls.length, 0);
});
