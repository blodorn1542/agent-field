'use strict';

const { assertAuditPort } = require('./audit');

/**
 * fieldWriter - the seam for the few agents that will need to change POM.
 *
 * It is empty on purpose. WRITES below is the registry of every write this
 * package will ever perform, and today it has no entries, so a constructed
 * writer has no callable methods. The guardrails around it are finished; the
 * methods are not written because we have not yet named which agents write or
 * what they write, and a seam built around imagined methods fits the imagined
 * ones rather than the real ones.
 *
 * What is finished is the part that is hard to add later. Four gates, in order,
 * every one of them logged whether it passes or fails:
 *
 *   1. TENANT OPT-IN. Writes are off for every company until that company turns
 *      them on. The default is not "unset", it is off - see tenantAllowsWrites().
 *   2. PER-AGENT GRANT. A tenant opting in does not open the door to every
 *      agent. Each agent is granted named scopes, and a write declares the
 *      scope it needs.
 *   3. APPROVAL. A write marked consequential needs a held approval naming that
 *      tenant, agent and method. No approvals port configured means every
 *      consequential write is refused, which is the correct failure direction.
 *   4. AUDIT. Every attempt is recorded before it runs and after it resolves.
 *
 * Adding the first write means adding one frozen descriptor to WRITES. It
 * cannot be added anywhere else: buildMethods() only ever reads this array, and
 * nothing in the returned object is extensible.
 */

/**
 * The write registry. Empty until we name the agents that write.
 *
 * A descriptor looks like:
 *   {
 *     name: 'rescheduleAppointment',
 *     scope: 'appointments:write',
 *     consequential: true,          // does a customer feel this? then true
 *     mutation: 'mutation ... ',     // the GraphQL document
 *     variables: (args) => ({ ... }) // args -> GraphQL variables
 *   }
 *
 * `consequential: true` is the default posture. A write is non-consequential
 * only if a human would not care that it happened - and almost nothing in a
 * field-service system clears that bar, because the output of this system is
 * somebody driving to somebody else's house.
 */
const WRITES = Object.freeze([]);

/** Scopes an agent can be granted. Grows with WRITES, and only with it. */
const WRITE_SCOPES = Object.freeze([
  'appointments:write',
  'services:write',
]);

/**
 * Off by default, and deliberately not merely falsy-by-default.
 *
 * `undefined` - a tenant nobody has configured - must read as OFF, not as
 * "inherit something". The only value that enables writes is an explicit true.
 */
function tenantAllowsWrites(policy, tenantId) {
  const t = policy?.[tenantId];
  return t?.writesEnabled === true;
}

/** The scopes this agent holds for this tenant. Absent grant means none. */
function grantsFor(policy, tenantId, agent) {
  const t = policy?.[tenantId];
  const g = t?.agents?.[agent];
  return Array.isArray(g?.scopes) ? g.scopes : [];
}

class FieldWriteDenied extends Error {
  constructor(message, { reason, tenantId, agent, method, scope }) {
    super(message);
    this.name = 'FieldWriteDenied';
    this.reason = reason;
    this.tenantId = tenantId;
    this.agent = agent;
    this.method = method;
    this.scope = scope;
  }
}

/**
 * @param {object}   opts
 * @param {string}   opts.agent        which agent is asking - required, and not
 *                                     defaulted, because an unattributed write
 *                                     is not auditable
 * @param {object}   opts.adapters     the same adapters fieldReader uses
 * @param {function} opts.writeTransport the mutation-capable wire
 * @param {object}   opts.credentials  credential port
 * @param {object}   opts.audit        audit port - required
 * @param {object}  [opts.policy]      { [tenantId]: { writesEnabled, agents: { [agent]: { scopes } } } }
 * @param {object}  [opts.approvals]   { check({ tenantId, agent, method, args }) -> { approved, approvalId, approvedBy } }
 * @param {Array}   [opts.registry]    the write descriptors to build methods from.
 *                                     Defaults to WRITES, and index.js never passes
 *                                     it - the shipped path is always the frozen
 *                                     module registry. It is a parameter so the four
 *                                     gates can be exercised by test/writer.test.js
 *                                     before the first real write exists; passing one
 *                                     buys nothing, because every gate below still
 *                                     applies to whatever is in it.
 */
function createFieldWriter(opts = {}) {
  const {
    agent, adapters, writeTransport, credentials, audit, policy = {}, approvals,
    defaultProvider, registry = WRITES,
  } = opts;

  if (!agent) {
    throw new Error('createFieldWriter needs { agent } - the name of the agent doing the '
      + 'writing. Grants are per agent and the audit log is worthless without it.');
  }
  if (!adapters || !Object.keys(adapters).length) {
    throw new Error('createFieldWriter needs { adapters }');
  }
  if (typeof writeTransport !== 'function') {
    throw new Error('createFieldWriter needs { writeTransport }');
  }
  assertAuditPort(audit);

  const names = Object.keys(adapters);
  const provider = defaultProvider || names[0];

  /** The four gates. Returns the approval context, or throws FieldWriteDenied. */
  async function authorize(descriptor, tenantId, args) {
    const base = {
      tenantId, provider, agent, method: descriptor.name, scope: descriptor.scope,
      consequential: descriptor.consequential, args,
    };
    audit.record({ ...base, outcome: 'attempted' });

    // 1. tenant opt-in
    if (!tenantAllowsWrites(policy, tenantId)) {
      audit.record({ ...base, outcome: 'denied_tenant_opt_out' });
      throw new FieldWriteDenied(
        'Writes to POM are not enabled for tenant "' + tenantId + '". A company turns this '
        + 'on explicitly; it is off until then.',
        { reason: 'tenant_opt_out', tenantId, agent, method: descriptor.name, scope: descriptor.scope });
    }

    // 2. per-agent grant
    const held = grantsFor(policy, tenantId, agent);
    if (!held.includes(descriptor.scope)) {
      audit.record({ ...base, outcome: 'denied_no_grant' });
      throw new FieldWriteDenied(
        'Agent "' + agent + '" does not hold scope "' + descriptor.scope + '" for tenant "'
        + tenantId + '". Tenant opt-in enables writing; it does not grant it to every agent.',
        { reason: 'no_grant', tenantId, agent, method: descriptor.name, scope: descriptor.scope });
    }

    // 3. approval, for anything a customer would feel
    if (descriptor.consequential) {
      if (typeof approvals?.check !== 'function') {
        audit.record({ ...base, outcome: 'denied_unapproved' });
        throw new FieldWriteDenied(
          '"' + descriptor.name + '" is a consequential write and no approvals port is '
          + 'configured, so it cannot be approved and will not run.',
          { reason: 'no_approvals_port', tenantId, agent, method: descriptor.name, scope: descriptor.scope });
      }
      const verdict = await approvals.check({ tenantId, agent, method: descriptor.name, args });
      if (!verdict?.approved) {
        audit.record({ ...base, outcome: 'denied_unapproved', approvalId: verdict?.approvalId });
        throw new FieldWriteDenied(
          '"' + descriptor.name + '" needs approval for tenant "' + tenantId + '" and none '
          + 'was held.',
          { reason: 'unapproved', tenantId, agent, method: descriptor.name, scope: descriptor.scope });
      }
      audit.record({
        ...base, outcome: 'approved',
        approvalId: verdict.approvalId, approvedBy: verdict.approvedBy,
      });
      return { base, approvalId: verdict.approvalId, approvedBy: verdict.approvedBy };
    }

    return { base, approvalId: null, approvedBy: null };
  }

  function apiKeyFor(tenantId) {
    const row = credentials.get(tenantId, provider);
    if (!row?.api_key) {
      throw new Error('No POM API key for tenant "' + tenantId + '".');
    }
    return row.api_key;
  }

  /**
   * Turn the registry into methods. With WRITES empty this returns {}, which is
   * the point: the machinery above is exercised by tests today and the methods
   * arrive later without any of it being rebuilt.
   */
  function buildMethods() {
    const out = {};
    for (const d of registry) {
      out[d.name] = async function callWrite(args = {}) {
        const { tenant } = args;
        if (!tenant) throw new Error('Pass { tenant } - every write is per tenant, never global');
        const ctx = await authorize(d, tenant, args);
        try {
          const data = await writeTransport(apiKeyFor(tenant), d.mutation, d.variables(args));
          audit.record({ ...ctx.base, outcome: 'succeeded', approvalId: ctx.approvalId });
          return data;
        } catch (err) {
          audit.record({ ...ctx.base, outcome: 'failed', approvalId: ctx.approvalId, error: err.message });
          throw err;
        }
      };
    }
    return out;
  }

  const methods = buildMethods();

  return Object.freeze({
    agent,
    provider,
    /** Names of the writes this agent can actually call. Empty today. */
    available: Object.freeze(Object.keys(methods)),
    /** Whether this tenant has turned writes on at all. */
    enabledFor: (tenantId) => tenantAllowsWrites(policy, tenantId),
    /** What this agent holds for a tenant, for a host that wants to show it. */
    scopesFor: (tenantId) => Object.freeze(grantsFor(policy, tenantId, agent)),
    ...methods,
  });
}

module.exports = {
  createFieldWriter, FieldWriteDenied,
  WRITES, WRITE_SCOPES, tenantAllowsWrites, grantsFor,
};
