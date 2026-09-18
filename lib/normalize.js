'use strict';

/**
 * Service-type normalization.
 *
 * getServiceTypes() returns a company's catalog exactly as that company keeps
 * it. This module maps that catalog onto canonical names using a mapping that
 * lives in the TENANT'S CONFIG, never in this repo.
 *
 * That split is not fastidiousness. The live Elite Pools catalog has 96 types
 * including "Pool Opening - NO USE", "Pool Opening - Vinyl", "Pool Service -
 * Weekly", "Pool Service - Indoor", "Spa Service - Weekly - Standalone" and
 * "Estimate Description:Salt System Install". Any rule general enough to sort
 * that in code would be wrong for the next company, and being wrong here means
 * an agent silently classifying a pool opening as a weekly clean.
 *
 * So the code does the part that is the same everywhere - apply the mapping,
 * and say loudly what is not mapped yet - and the judgement stays with whoever
 * knows the business.
 *
 * Re-runnable is the other half. Companies add service types constantly. Every
 * function here is pure and takes the current catalog, so onboarding can be run
 * again next season and the only thing that changes is that `unmapped` is
 * shorter. Nothing is written back into POM and nothing is cached.
 */

/**
 * A tenant mapping looks like:
 *
 *   {
 *     version: 1,
 *     canonical: {
 *       'weekly-service':  { serviceTypeIds: ['cmlk...8c', 'cmlk...7r'] },
 *       'pool-opening':    { serviceTypeIds: ['cmlk...zu'] },
 *       'not-a-service':   { serviceTypeIds: ['cmlk...48'], exclude: true }
 *     }
 *   }
 *
 * Keyed by canonical name, holding POM ids - not names. Names get edited in
 * POM's UI; ids do not. A mapping keyed by display text silently detaches the
 * first time somebody fixes a typo.
 */

/** Turn the mapping inside out: POM id -> { canonical, exclude }. */
function indexMapping(mapping) {
  const byId = new Map();
  const canonical = mapping?.canonical ?? {};
  for (const [name, def] of Object.entries(canonical)) {
    for (const id of def?.serviceTypeIds ?? []) {
      if (byId.has(id)) {
        const first = byId.get(id).canonical;
        throw new Error('Service type ' + id + ' is mapped to both "' + first + '" and "'
          + name + '". A type belongs to one canonical bucket.');
      }
      byId.set(id, { canonical: name, exclude: def.exclude === true });
    }
  }
  return byId;
}

/**
 * Apply a tenant's mapping to a live catalog.
 *
 * Returns the catalog annotated, plus the two lists onboarding actually cares
 * about: what is not mapped yet, and what the mapping refers to that POM no
 * longer has.
 */
function applyMapping(serviceTypes, mapping) {
  const byId = indexMapping(mapping);
  const seen = new Set();

  const types = (serviceTypes ?? []).map((t) => {
    const hit = byId.get(t.serviceTypeId);
    if (hit) seen.add(t.serviceTypeId);
    return {
      ...t,
      canonical: hit?.canonical ?? null,
      excluded: hit?.exclude ?? false,
      mapped: Boolean(hit),
    };
  });

  /**
   * Inactive and deleted types are reported separately rather than hidden. A
   * company that stopped using a type last year still has history against it,
   * and an agent reading two seasons of service reports will meet it.
   */
  const unmapped = types
    .filter((t) => !t.mapped)
    .map((t) => ({
      serviceTypeId: t.serviceTypeId,
      name: t.name,
      inactive: t.inactive === true,
      deleted: t.deleted === true,
    }));

  const stale = [...byId.keys()]
    .filter((id) => !seen.has(id))
    .map((id) => ({ serviceTypeId: id, canonical: byId.get(id).canonical }));

  const byCanonical = {};
  for (const t of types) {
    if (!t.canonical || t.excluded) continue;
    (byCanonical[t.canonical] ??= []).push(t.serviceTypeId);
  }

  return {
    types,
    byCanonical,
    unmapped,
    stale,
    /**
     * Deliberately counts only types the company still uses. Holding onboarding
     * open over a type that was deleted in 2023 helps nobody.
     */
    complete: unmapped.filter((t) => !t.inactive && !t.deleted).length === 0,
    counts: {
      total: types.length,
      mapped: types.filter((t) => t.mapped).length,
      unmapped: unmapped.length,
      unmappedActive: unmapped.filter((t) => !t.inactive && !t.deleted).length,
      stale: stale.length,
    },
  };
}

/**
 * What onboarding shows a human: every unmapped active type, with a suggested
 * canonical name they can accept or overwrite.
 *
 * The suggestion is a slug of the company's own wording and nothing cleverer.
 * It exists so a person can click through 96 types quickly, not so the mapping
 * can be skipped - `suggested` is never applied automatically anywhere.
 */
function suggestMapping(serviceTypes, mapping) {
  const { unmapped } = applyMapping(serviceTypes, mapping);
  return unmapped
    .filter((t) => !t.inactive && !t.deleted)
    .map((t) => ({
      serviceTypeId: t.serviceTypeId,
      name: t.name,
      suggested: slug(t.name),
    }));
}

function slug(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

/** Fail loudly on a malformed mapping rather than half-applying it. */
function assertMapping(mapping) {
  if (mapping == null) return { canonical: {} };
  if (typeof mapping !== 'object') throw new Error('tenant service-type mapping must be an object');
  const canonical = mapping.canonical;
  if (canonical != null && typeof canonical !== 'object') {
    throw new Error('mapping.canonical must be an object keyed by canonical name');
  }
  indexMapping(mapping); // throws on a double-mapped id
  return mapping;
}

module.exports = { applyMapping, suggestMapping, indexMapping, assertMapping, slug };
