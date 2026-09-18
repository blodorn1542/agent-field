'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createFieldReader } = require('..');
const { CHEMISTRY, MAX_PAGE } = require('../lib/adapters/pom');

const KEY = 'pom_live_testkey00000000000000000000000000000';

function creds(apiKey = KEY) {
  return { get: () => ({ api_key: apiKey }), save: () => {}, remove: () => {} };
}

/** A fetch that replays queued GraphQL payloads and records what was asked. */
function fakeFetch(pages) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, query: body.query, variables: body.variables });
    const payload = typeof pages === 'function' ? pages(body, i) : pages[Math.min(i, pages.length - 1)];
    i += 1;
    return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
  };
  impl.calls = calls;
  return impl;
}

function conn(name, nodes, { hasNextPage = false, endCursor = null } = {}) {
  return { data: { [name]: { pageInfo: { hasNextPage, endCursor }, edges: nodes.map((node) => ({ node })) } } };
}

function reader(fetchImpl) {
  return createFieldReader({ credentials: creds(), fetchImpl, endpoint: 'https://pom.test/graphql' });
}

/* ------------------------------------------------------------------ auth -- */

test('the only auth header sent is Bearer', async () => {
  const f = fakeFetch([conn('infiniteTypes', [])]);
  await reader(f).getServiceTypes({ tenant: 't' });
  const h = f.calls[0].headers;
  assert.strictEqual(h.Authorization, 'Bearer ' + KEY);
  assert.strictEqual(h['X-API-Key'], undefined);
  assert.strictEqual(h['x-api-key'], undefined);
});

test('a tenant with no stored key gets a clear message, not a 401 later', async () => {
  const field = createFieldReader({
    endpoint: 'https://pom.test/graphql',
    credentials: { get: () => null, save: () => {}, remove: () => {} },
    fetchImpl: fakeFetch([conn('infiniteTypes', [])]),
    pom: { apiKey: null },
  });
  const before = process.env.POM_API_KEY_READONLY;
  delete process.env.POM_API_KEY_READONLY;
  try {
    await assert.rejects(() => field.getServiceTypes({ tenant: 'new-co' }), /has not connected POM yet/);
  } finally {
    if (before !== undefined) process.env.POM_API_KEY_READONLY = before;
  }
});

/* ---------------------------------------------------------- error shaping -- */

test('a GraphQL error arriving with HTTP 200 is still an error', async () => {
  const f = async () => ({
    status: 200, ok: true,
    text: async () => JSON.stringify({ errors: [{ message: 'Bad Request Exception', extensions: { code: 'BAD_USER_INPUT' } }] }),
  });
  await assert.rejects(() => reader(f).getServiceTypes({ tenant: 't' }), /Bad Request Exception/);
});

test('a revoked key is reported as a key problem, not a schema problem', async () => {
  const f = async () => ({
    status: 200, ok: true,
    text: async () => JSON.stringify({ errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }] }),
  });
  await assert.rejects(() => reader(f).getServiceTypes({ tenant: 't' }),
    /rejected the API key for this tenant/);
});

/* ------------------------------------------------------------- pagination -- */

test('a connection is walked to the end', async () => {
  const f = fakeFetch([
    conn('infiniteTypes', [{ id: 'a', display: 'A' }], { hasNextPage: true, endCursor: 'c1' }),
    conn('infiniteTypes', [{ id: 'b', display: 'B' }], { hasNextPage: true, endCursor: 'c2' }),
    conn('infiniteTypes', [{ id: 'c', display: 'C' }], { hasNextPage: false }),
  ]);
  const r = await reader(f).getServiceTypes({ tenant: 't' });
  assert.deepStrictEqual(r.items.map((t) => t.name), ['A', 'B', 'C']);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(f.calls.length, 3);
  assert.strictEqual(f.calls[1].variables.after, 'c1');
  assert.strictEqual(f.calls[2].variables.after, 'c2');
});

test('never asks POM for more than its page cap of 100', async () => {
  const f = fakeFetch([conn('infiniteTypes', [])]);
  await reader(f).getServiceTypes({ tenant: 't', pageSize: 500 });
  assert.strictEqual(f.calls[0].variables.first, MAX_PAGE);
});

test('hitting the page cap is reported rather than silently truncating', async () => {
  const f = fakeFetch(() => conn('infiniteTypes', [{ id: 'x', display: 'X' }],
    { hasNextPage: true, endCursor: 'more' }));
  const r = await reader(f).getServiceTypes({ tenant: 't', pageCap: 3 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.pages, 3);
  assert.strictEqual(r.items.length, 3);
});

/* ----------------------------------------------------------- appointments -- */

test('appointments send the date selector POM requires', async () => {
  const f = fakeFetch([conn('infiniteAppointments', [])]);
  await reader(f).getAppointments({ tenant: 't', startDate: '2026-09-01', endDate: '2026-09-30' });
  assert.deepStrictEqual(f.calls[0].variables.selector,
    { startDate: '2026-09-01', endDate: '2026-09-30' });
});

test('an appointment is shaped with a usable completed flag and site label', async () => {
  const f = fakeFetch([conn('infiniteAppointments', [{
    id: 'appt1', date: '2023-06-01T05:00:00.000Z', status: 'COMPLETE', duration: 60,
    notes: 'Weekly service', recurring: false, isPinned: false, servicePrice: null,
    serviceType: { id: 'ty1', display: 'Pool Service - Weekly' },
    appointmentQueue: null, project: null,
    customer: { id: 'cu1', firstName: '9 South Harbor Ct.', lastName: 'Golesic', streetAddress: '9 South Harbor Ct.', city: 'Southampton', state: 'NY' },
  }])]);
  const { items } = await reader(f).getAppointments({ tenant: 't', startDate: '2023-06-01', endDate: '2023-06-02' });
  const a = items[0];
  assert.strictEqual(a.appointmentId, 'appt1');
  assert.strictEqual(a.completed, true);
  assert.strictEqual(a.serviceTypeName, 'Pool Service - Weekly');
  assert.strictEqual(a.siteId, 'cu1');
  assert.strictEqual(a.siteLabel, '9 South Harbor Ct.');
});

test('an OPEN appointment is not reported as completed', async () => {
  const f = fakeFetch([conn('infiniteAppointments', [{ id: 'a', status: 'OPEN', customer: {}, serviceType: {} }])]);
  const { items } = await reader(f).getAppointments({ tenant: 't', startDate: '2023-06-01', endDate: '2023-06-02' });
  assert.strictEqual(items[0].completed, false);
});

/* -------------------------------------------------------- service reports -- */

test('chemistry is lifted off the Service record under corrected names', async () => {
  const f = fakeFetch([conn('infiniteServices', [{
    id: 'svc1', startTime: '2023-06-14T13:02:00.000Z', endTime: '2023-06-14T13:29:00.000Z',
    ph: 7.4, chlorine: 3, combinedChlorine: null, alkalinity: 90, calcium: 250,
    cynuricAcid: 40, salt: 3200, phosphorus: null, copper: null, iron: null,
    waterTemperature: 82, servicePrice: 84, flag: 'Complete',
    type: { id: 'ty1', display: 'Pool Service - Weekly' },
    technician: { id: 'tech1' }, customer: { id: 'cu1' },
  }])]);
  const { items } = await reader(f).getServiceReports({ tenant: 't' });
  const s = items[0];

  // POM's misspelling is corrected exactly once, here.
  assert.strictEqual(s.chemistry.cyanuricAcid, 40);
  assert.strictEqual(s.chemistry.cynuricAcid, undefined);
  // And their bare 'chlorine' is named for what it actually is.
  assert.strictEqual(s.chemistry.freeChlorine, 3);
  assert.strictEqual(s.chemistry.totalAlkalinity, 90);
  assert.strictEqual(s.chemistry.calciumHardness, 250);
  assert.strictEqual(s.chemistry.waterTemperature, 82);
  assert.strictEqual(s.servicedAt, '2023-06-14T13:02:00.000Z');
  assert.strictEqual(s.siteId, 'cu1');
});

test('an unrecorded reading stays null and is never read as zero', async () => {
  const f = fakeFetch([conn('infiniteServices', [{
    id: 'svc2', startTime: '2023-06-14T13:02:00.000Z',
    ph: null, chlorine: 0, alkalinity: null, type: {}, customer: {}, technician: {},
  }])]);
  const { items } = await reader(f).getServiceReports({ tenant: 't' });
  assert.strictEqual(items[0].chemistry.ph, null);
  assert.strictEqual(items[0].chemistry.freeChlorine, 0);   // a real recorded zero
  assert.notStrictEqual(items[0].chemistry.ph, 0);
  // chemistryRecorded counts what was actually entered, zeros included.
  assert.strictEqual(items[0].chemistryRecorded, 1);
});

test('every chemistry key maps to a field POM actually has', () => {
  const POM_FIELDS = ['ph', 'chlorine', 'combinedChlorine', 'alkalinity', 'calcium',
    'cynuricAcid', 'salt', 'phosphorus', 'copper', 'iron', 'waterTemperature'];
  assert.deepStrictEqual(Object.values(CHEMISTRY).sort(), [...POM_FIELDS].sort());
});

test('service reports narrow by site, which is the filter POM really supports', async () => {
  const f = fakeFetch([conn('infiniteServices', [])]);
  await reader(f).getServiceReports({ tenant: 't', siteIds: ['cu1', 'cu2'] });
  assert.deepStrictEqual(f.calls[0].variables.selector,
    { filters: { customerId: { in: ['cu1', 'cu2'] } } });
});

test('an unfiltered service read sends an empty selector rather than omitting it', async () => {
  const f = fakeFetch([conn('infiniteServices', [])]);
  await reader(f).getServiceReports({ tenant: 't' });
  assert.deepStrictEqual(f.calls[0].variables.selector, {});
});

/* ------------------------------------------------------------------ sites -- */

test('a site is read from POM Customer records, address first', async () => {
  const f = fakeFetch([conn('infiniteCustomers', [{
    id: 'cu1', firstName: '177 Sagaponack Road', lastName: 'Elghanayan',
    email: 'x@example.com', streetAddress: '177 Sagaponack Road', city: 'Bridgehampton',
    state: 'NY', phoneNumber: null, billingAddress: null, latitude: 40.9, longitude: -72.3,
    status: 'ACTIVE', notes: null,
  }])]);
  const { items } = await reader(f).getSites({ tenant: 't' });
  assert.strictEqual(items[0].siteId, 'cu1');
  assert.strictEqual(items[0].label, '177 Sagaponack Road');
  assert.strictEqual(items[0].active, true);
});

test('a site with scrambled name fields still gets a label and keeps the raw values', async () => {
  // A real record from the live tenant: the import put the address in firstName
  // and the person's name in streetAddress.
  const f = fakeFetch([conn('infiniteCustomers', [{
    id: 'cu2', firstName: '11 Woodland Dr', lastName: 'Belneva',
    streetAddress: 'Natallia Belneva', city: null, state: null, status: 'INACTIVE',
  }])]);
  const { items } = await reader(f).getSites({ tenant: 't' });
  assert.strictEqual(items[0].label, 'Natallia Belneva');
  assert.strictEqual(items[0].firstName, '11 Woodland Dr');
  assert.strictEqual(items[0].active, false);
  assert.strictEqual(items[0].raw.firstName, '11 Woodland Dr');
});

/* ------------------------------------------------------------ date window -- */

test('a windowed read sorts newest-first, because POM has no range filter', async () => {
  const f = fakeFetch([conn('infiniteServices', [
    { id: 'a', startTime: '2026-09-18T10:00:00.000Z', type: {}, customer: {}, technician: {} },
  ])]);
  await reader(f).getServiceReports({ tenant: 't', since: '2026-09-17' });
  assert.deepStrictEqual(f.calls[0].variables.sort, [{ field: 'startTime', order: 'DESC' }]);
});

test('an unwindowed read does not sort, keeping POM default order', async () => {
  const f = fakeFetch([conn('infiniteServices', [])]);
  await reader(f).getServiceReports({ tenant: 't' });
  assert.strictEqual(f.calls[0].variables.sort, null);
});

test('the walk stops at the first record older than since', async () => {
  const f = fakeFetch([
    conn('infiniteServices', [
      { id: 'new1', startTime: '2026-09-18T10:00:00.000Z', type: {}, customer: {}, technician: {} },
      { id: 'new2', startTime: '2026-09-17T10:00:00.000Z', type: {}, customer: {}, technician: {} },
      { id: 'old1', startTime: '2026-09-15T10:00:00.000Z', type: {}, customer: {}, technician: {} },
    ], { hasNextPage: true, endCursor: 'c1' }),
    conn('infiniteServices', [
      { id: 'older', startTime: '2020-01-01T00:00:00.000Z', type: {}, customer: {}, technician: {} },
    ]),
  ]);
  const r = await reader(f).getServiceReports({ tenant: 't', since: '2026-09-16' });
  assert.deepStrictEqual(r.items.map((s) => s.serviceReportId), ['new1', 'new2']);
  assert.strictEqual(f.calls.length, 1, 'must not fetch a second page once it is past the window');
  assert.strictEqual(r.truncated, false, 'stopping on purpose is not truncation');
});

test('until trims the newer end of the window', async () => {
  const f = fakeFetch([conn('infiniteServices', [
    { id: 'today', startTime: '2026-09-18T10:00:00.000Z', type: {}, customer: {}, technician: {} },
    { id: 'yday', startTime: '2026-09-17T10:00:00.000Z', type: {}, customer: {}, technician: {} },
  ])]);
  const r = await reader(f).getServiceReports({
    tenant: 't', since: '2026-09-16', until: '2026-09-17T23:59:59.999Z',
  });
  assert.deepStrictEqual(r.items.map((s) => s.serviceReportId), ['yday']);
  assert.deepStrictEqual(r.window, { since: '2026-09-16', until: '2026-09-17T23:59:59.999Z' });
});

test('an unparseable window is rejected rather than silently ignored', async () => {
  const f = fakeFetch([conn('infiniteServices', [])]);
  await assert.rejects(
    () => reader(f).getServiceReports({ tenant: 't', since: 'last tuesday' }),
    /unparseable since/);
  assert.strictEqual(f.calls.length, 0);
});
