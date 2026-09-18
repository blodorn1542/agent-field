'use strict';

/**
 * agent-field - the shared Field Services layer for the agent platform.
 *
 * Pool Office Manager is an adapter behind the interface; agents depend on this
 * package and it depends on no agent. The dependency runs one way.
 *
 *   const { createFieldReader } = require('agent-field');
 *
 *   const field = createFieldReader({ credentials });   // host's own storage
 *   const visits = await field.getAppointments({
 *     tenant: 'elite-pools', startDate: '2026-09-01', endDate: '2026-09-30',
 *   });
 *
 * There are TWO interfaces and they are built by two different functions:
 *
 *   createFieldReader() - four reads, frozen, and given a transport that
 *                         throws on any GraphQL operation that is not a query.
 *                         It never receives the write transport.
 *   createFieldWriter() - the seam for agents that change POM. Off per tenant
 *                         by default, granted per agent, approval-gated,
 *                         audited - and currently carrying no write methods at
 *                         all, by design. See lib/writer.js.
 *
 * An agent handed a reader cannot reach a writer through it. That is the whole
 * point, and test/interface.test.js walks the object graph to prove it rather
 * than asserting it.
 */

const { openDatabase } = require('./lib/db');
const {
  createCredentials, assertCredentialsPort, redact, assertKeyShape,
} = require('./lib/credentials');
const { createAudit, assertAuditPort } = require('./lib/audit');
const {
  createReadTransport, createWriteTransport, isReadOnlyDocument,
} = require('./lib/transport');
const {
  createFieldReader: buildReader, assertReadOnly, READ_METHODS,
} = require('./lib/interface');
const {
  createFieldWriter: buildWriter, FieldWriteDenied, WRITES, WRITE_SCOPES,
} = require('./lib/writer');
const normalize = require('./lib/normalize');
const pom = require('./lib/adapters/pom');

/** The adapters this package ships. A second field system would be one more entry. */
const ADAPTER_MODULES = { pom };

const DEFAULT_ENDPOINT = '';

function resolveEndpoint(options) {
  return options.endpoint || process.env.POM_ENDPOINT || DEFAULT_ENDPOINT;
}

function resolveCredentials(options) {
  const { credentials, db, dbPath } = options;
  return credentials
    ? assertCredentialsPort(credentials)
    : createCredentials(db || openDatabase(dbPath));
}

/**
 * The read-only interface. This is what nearly every agent should be handed.
 *
 * @param {object}   options
 * @param {object}  [options.credentials] credential port; pass the host's own
 *                                        storage so a connected company is not
 *                                        made to re-paste its key
 * @param {object}  [options.db]          an open node:sqlite handle
 * @param {string}  [options.dbPath]      where to open one
 * @param {string}  [options.endpoint]    POM GraphQL endpoint
 * @param {string}  [options.provider]    default adapter name ('pom')
 * @param {function}[options.fetchImpl]   injectable fetch, for tests
 */
function createFieldReader(options = {}) {
  const { provider, fetchImpl = fetch, timeoutMs } = options;
  const creds = resolveCredentials(options);

  // The read transport is the ONLY wire built in this function. No write
  // transport is constructed here, so there is none in scope to leak.
  const readTransport = createReadTransport({
    endpoint: resolveEndpoint(options), fetchImpl, timeoutMs,
  });

  const adapters = Object.fromEntries(
    Object.entries(ADAPTER_MODULES).map(([name, mod]) => [
      name,
      assertReadOnly(mod.create({
        credentials: creds, readTransport, settings: options[name] || {},
      })),
    ])
  );

  const api = buildReader({ adapters, defaultProvider: provider });

  // adapterFor is pulled OUT of the agent-facing object rather than spread into
  // it. It is how this function reaches the adapter's auth helpers, but an
  // agent holding it could walk past the interface to the adapter underneath,
  // and the whole value of a four-method allow-list is that there is no walking
  // past it. It stays in this closure.
  const { adapterFor, ...reads } = api;

  // Frozen, like the interface it spreads. Without this the freeze in
  // lib/interface.js would be undone right here: spreading a frozen object
  // produces an extensible one, and what an agent actually holds is this.
  return Object.freeze({
    ...reads,
    /** Connect-time only: prove a pasted key works and name the POM account. */
    auth: Object.freeze({
      verifyKey: async (apiKey, name) => {
        const key = assertKeyShape(apiKey);
        const info = await adapterFor(name).auth.verifyKey(key);
        return Object.freeze({ ...info, apiKey: redact(key) });
      },
      /** Store a company's key after it has been verified. */
      connect: async (tenantId, apiKey, name) => {
        const key = assertKeyShape(apiKey);
        const adapter = adapterFor(name);
        const info = await adapter.auth.verifyKey(key);
        creds.save(tenantId, adapter.provider, {
          apiKey: key,
          endpoint: resolveEndpoint(options),
          externalName: info.externalName,
        });
        return Object.freeze({ ...info, apiKey: redact(key) });
      },
      disconnect: (tenantId, name) =>
        creds.remove(tenantId, adapterFor(name).provider),
    }),
    credentials: creds,
  });
}

/**
 * The write seam. Built separately, per agent, and currently exposing no write
 * methods - see lib/writer.js for why that is deliberate and what is already
 * finished around it.
 *
 * @param {object}   options
 * @param {string}   options.agent     the agent doing the writing
 * @param {object}   options.audit     audit port - required, no default
 * @param {object}  [options.policy]   per-tenant opt-in and per-agent grants
 * @param {object}  [options.approvals] approval port for consequential writes
 */
function createFieldWriter(options = {}) {
  const { agent, provider, fetchImpl = fetch, timeoutMs, policy, approvals } = options;
  const creds = resolveCredentials(options);
  const audit = options.audit
    ? assertAuditPort(options.audit)
    : createAudit(options.db || openDatabase(options.dbPath));

  const endpoint = resolveEndpoint(options);
  const writeTransport = createWriteTransport({ endpoint, fetchImpl, timeoutMs });
  const readTransport = createReadTransport({ endpoint, fetchImpl, timeoutMs });

  const adapters = Object.fromEntries(
    Object.entries(ADAPTER_MODULES).map(([name, mod]) => [
      name, mod.create({ credentials: creds, readTransport, settings: options[name] || {} }),
    ])
  );

  return buildWriter({
    agent, adapters, writeTransport, credentials: creds, audit, policy, approvals,
    defaultProvider: provider,
  });
}

module.exports = {
  createFieldReader,
  createFieldWriter,

  // Pure helpers, usable without constructing anything.
  applyMapping: normalize.applyMapping,
  suggestMapping: normalize.suggestMapping,
  assertMapping: normalize.assertMapping,

  // Guardrails, exported so a host can assert on them in its own tests.
  assertReadOnly, isReadOnlyDocument, FieldWriteDenied,
  READ_METHODS, WRITES, WRITE_SCOPES,

  createCredentials, assertCredentialsPort, createAudit, openDatabase, redact,
  adapters: ADAPTER_MODULES,
};
