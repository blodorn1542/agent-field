'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { applyMapping, suggestMapping, assertMapping } = require('..');
const raw = require('./fixtures/service-types.json');

/** The fixture is a real slice of the Elite Pools catalog, shaped as the adapter shapes it. */
const CATALOG = raw.map((n) => ({
  serviceTypeId: n.id,
  name: n.display,
  defaultPrice: n.defaultPrice,
  inactive: n.isInactive,
  deleted: n.deleted,
}));

const idOf = (name) => CATALOG.find((t) => t.name === name).serviceTypeId;

test('an unmapped catalog reports every type as unmapped and nothing as complete', () => {
  const r = applyMapping(CATALOG, { canonical: {} });
  assert.strictEqual(r.counts.total, CATALOG.length);
  assert.strictEqual(r.counts.mapped, 0);
  assert.strictEqual(r.counts.unmapped, CATALOG.length);
  assert.strictEqual(r.complete, false);
  assert.deepStrictEqual(r.byCanonical, {});
});

test('mapping is by POM id, so renaming a type in POM does not detach it', () => {
  const mapping = {
    canonical: { 'weekly-service': { serviceTypeIds: [idOf('Pool Service - Weekly')] } },
  };
  const renamed = CATALOG.map((t) => (t.name === 'Pool Service - Weekly'
    ? { ...t, name: 'Pool Service — Weekly (2026)' } : t));

  const r = applyMapping(renamed, mapping);
  assert.deepStrictEqual(r.byCanonical['weekly-service'], [idOf('Pool Service - Weekly')]);
  assert.strictEqual(r.types.find((t) => t.canonical === 'weekly-service').name,
    'Pool Service — Weekly (2026)');
});

test('several POM types can collapse into one canonical bucket', () => {
  const mapping = {
    canonical: {
      'weekly-service': {
        serviceTypeIds: [idOf('Pool Service - Weekly'), idOf('Pool Service - Indoor')],
      },
    },
  };
  const r = applyMapping(CATALOG, mapping);
  assert.strictEqual(r.byCanonical['weekly-service'].length, 2);
});

test('an excluded type is mapped but kept out of the canonical buckets', () => {
  const mapping = {
    canonical: { 'not-a-service': { serviceTypeIds: [idOf('Note')], exclude: true } },
  };
  const r = applyMapping(CATALOG, mapping);
  assert.strictEqual(r.counts.mapped, 1);
  assert.strictEqual(r.byCanonical['not-a-service'], undefined);
  assert.strictEqual(r.types.find((t) => t.name === 'Note').excluded, true);
});

test('a type mapped to two canonical names is a config error, not a silent winner', () => {
  const mapping = {
    canonical: {
      'weekly-service': { serviceTypeIds: [idOf('Pool Closing')] },
      'pool-closing': { serviceTypeIds: [idOf('Pool Closing')] },
    },
  };
  assert.throws(() => applyMapping(CATALOG, mapping), /belongs to one canonical bucket/);
  assert.throws(() => assertMapping(mapping), /belongs to one canonical bucket/);
});

test('a mapping pointing at a type POM no longer has is reported as stale', () => {
  const mapping = {
    canonical: { 'gone': { serviceTypeIds: ['cmlk_deleted_in_pom'] } },
  };
  const r = applyMapping(CATALOG, mapping);
  assert.deepStrictEqual(r.stale, [{ serviceTypeId: 'cmlk_deleted_in_pom', canonical: 'gone' }]);
});

test('completeness ignores inactive and deleted types', () => {
  // Map every ACTIVE type, leaving the inactive ones alone.
  const canonical = {};
  for (const t of CATALOG) {
    if (t.inactive || t.deleted) continue;
    canonical[t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')] = { serviceTypeIds: [t.serviceTypeId] };
  }
  const r = applyMapping(CATALOG, { canonical });
  assert.strictEqual(r.counts.unmappedActive, 0);
  assert.strictEqual(r.complete, true);
  // The inactive ones are still visible, just not blocking.
  assert.ok(r.counts.unmapped > 0, 'the fixture should contain inactive types');
});

test('re-running after a company adds a type surfaces exactly that type', () => {
  const canonical = {};
  for (const t of CATALOG) {
    canonical[t.serviceTypeId] = { serviceTypeIds: [t.serviceTypeId] };
  }
  const first = applyMapping(CATALOG, { canonical });
  assert.strictEqual(first.counts.unmapped, 0);

  const later = [...CATALOG, {
    serviceTypeId: 'cmlk_new_2026', name: 'Heater Service - Spring', inactive: false, deleted: false,
  }];
  const second = applyMapping(later, { canonical });
  assert.strictEqual(second.counts.unmapped, 1);
  assert.strictEqual(second.complete, false);
  assert.deepStrictEqual(second.unmapped.map((t) => t.name), ['Heater Service - Spring']);
});

test('applyMapping is pure - it does not mutate the catalog it is given', () => {
  const snapshot = JSON.stringify(CATALOG);
  applyMapping(CATALOG, { canonical: { x: { serviceTypeIds: [idOf('Cleaning')] } } });
  assert.strictEqual(JSON.stringify(CATALOG), snapshot);
});

test('suggestions are offered for active unmapped types and never applied', () => {
  const s = suggestMapping(CATALOG, { canonical: {} });
  const closing = s.find((x) => x.name === 'Pool Closing');
  assert.strictEqual(closing.suggested, 'pool-closing');
  // A suggestion is not a mapping: the catalog is still unmapped.
  assert.strictEqual(applyMapping(CATALOG, { canonical: {} }).counts.mapped, 0);
  // Inactive types are not put in front of a human.
  assert.ok(!s.some((x) => x.name === 'Pool Opening - NO USE'),
    'inactive types should not be offered for mapping');
});

test('the awkward real names survive slugging', () => {
  const s = suggestMapping(CATALOG, { canonical: {} });
  const est = s.find((x) => x.name === 'Estimate Description:Salt System Install');
  assert.strictEqual(est.suggested, 'estimate-description-salt-system-install');
});

test('a null mapping is treated as an empty one rather than throwing', () => {
  assert.deepStrictEqual(assertMapping(null), { canonical: {} });
  assert.strictEqual(applyMapping(CATALOG, null).counts.mapped, 0);
});
