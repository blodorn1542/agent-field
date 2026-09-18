'use strict';

/**
 * fieldReader - the read-only interface agents call.
 *
 * Read-only structurally, not by convention. Five independent things have to
 * hold, and any one of them failing is caught by test/interface.test.js:
 *
 *   1. READ_METHODS below is the entire surface. It is an allow-list of four
 *      reads, frozen, and createFieldReader() refuses to return if the object
 *      it built has any own key that is not on it. Adding a write here is the
 *      thing not to do.
 *   2. The returned object is frozen, so nothing can bolt a write on later -
 *      and index.js re-freezes after spreading, because spreading a frozen
 *      object produces an extensible one and what an agent holds is that.
 *   3. assertReadOnly() refuses, at construction, any adapter carrying a
 *      `writes` object or naming a read after a mutating verb.
 *   4. The adapter is handed a transport that throws on any GraphQL operation
 *      that is not a query (lib/transport.js).
 *   5. The reader closure never receives the write transport, the writer
 *      factory, or the audit log. There is no property to walk from a reader to
 *      a writer, which is what makes "a reader agent cannot write" a fact about
 *      scope rather than a promise about discipline.
 *
 * agent-financial makes the same promise about the books. This is the same
 * promise about the field: a reporting agent that reads chemistry and missed
 * visits should be structurally incapable of rescheduling someone's pool.
 */

/** Every method an agent may call. The whole surface. */
const READ_METHODS = Object.freeze([
  'getAppointments',
  'getServiceReports',
  'getServiceTypes',
  'getSites',
]);

/** Any "read" whose name starts like this is not a read. */
const MUTATING = /^(create|update|delete|remove|write|post|put|patch|void|send|save|set|sync|apply|add|schedule|cancel|complete|assign|move|reschedule|close|open|mark)/i;

function assertReadOnly(adapter) {
  const name = adapter?.name ?? 'unknown';
  if (adapter?.writes) {
    throw new Error('Adapter "' + name + '" exposes a writes object. fieldReader is '
      + 'read-only by construction: a reader agent reads the field, it never changes it. '
      + 'Writes belong to fieldWriter (lib/writer.js), which is granted per agent and '
      + 'opted into per tenant.');
  }
  for (const key of Object.keys(adapter?.reads || {})) {
    if (MUTATING.test(key)) {
      throw new Error('Adapter "' + name + '" declares "' + key + '" as a read, but that name '
        + 'reads like a write. Reads are named get*; nothing on fieldReader may change POM.');
    }
  }
  return adapter;
}

function createFieldReader({ adapters, defaultProvider }) {
  const names = Object.keys(adapters);
  if (!names.length) throw new Error('No field adapters were configured');

  function adapterFor(provider) {
    const wanted = provider || defaultProvider || names[0];
    const a = adapters[wanted];
    if (!a) {
      throw new Error('No field adapter named "' + wanted + '". Available: ' + names.join(', '));
    }
    return a;
  }

  /**
   * Every read goes through here, and every read is async - including the
   * argument checks. A caller that handles failure with .catch() must not have
   * some methods throw past it because they happened to fail early.
   */
  async function read(args, fn) {
    const { tenant, provider } = args || {};
    if (!tenant) throw new Error('Pass { tenant } - every read is per tenant, never global');
    return fn(adapterFor(provider), tenant);
  }

  const api = {
    /**
     * Scheduled visits in a date window. The window is required: POM returns an
     * empty list with no error when its selector is omitted, which is
     * indistinguishable from a company that has no appointments. Making the
     * window mandatory is the difference between "no visits booked" and "we
     * forgot to ask properly", and that distinction is a missed-service alert.
     */
    async getAppointments(args = {}) {
      const { startDate, endDate, pageCap, pageSize } = args;
      if (!startDate || !endDate) {
        throw new Error('getAppointments needs { startDate, endDate } as YYYY-MM-DD.');
      }
      return read(args, (a, t) =>
        a.reads.getAppointments(t, { startDate, endDate, pageCap, pageSize }));
    },

    /**
     * Completed service records, chemistry included.
     *
     * No date window here, and that is POM's constraint rather than a
     * simplification: its service date filter supports equality only, so there
     * is no range to pass. Narrow with `siteIds` when you can; otherwise expect
     * to walk pages and filter on `servicedAt` yourself.
     */
    async getServiceReports(args = {}) {
      const { siteIds, serviceTypeIds, flag, pageCap, pageSize } = args;
      return read(args, (a, t) =>
        a.reads.getServiceReports(t, { siteIds, serviceTypeIds, flag, pageCap, pageSize }));
    },

    /**
     * The raw service-type catalog, exactly as the company has it. Onboarding
     * auto-discovery reads this; the per-company mapping to canonical names
     * lives in tenant config and is re-runnable (see lib/normalize.js).
     */
    async getServiceTypes(args = {}) {
      const { pageCap, pageSize } = args;
      return read(args, (a, t) => a.reads.getServiceTypes(t, { pageCap, pageSize }));
    },

    /** The serviced properties. In POM these are Customer records - see the adapter. */
    async getSites(args = {}) {
      const { pageCap, pageSize } = args;
      return read(args, (a, t) => a.reads.getSites(t, { pageCap, pageSize }));
    },

    adapterFor,
  };

  // The surface is exactly READ_METHODS. Both directions are checked: a missing
  // method is a broken interface, and an extra one is a hole.
  for (const m of READ_METHODS) {
    if (typeof api[m] !== 'function') throw new Error('fieldReader is missing ' + m + '()');
  }
  for (const key of Object.keys(api)) {
    if (key === 'adapterFor') continue;
    if (!READ_METHODS.includes(key)) {
      throw new Error('fieldReader grew a method that is not on the allow-list: "' + key + '". '
        + 'If it is a read, add it to READ_METHODS deliberately. If it is a write, it does '
        + 'not belong on this interface at all.');
    }
  }

  return Object.freeze(api);
}

module.exports = { createFieldReader, assertReadOnly, READ_METHODS, MUTATING };
