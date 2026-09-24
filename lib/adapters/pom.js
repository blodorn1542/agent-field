'use strict';

/**
 * Pool Office Manager / Pool Service Manager.
 *
 * Everything in this file was confirmed against the live API with a read-only
 * key on 2026-09-18, because POM ships no usable schema document: introspection
 * is disabled in their production Apollo server, so the shapes below were
 * recovered by probing and are worth treating as findings, not assumptions.
 *
 * Four things here are not what you would guess, and each one cost a round of
 * probing:
 *
 *   1. A list query returns NOTHING without its `selector`. `infiniteAppointments`
 *      with only `first` returns an empty edge list and no error - it looks
 *      exactly like a company with no appointments. The selector is required in
 *      practice even though the schema marks it optional.
 *   2. The appointment selector and the service selector are different types.
 *      Appointments take `{ startDate, endDate }` directly. Services take
 *      `{ filters: { ... } }`, and the date filters there are DateTimeFilter,
 *      which offers equals/in/not/notIn and NO range operators. So services
 *      cannot be fetched by date window at all - only by customer, type, flag
 *      or project. That asymmetry drives getServiceReports' signature.
 *   3. A service type's name is `display`. There is no `name` field on Type.
 *   4. POM misspells cyanuric acid as `cynuricAcid`. We match their spelling on
 *      the wire and correct it once, here, on the way out.
 *
 * HARD RULE, the same one agent-financial carries: this adapter's `reads` only
 * ever issue GraphQL queries, and the transport it is handed (lib/transport.js)
 * throws on anything that is not one. There is no write path in this file.
 */

const PROVIDER = 'pom';

/** POM rejects `first` above 100 with a validation error, so we never ask for more. */
const MAX_PAGE = 100;

/** A guard against an unbounded walk when a caller forgets to narrow a query. */
const DEFAULT_PAGE_CAP = 100;

const APPOINTMENT_FIELDS = `
  id date status duration notes recurring isPinned servicePrice createdAt updatedAt
  serviceType { id display }
  serviceStatus { id }
  appointmentQueue { id name }
  project { id }
  customer { id firstName lastName streetAddress city state }`;

const SERVICE_FIELDS = `
  id startTime endTime createdAt updatedAt servicePrice flag projectId
  ph chlorine combinedChlorine alkalinity calcium cynuricAcid salt phosphorus
  copper iron waterTemperature
  customerNotes internalNotes
  type { id display }
  technician { id }
  customer { id }
  inventoryUsed { id quantity price inventoryItem { id name sku } }
  customFields { id value customField { id name type } }`;

const SITE_FIELDS = `
  id firstName lastName email streetAddress city state phoneNumber billingAddress
  latitude longitude status notes`;

const TYPE_FIELDS = `
  id display cost defaultPrice isInactive isServiceCall isServiceType deleted`;

const Q_APPOINTMENTS = `query AgentFieldAppointments($first: Int, $after: String, $selector: AppointmentsSelector!) {
  infiniteAppointments(selector: $selector, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { ${APPOINTMENT_FIELDS} } }
  }
}`;

const Q_SERVICES = `query AgentFieldServices($first: Int, $after: String, $selector: ServicesSelector, $sort: [ServicesSort!]) {
  infiniteServices(selector: $selector, first: $first, after: $after, sort: $sort) {
    pageInfo { hasNextPage endCursor }
    edges { node { ${SERVICE_FIELDS} } }
  }
}`;

/**
 * Newest-first, which is how a date window is served at all.
 *
 * POM's service date filter is equality-only, so there is no range to ask for.
 * But the connection IS sortable, and it is ascending by default - the oldest
 * record in the Elite Pools tenant is from March 2023 and the newest is today,
 * with ~20,000 in between. Walking forward to reach "yesterday" means walking
 * the entire history every night.
 *
 * Sorting descending and stopping at the first record older than `since` turns
 * that into a handful of pages. It is the difference between a nightly job that
 * costs two requests and one that costs two hundred.
 */
const NEWEST_FIRST = Object.freeze([{ field: 'startTime', order: 'DESC' }]);

const Q_SITES = `query AgentFieldSites($first: Int, $after: String) {
  infiniteCustomers(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { ${SITE_FIELDS} } }
  }
}`;

const Q_TYPES = `query AgentFieldServiceTypes($first: Int, $after: String) {
  infiniteTypes(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { ${TYPE_FIELDS} } }
  }
}`;

const Q_ORG = `query AgentFieldOrganization { organization { id name timeZone { name } } }`;

/**
 * The chemistry POM stores on a Service, in our spelling.
 *
 * `combinedChlorine`, `copper` and `iron` are in POM's schema but came back null
 * on all 1,200 records sampled from the Elite Pools tenant. They are carried
 * through rather than dropped - a field that is empty for one company is not
 * necessarily empty for the next - but an agent should treat a null here as
 * "not recorded", never as zero.
 */
const CHEMISTRY = Object.freeze({
  ph: 'ph',
  freeChlorine: 'chlorine',
  combinedChlorine: 'combinedChlorine',
  totalAlkalinity: 'alkalinity',
  calciumHardness: 'calcium',
  cyanuricAcid: 'cynuricAcid',
  salt: 'salt',
  phosphates: 'phosphorus',
  copper: 'copper',
  iron: 'iron',
  waterTemperature: 'waterTemperature',
});

function create(ctx) {
  const { credentials, readTransport, settings = {} } = ctx;

  /** The tenant's own pasted key, or the bootstrap env key for a dev run. */
  function authFor(tenantId) {
    const row = credentials.get(tenantId, PROVIDER);
    const apiKey = row?.api_key ?? settings.apiKey ?? process.env.POM_API_KEY_READONLY;
    if (!apiKey) {
      throw new Error('No POM API key for tenant "' + tenantId + '". This company has not '
        + 'connected POM yet - it pastes its own key, the same way it connects QuickBooks.');
    }
    return apiKey;
  }

  /**
   * Walk a Relay-style connection to the end, or to `pageCap` pages.
   *
   * POM has no total count anywhere, so a caller cannot know the size of a
   * result before walking it. The cap is a seatbelt, and when it is hit the
   * result says so rather than quietly returning a prefix that looks complete.
   */
  async function walk(tenantId, query, connectionName, variables = {}, opts = {}) {
    const apiKey = authFor(tenantId);
    const pageCap = opts.pageCap ?? DEFAULT_PAGE_CAP;
    const pageSize = Math.min(opts.pageSize ?? MAX_PAGE, MAX_PAGE);
    /** Stop the walk once this says so - see NEWEST_FIRST. */
    const stopAt = opts.stopAt;

    const nodes = [];
    let after = null;
    let pages = 0;
    let truncated = false;
    let reachedEnd = false;

    for (;;) {
      const data = await readTransport(apiKey, query, { ...variables, first: pageSize, after });
      const conn = data?.[connectionName];
      if (!conn) break;
      for (const edge of conn.edges ?? []) {
        if (!edge?.node) continue;
        if (stopAt?.(edge.node)) { reachedEnd = true; break; }
        nodes.push(edge.node);
      }
      pages += 1;
      if (reachedEnd) break;
      if (!conn.pageInfo?.hasNextPage) break;
      if (pages >= pageCap) { truncated = true; break; }
      after = conn.pageInfo.endCursor;
    }
    // A walk that stopped on its own terms is complete, not truncated.
    return { nodes, pages, truncated: truncated && !reachedEnd };
  }

  /* ------------------------------------------------------------- shaping -- */

  /**
   * In POM a Customer record IS the service site: verified on the live tenant,
   * where a well-formed record has `firstName` equal to `streetAddress` ("177
   * Sagaponack Road") and `lastName` carrying the owner ("Elghanayan"). POM's
   * `locations` object is something else entirely - the operator's own business
   * address, one row for the whole company.
   *
   * Because those two fields are used inconsistently by whoever did the data
   * entry, both are carried through untouched alongside a best-effort label.
   * Nothing downstream should parse `label`; it is for display.
   */
  function shapeSite(n) {
    const owner = [n.firstName, n.lastName].filter(Boolean).join(' ').trim();
    return {
      siteId: n.id,
      label: n.streetAddress || owner || n.id,
      firstName: n.firstName ?? null,
      lastName: n.lastName ?? null,
      streetAddress: n.streetAddress ?? null,
      city: n.city ?? null,
      state: n.state ?? null,
      email: n.email ?? null,
      phone: n.phoneNumber ?? null,
      billingAddress: n.billingAddress ?? null,
      latitude: n.latitude ?? null,
      longitude: n.longitude ?? null,
      status: n.status ?? null,
      active: n.status ? n.status !== 'INACTIVE' : null,
      notes: n.notes ?? null,
      provider: PROVIDER,
      raw: n,
    };
  }

  function shapeAppointment(n) {
    return {
      appointmentId: n.id,
      date: n.date ?? null,
      status: n.status ?? null,
      // POM's own word for done. Kept as a separate boolean because agents
      // asking "was this visit completed" should not have to know the enum.
      completed: n.status === 'COMPLETE',
      durationMinutes: n.duration ?? null,
      notes: n.notes ?? null,
      recurring: n.recurring ?? null,
      pinned: n.isPinned ?? null,
      price: n.servicePrice ?? null,
      serviceTypeId: n.serviceType?.id ?? null,
      serviceTypeName: n.serviceType?.display ?? null,
      queueId: n.appointmentQueue?.id ?? null,
      queueName: n.appointmentQueue?.name ?? null,
      projectId: n.project?.id ?? null,
      siteId: n.customer?.id ?? null,
      siteLabel: n.customer?.streetAddress
        || [n.customer?.firstName, n.customer?.lastName].filter(Boolean).join(' ').trim()
        || null,
      createdAt: n.createdAt ?? null,
      updatedAt: n.updatedAt ?? null,
      provider: PROVIDER,
      raw: n,
    };
  }

  /**
   * A Service is POM's completed record. The chemistry is flat scalars on the
   * record itself - there is no separate readings object and no separate
   * endpoint for them, which was the thing worth confirming before any of this
   * got built.
   */
  function shapeServiceReport(n) {
    const chemistry = {};
    let recorded = 0;
    for (const [ours, theirs] of Object.entries(CHEMISTRY)) {
      const v = n[theirs];
      chemistry[ours] = v ?? null;
      if (v !== null && v !== undefined) recorded += 1;
    }
    return {
      serviceReportId: n.id,
      startTime: n.startTime ?? null,
      endTime: n.endTime ?? null,
      // The date an agent should match on. POM's createdAt is the row's import
      // date on this tenant (2026) and is not the day work happened (2023).
      servicedAt: n.startTime ?? null,
      siteId: n.customer?.id ?? null,
      technicianId: n.technician?.id ?? null,
      serviceTypeId: n.type?.id ?? null,
      serviceTypeName: n.type?.display ?? null,
      flag: n.flag ?? null,
      price: n.servicePrice ?? null,
      projectId: n.projectId ?? null,
      chemistry,
      /** How many of the eleven readings were actually recorded on this visit. */
      chemistryRecorded: recorded,
      /**
       * Notes, items used and the checklist Q&A - the non-scalar signals an
       * agent needs to judge more than the panel: free-text notes, the chemicals
       * actually applied, and the per-visit questions (a salt-cell photo prompt,
       * a "did you test the water" flag). Shaped generically - no company's
       * specific question names or item names live in this adapter, only the
       * structure POM returns them in. What any given name MEANS is a per-tenant
       * mapping the consuming agent resolves from its own config, never here.
       */
      notes: {
        customer: n.customerNotes ?? null,
        internal: n.internalNotes ?? null,
      },
      itemsUsed: (n.inventoryUsed ?? []).map((it) => ({
        id: it.id ?? null,
        name: it.inventoryItem?.name ?? null,
        sku: it.inventoryItem?.sku ?? null,
        quantity: it.quantity ?? null,
        price: it.price ?? null,
      })),
      checklist: (n.customFields ?? []).map((cf) => ({
        name: cf.customField?.name ?? null,
        value: cf.value ?? null,
        type: cf.customField?.type ?? null,
      })),
      createdAt: n.createdAt ?? null,
      updatedAt: n.updatedAt ?? null,
      provider: PROVIDER,
      raw: n,
    };
  }

  /**
   * The raw catalog, deliberately unnormalized. Onboarding auto-discovery reads
   * this to show a company its own service types; the mapping from these to
   * canonical names lives in that tenant's config, never in this repo. The live
   * catalog is why: 96 types including "Pool Opening - NO USE", "Estimate
   * Description:Salt System Install" and three different spellings of weekly
   * service. No amount of code in here would guess that correctly for the next
   * company, and a wrong guess is worse than no guess.
   */
  function shapeServiceType(n) {
    return {
      serviceTypeId: n.id,
      name: n.display ?? null,
      defaultPrice: n.defaultPrice ?? null,
      cost: n.cost ?? null,
      inactive: n.isInactive ?? null,
      isServiceCall: n.isServiceCall ?? null,
      isServiceType: n.isServiceType ?? null,
      deleted: n.deleted ?? null,
      provider: PROVIDER,
      raw: n,
    };
  }

  /* --------------------------------------------------------------- reads -- */

  const reads = {
    async getAppointments(tenantId, { startDate, endDate, pageCap, pageSize } = {}) {
      if (!startDate || !endDate) {
        throw new Error('getAppointments needs { startDate, endDate } (YYYY-MM-DD). POM returns '
          + 'an empty list - with no error - when the selector is omitted, so an unbounded '
          + 'call would look like a company with no appointments.');
      }
      const r = await walk(tenantId, Q_APPOINTMENTS, 'infiniteAppointments',
        { selector: { startDate, endDate } }, { pageCap, pageSize });
      return { items: r.nodes.map(shapeAppointment), truncated: r.truncated, pages: r.pages };
    },

    /**
     * Service reports, optionally windowed by date and filtered.
     *
     * POM has no date-range filter - its DateTimeFilter is equality-only - so a
     * window is served by sorting newest-first and stopping at the first record
     * older than `since`. That is why `since` is cheap and an unwindowed read is
     * not: without it there is nothing to stop the walk but the page cap.
     *
     * `until` is applied after the fetch, because there is no server-side way to
     * skip ahead to it. Passing a narrow historical window therefore still costs
     * a walk back from today.
     */
    async getServiceReports(tenantId, {
      since, until, siteIds, serviceTypeIds, flag, pageCap, pageSize,
    } = {}) {
      const filters = {};
      if (siteIds?.length) filters.customerId = { in: siteIds };
      if (serviceTypeIds?.length) filters.typeId = { in: serviceTypeIds };
      if (flag) filters.flag = { equals: flag };
      const selector = Object.keys(filters).length ? { filters } : {};

      const sinceMs = since ? Date.parse(since) : null;
      const untilMs = until ? Date.parse(until) : null;
      if (since && Number.isNaN(sinceMs)) throw new Error('getServiceReports: unparseable since "' + since + '"');
      if (until && Number.isNaN(untilMs)) throw new Error('getServiceReports: unparseable until "' + until + '"');

      const windowed = sinceMs !== null;
      const r = await walk(tenantId, Q_SERVICES, 'infiniteServices',
        { selector, sort: windowed ? NEWEST_FIRST : null },
        {
          pageCap, pageSize,
          // Newest-first, so the first record older than `since` means every
          // record after it is older too.
          stopAt: windowed
            ? (n) => n.startTime != null && Date.parse(n.startTime) < sinceMs
            : undefined,
        });

      let nodes = r.nodes;
      if (untilMs !== null) {
        nodes = nodes.filter((n) => n.startTime == null || Date.parse(n.startTime) <= untilMs);
      }
      return {
        items: nodes.map(shapeServiceReport),
        truncated: r.truncated,
        pages: r.pages,
        window: windowed ? { since, until: until ?? null } : null,
      };
    },

    async getServiceTypes(tenantId, { pageCap, pageSize } = {}) {
      const r = await walk(tenantId, Q_TYPES, 'infiniteTypes', {}, { pageCap, pageSize });
      return { items: r.nodes.map(shapeServiceType), truncated: r.truncated, pages: r.pages };
    },

    async getSites(tenantId, { pageCap, pageSize } = {}) {
      const r = await walk(tenantId, Q_SITES, 'infiniteCustomers', {}, { pageCap, pageSize });
      return { items: r.nodes.map(shapeSite), truncated: r.truncated, pages: r.pages };
    },
  };

  /**
   * Not part of the agent-facing interface. A host uses this at connect time to
   * prove a pasted key works and to show the company which POM account it just
   * linked, the way the QuickBooks flow echoes the realm back.
   */
  async function verifyKey(apiKey) {
    const data = await readTransport(apiKey, Q_ORG, {});
    return {
      externalId: data?.organization?.id ?? null,
      externalName: data?.organization?.name ?? null,
      timeZone: data?.organization?.timeZone?.name ?? null,
    };
  }

  return {
    name: PROVIDER,
    provider: PROVIDER,
    reads,
    auth: { verifyKey },
    // Deliberately no `writes` key. lib/interface.js refuses any adapter that
    // has one, so this absence is load-bearing rather than incidental.
  };
}

module.exports = {
  create, PROVIDER, CHEMISTRY, MAX_PAGE, DEFAULT_PAGE_CAP,
  queries: { Q_APPOINTMENTS, Q_SERVICES, Q_SITES, Q_TYPES, Q_ORG },
};
