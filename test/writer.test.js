'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createFieldWriter, WRITES, WRITE_SCOPES, FieldWriteDenied } = require('..');
const {
  createFieldWriter: buildWriter, tenantAllowsWrites, grantsFor,
} = require('../lib/writer');
const { scrub } = require('../lib/audit');

function creds() {
  return {
    get: () => ({ api_key: 'pom_live_testkey0000000000000000000000000000' }),
    save: () => {}, remove: () => {},
  };
}

/** An in-memory audit port, so a test can read back what was recorded. */
function memAudit() {
  const rows = [];
  return { rows, record: (e) => rows.push(e), list: () => rows };
}

/**
 * A descriptor stands in for the first real write. It exercises the gates that
 * are already built, so they are not sitting untested until someone adds one.
 */
const FAKE = Object.freeze({
  name: 'rescheduleAppointment',
  scope: 'appointments:write',
  consequential: true,
  mutation: 'mutation Reschedule($id: ID!) { rescheduleAppointment(id: $id) { id } }',
  variables: (args) => ({ id: args.appointmentId }),
});

/**
 * Build a writer whose registry holds one descriptor. `registry` exists on the
 * factory for exactly this reason - see the note on it in lib/writer.js. The
 * shipped path never passes one, and every gate below applies either way.
 */
function writerWith(descriptor, opts = {}) {
  return buildWriter({
    agent: opts.agent ?? 'scheduler-agent',
    adapters: { pom: { name: 'pom', provider: 'pom', reads: {} } },
    writeTransport: opts.writeTransport ?? (async () => ({ ok: true })),
    credentials: creds(),
    audit: opts.audit,
    policy: opts.policy,
    approvals: opts.approvals,
    registry: [descriptor],
  });
}

/* ----------------------------------------------------- the seam is empty -- */

test('the write registry is empty, so a writer exposes no write methods', () => {
  assert.deepStrictEqual([...WRITES], []);
  const w = createFieldWriter({
    agent: 'any-agent', credentials: creds(), audit: memAudit(), fetchImpl: async () => {},
  });
  assert.deepStrictEqual([...w.available], []);
  const callable = Object.keys(w).filter((k) => typeof w[k] === 'function');
  assert.deepStrictEqual(callable.sort(), ['enabledFor', 'scopesFor']);
});

test('a writer is frozen', () => {
  const w = createFieldWriter({
    agent: 'a', credentials: creds(), audit: memAudit(), fetchImpl: async () => {},
  });
  assert.ok(Object.isFrozen(w));
  assert.throws(() => { w.rescheduleAppointment = async () => {}; }, TypeError);
});

test('a writer cannot be built without an agent name or an audit port', () => {
  assert.throws(() => createFieldWriter({ credentials: creds(), audit: memAudit() }),
    /needs \{ agent \}/);
  assert.throws(
    () => createFieldWriter({ agent: 'a', credentials: creds(), audit: {} }),
    /audit port is missing record/);
});

/* --------------------------------------------------- gate 1: tenant opt-in -- */

test('writes are off for a tenant nobody has configured', () => {
  assert.strictEqual(tenantAllowsWrites(undefined, 'elite-pools'), false);
  assert.strictEqual(tenantAllowsWrites({}, 'elite-pools'), false);
  assert.strictEqual(tenantAllowsWrites({ 'elite-pools': {} }, 'elite-pools'), false);
  // Only an explicit true opens it - not 1, not 'yes'.
  assert.strictEqual(tenantAllowsWrites({ t: { writesEnabled: 1 } }, 't'), false);
  assert.strictEqual(tenantAllowsWrites({ t: { writesEnabled: 'yes' } }, 't'), false);
  assert.strictEqual(tenantAllowsWrites({ t: { writesEnabled: true } }, 't'), true);
});

test('a write is refused and logged when the tenant has not opted in', async () => {
  const audit = memAudit();
  let wireCalls = 0;
  const w = writerWith(FAKE, { audit, policy: {}, writeTransport: async () => { wireCalls += 1; } });

  await assert.rejects(
    () => w.rescheduleAppointment({ tenant: 'elite-pools', appointmentId: 'x' }),
    (e) => e instanceof FieldWriteDenied && e.reason === 'tenant_opt_out');

  assert.strictEqual(wireCalls, 0, 'a denied write must not reach POM');
  assert.deepStrictEqual(audit.rows.map((r) => r.outcome),
    ['attempted', 'denied_tenant_opt_out']);
});

/* ------------------------------------------------- gate 2: per-agent grant -- */

test('opting a tenant in does not grant every agent', async () => {
  const audit = memAudit();
  const policy = {
    'elite-pools': { writesEnabled: true, agents: { 'other-agent': { scopes: ['appointments:write'] } } },
  };
  assert.deepStrictEqual(grantsFor(policy, 'elite-pools', 'scheduler-agent'), []);

  const w = writerWith(FAKE, { audit, policy, agent: 'scheduler-agent' });
  await assert.rejects(
    () => w.rescheduleAppointment({ tenant: 'elite-pools', appointmentId: 'x' }),
    (e) => e instanceof FieldWriteDenied && e.reason === 'no_grant');
  assert.ok(audit.rows.some((r) => r.outcome === 'denied_no_grant'));
});

test('a grant for one scope does not carry another', async () => {
  const policy = {
    t: { writesEnabled: true, agents: { a: { scopes: ['services:write'] } } },
  };
  const w = writerWith(FAKE, { audit: memAudit(), policy, agent: 'a' });
  await assert.rejects(
    () => w.rescheduleAppointment({ tenant: 't', appointmentId: 'x' }),
    (e) => e.reason === 'no_grant');
});

/* ---------------------------------------------------- gate 3: approval gate -- */

test('a consequential write is refused when no approvals port is configured', async () => {
  const audit = memAudit();
  const policy = { t: { writesEnabled: true, agents: { a: { scopes: ['appointments:write'] } } } };
  const w = writerWith(FAKE, { audit, policy, agent: 'a' });   // no approvals

  await assert.rejects(
    () => w.rescheduleAppointment({ tenant: 't', appointmentId: 'x' }),
    (e) => e.reason === 'no_approvals_port');
  assert.ok(audit.rows.some((r) => r.outcome === 'denied_unapproved'));
});

test('a consequential write is refused when approval is withheld', async () => {
  const audit = memAudit();
  const policy = { t: { writesEnabled: true, agents: { a: { scopes: ['appointments:write'] } } } };
  let wireCalls = 0;
  const w = writerWith(FAKE, {
    audit, policy, agent: 'a',
    approvals: { check: async () => ({ approved: false }) },
    writeTransport: async () => { wireCalls += 1; },
  });

  await assert.rejects(
    () => w.rescheduleAppointment({ tenant: 't', appointmentId: 'x' }),
    (e) => e.reason === 'unapproved');
  assert.strictEqual(wireCalls, 0);
});

test('an approved consequential write runs, and both approval and success are logged', async () => {
  const audit = memAudit();
  const policy = { t: { writesEnabled: true, agents: { a: { scopes: ['appointments:write'] } } } };
  const sent = [];
  const w = writerWith(FAKE, {
    audit, policy, agent: 'a',
    approvals: { check: async () => ({ approved: true, approvalId: 'appr_1', approvedBy: 'paul' }) },
    writeTransport: async (key, doc, vars) => { sent.push({ doc, vars }); return { ok: true }; },
  });

  const out = await w.rescheduleAppointment({ tenant: 't', appointmentId: 'appt_9' });
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].vars, { id: 'appt_9' });

  assert.deepStrictEqual(audit.rows.map((r) => r.outcome),
    ['attempted', 'approved', 'succeeded']);
  assert.strictEqual(audit.rows[1].approvalId, 'appr_1');
  assert.strictEqual(audit.rows[1].approvedBy, 'paul');
});

test('a failing write is logged as failed and the error still propagates', async () => {
  const audit = memAudit();
  const policy = { t: { writesEnabled: true, agents: { a: { scopes: ['appointments:write'] } } } };
  const w = writerWith(FAKE, {
    audit, policy, agent: 'a',
    approvals: { check: async () => ({ approved: true, approvalId: 'appr_2' }) },
    writeTransport: async () => { throw new Error('POM GraphQL error: nope'); },
  });

  await assert.rejects(() => w.rescheduleAppointment({ tenant: 't', appointmentId: 'x' }), /nope/);
  const last = audit.rows[audit.rows.length - 1];
  assert.strictEqual(last.outcome, 'failed');
  assert.match(last.error, /nope/);
});

test('every write is per tenant', async () => {
  const w = writerWith(FAKE, { audit: memAudit(), policy: {} });
  await assert.rejects(() => w.rescheduleAppointment({ appointmentId: 'x' }),
    /every write is per tenant/);
});

/* ------------------------------------------------------------ gate 4: audit -- */

test('the audit log never stores a credential', () => {
  const cleaned = scrub({
    apiKey: 'pom_live_abcdefghijklmnopqrstuvwxyz0123456789',
    nested: { token: 'pom_live_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', note: 'fine' },
    bare: 'pom_live_9999999999999999999999999999999999999999',
    appointmentId: 'appt_9',
  });
  assert.strictEqual(cleaned.apiKey, 'pom_live_...6789');
  assert.strictEqual(cleaned.nested.token, 'pom_live_...zzzz');
  assert.strictEqual(cleaned.bare, 'pom_live_...9999');
  assert.strictEqual(cleaned.nested.note, 'fine');
  assert.strictEqual(cleaned.appointmentId, 'appt_9');
  assert.ok(!JSON.stringify(cleaned).includes('abcdefghij'));
});

test('declared scopes stay in step with the registry', () => {
  for (const d of WRITES) {
    assert.ok(WRITE_SCOPES.includes(d.scope),
      'write "' + d.name + '" needs scope "' + d.scope + '" added to WRITE_SCOPES');
    assert.strictEqual(typeof d.mutation, 'string');
    assert.strictEqual(typeof d.variables, 'function');
  }
});
