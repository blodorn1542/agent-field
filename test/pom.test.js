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

test('the service query requests notes, items used and the checklist Q&A', async () => {
  const f = fakeFetch([conn('infiniteServices', [])]);
  await reader(f).getServiceReports({ tenant: 't' });
  const q = f.calls[0].query;
  for (const field of ['customerNotes', 'internalNotes',
    'inventoryUsed', 'inventoryItem', 'customFields', 'customField',
    'billingStatus', 'quantity', 'ticketStatus']) {
    assert.ok(q.includes(field), 'service query is missing ' + field);
  }
});

test('a service carries notes, items used and the checklist Q&A, shaped generically', async () => {
  const f = fakeFetch([conn('infiniteServices', [{
    id: 'svc3', startTime: '2026-08-28T13:00:00.000Z',
    ph: 7.5, chlorine: 2.5, alkalinity: 90,
    customerNotes: 'Left gate unlocked', internalNotes: 'Low light on salt cell 2400 ppm',
    billingStatus: 'Ready', quantity: null, ticketStatus: 'NO_TICKET',
    type: {}, customer: { id: 'cu9' }, technician: { id: 't1' },
    inventoryUsed: [
      { id: 'iu1', quantity: 2, price: 8, inventoryItem: { id: 'it1', name: 'Chemicals:Chlorine Tabs', sku: 'CT-1', price: 7.89 } },
    ],
    customFields: [
      { id: 'cf1', value: 'Took Picture of Salt Cell', customField: { id: 'q1', name: 'salt pool take pic', type: 'TEXT' } },
      { id: 'cf2', value: 'Yes', customField: { id: 'q2', name: 'Did you test the water', type: 'BOOLEAN' } },
    ],
  }])]);
  const { items } = await reader(f).getServiceReports({ tenant: 't' });
  const s = items[0];

  assert.strictEqual(s.notes.customer, 'Left gate unlocked');
  assert.strictEqual(s.notes.internal, 'Low light on salt cell 2400 ppm');

  assert.strictEqual(s.itemsUsed.length, 1);
  assert.strictEqual(s.itemsUsed[0].name, 'Chemicals:Chlorine Tabs');
  assert.strictEqual(s.itemsUsed[0].sku, 'CT-1');
  assert.strictEqual(s.itemsUsed[0].quantity, 2);
  assert.strictEqual(s.itemsUsed[0].price, 8, 'the price entered on this service');
  assert.strictEqual(s.itemsUsed[0].listPrice, 7.89, "the item's own list price, separately");

  // The billing facts (v1.2.0), carried verbatim: the vocabulary is the company's.
  assert.strictEqual(s.billingStatus, 'Ready');
  assert.strictEqual(s.quantity, null);
  assert.strictEqual(s.ticketStatus, 'NO_TICKET');

  assert.strictEqual(s.checklist.length, 2);
  assert.strictEqual(s.checklist[0].name, 'salt pool take pic');
  assert.strictEqual(s.checklist[0].value, 'Took Picture of Salt Cell');
  assert.strictEqual(s.checklist[1].name, 'Did you test the water');
  assert.strictEqual(s.checklist[1].value, 'Yes');
});

test('a service with no notes, items or checklist shapes them empty, not undefined', async () => {
  const f = fakeFetch([conn('infiniteServices', [{
    id: 'svc4', startTime: '2026-08-28T13:00:00.000Z',
    ph: 7.5, type: {}, customer: {}, technician: {},
  }])]);
  const { items } = await reader(f).getServiceReports({ tenant: 't' });
  const s = items[0];
  assert.deepStrictEqual(s.notes, { customer: null, internal: null });
  assert.deepStrictEqual(s.itemsUsed, []);
  assert.deepStrictEqual(s.checklist, []);
  assert.strictEqual(s.billingStatus, null);
  assert.strictEqual(s.quantity, null);
  assert.strictEqual(s.ticketStatus, null);
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
    status: 'ACTIVE', notes: null, tags: ['Salt Pool', 'Chems Inclusive'],
  }])]);
  const { items } = await reader(f).getSites({ tenant: 't' });
  assert.strictEqual(items[0].siteId, 'cu1');
  assert.strictEqual(items[0].label, '177 Sagaponack Road');
  assert.strictEqual(items[0].active, true);
  assert.deepStrictEqual(items[0].tags, ['Salt Pool', 'Chems Inclusive']);
  assert.match(f.calls[0].query, /\btags\b/, 'tags are asked for on the wire');
});

test('a site carries every other email and phone on the record, distinct, first fields kept apart (AJ Rahman, 2026-10-06)', async () => {
  const f = fakeFetch([conn('infiniteCustomers', [{
    id: 'cu9', firstName: '1109 Head of Pond Rd', lastName: 'Rahman', streetAddress: null, city: null, state: null, billingAddress: null,
    email: 'ma@example.com', alternateEmail: 'AJ@example.com', tertiaryEmail: null, fourthEmail: '', billingEmail: 'MA@example.com', billingCCEmail: 'aj@example.com',
    phoneNumber: '631-555-0001', alternatePhoneNumber: '(631) 555-0002', tertiaryPhoneNumber: null, fourthPhoneNumber: '6315550001',
    latitude: null, longitude: null, status: 'ACTIVE', notes: null, tags: [],
  }])]);
  const { items } = await reader(f).getSites({ tenant: 't' });
  assert.strictEqual(items[0].email, 'ma@example.com');
  assert.deepStrictEqual(items[0].otherEmails, ['AJ@example.com']);
  assert.deepStrictEqual(items[0].otherPhones, ['(631) 555-0002']);
  assert.match(f.calls[0].query, /\balternateEmail\b/);
  assert.match(f.calls[0].query, /\bbillingCCEmail\b/);
});

test('Custom Pricing: each customer\'s quoted prices per type, in dollars, on their own query (v1.3.0)', async () => {
  const f = fakeFetch([conn('infiniteCustomers', [
    { id: 'cu1', quotedPrices: [
      { id: 'q1', typeId: 'ty1', price: 82, serviceTypeDisplay: 'Pool Service - Weekly' },
      { id: 'q2', typeId: 'ty2', price: 450, serviceTypeDisplay: 'Pool Closing' },
      { id: 'q3', typeId: null, price: 650, serviceTypeDisplay: 'Pressure test' },
      { id: 'q4', typeId: 'ty3', price: null, serviceTypeDisplay: 'Spa Closing' },
    ] },
    { id: 'cu2', quotedPrices: [] },
    { id: 'cu3', quotedPrices: null },
  ])]);
  const { items } = await reader(f).getQuotedPrices({ tenant: 't' });
  assert.deepStrictEqual(items, [{ siteId: 'cu1', prices: [
    { typeId: 'ty1', typeName: 'Pool Service - Weekly', price: 82 },
    { typeId: 'ty2', typeName: 'Pool Closing', price: 450 },
  ] }], 'no type or no price cannot price a visit and is dropped; customers without a card are left out');
  assert.match(f.calls[0].query, /quotedPrices \{ id typeId price serviceTypeDisplay \}/);
  assert.doesNotMatch(f.calls[0].query, /streetAddress/, 'its own query, not the site read');
});

test('a site with no tags carries an empty list, never null', async () => {
  const f = fakeFetch([conn('infiniteCustomers', [
    { id: 'cu1', firstName: 'a', status: 'ACTIVE' },
    { id: 'cu2', firstName: 'b', status: 'ACTIVE', tags: null },
    { id: 'cu3', firstName: 'c', status: 'ACTIVE', tags: ['ok', 7, null] },
  ])]);
  const { items } = await reader(f).getSites({ tenant: 't' });
  assert.deepStrictEqual(items[0].tags, []);
  assert.deepStrictEqual(items[1].tags, []);
  assert.deepStrictEqual(items[2].tags, ['ok'], 'only strings survive');
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

/* ------------------------------------------- equipment reads (v1.4.0) -- */

test('getBodiesOfWater returns each customer\'s bodies with the equipment boxes, blanks as null', async () => {
  const f = fakeFetch([conn('infiniteCustomers', [
    { id: 'cu1', bodiesOfWater: [{ id: 'b1', name: 'Primary Pool', type: '', volume: 20000, pump: 'Pentair VS', filter: '  ', heater: null, sanitizer: 'Salt', sanitizerDisplayed: 'Salt', winterCoverType: null, other: null }] },
    { id: 'cu2', bodiesOfWater: [] },
    { id: 'cu3', bodiesOfWater: null },
  ])]);
  const { items } = await reader(f).getBodiesOfWater({ tenant: 't' });
  assert.strictEqual(items.length, 1, 'a customer with no body is left out');
  assert.strictEqual(items[0].siteId, 'cu1');
  const b = items[0].bodies[0];
  assert.strictEqual(b.bodyId, 'b1');
  assert.strictEqual(b.pump, 'Pentair VS');
  assert.strictEqual(b.filter, null, 'whitespace is a blank box');
  assert.strictEqual(b.type, null);
  assert.strictEqual(b.volume, 20000);
  assert.match(f.calls[0].query, /bodiesOfWater \{ id name type volume dimensions notes pump filter heater cleaner sanitizer sanitizerDisplayed winterCoverType other \}/);
  assert.doesNotMatch(f.calls[0].query, /mutation/);
});

test('getServicePictures reads only the named customers, newest first, and keeps reports with photos', async () => {
  const f = fakeFetch([conn('infiniteServices', [
    { id: 's1', startTime: '2026-05-01T12:00:00.000Z', type: { id: 't1', display: 'Pool Opening - First' }, customer: { id: 'cu1' }, pictures: [{ id: 'p1', file: { url: 'https://f9.cdn.example/a.jpg' } }, { id: 'p2', file: { url: 'http://insecure/b.jpg' } }] },
    { id: 's2', startTime: '2026-05-08T12:00:00.000Z', type: { id: 't2', display: 'Pool Service - Weekly' }, customer: { id: 'cu1' }, pictures: [] },
  ])]);
  const { items } = await reader(f).getServicePictures({ tenant: 't', siteIds: ['cu1'] });
  assert.deepStrictEqual(items, [{ serviceReportId: 's1', siteId: 'cu1', startTime: '2026-05-01T12:00:00.000Z', serviceTypeName: 'Pool Opening - First', urls: ['https://f9.cdn.example/a.jpg'] }]);
  assert.deepStrictEqual(f.calls[0].variables.selector, { filters: { customerId: { in: ['cu1'] } } });
  assert.deepStrictEqual(f.calls[0].variables.sort, [{ field: 'startTime', order: 'DESC' }]);
  assert.match(f.calls[0].query, /pictures \{ id file \{ url \} \}/);
});

test('getServicePictures refuses a company-wide read', async () => {
  const f = fakeFetch([conn('infiniteServices', [])]);
  await assert.rejects(() => reader(f).getServicePictures({ tenant: 't' }), /siteIds/);
  await assert.rejects(() => reader(f).getServicePictures({ tenant: 't', siteIds: [] }), /siteIds/);
  const many = Array.from({ length: 51 }, (_, i) => 'cu' + i);
  await assert.rejects(() => reader(f).getServicePictures({ tenant: 't', siteIds: many }), /1-50/);
  assert.strictEqual(f.calls.length, 0, 'nothing was asked of POM');
});

test('v1.5.0: a service report names who was there - the PRIMARY worker of the array, never workers.primary', async () => {
  const f = fakeFetch([conn('infiniteServices', [
    { id: 's1', startTime: '2026-10-03T14:10:00.000Z', technician: { id: 'u2' }, customer: { id: 'cu1' },
      workers: [
        { primary: false, user: { id: 'u1', firstName: 'Chris', lastName: 'Helper' } },
        { primary: true, user: { id: 'u2', firstName: 'Spencer', lastName: 'Chase' } },
      ] },
    { id: 's2', startTime: '2026-10-03T15:00:00.000Z', customer: { id: 'cu2' },
      workers: [{ user: { id: 'u3', firstName: 'Daniel', lastName: null } }] },
    { id: 's3', startTime: '2026-10-03T16:00:00.000Z', customer: { id: 'cu3' }, workers: null },
  ])]);
  const { items } = await reader(f).getServiceReports({ tenant: 't', since: '2026-10-03T00:00:00.000Z', until: '2026-10-04T00:00:00.000Z' });
  assert.strictEqual(items[0].technicianName, 'Spencer Chase', 'the primary, not the first');
  assert.deepStrictEqual(items[0].workers, [
    { userId: 'u1', name: 'Chris Helper', primary: false }, { userId: 'u2', name: 'Spencer Chase', primary: true },
  ]);
  assert.strictEqual(items[1].technicianName, 'Daniel', 'no primary marked: the first worker');
  assert.strictEqual(items[2].technicianName, null);
  assert.deepStrictEqual(items[2].workers, []);
  assert.match(f.calls[0].query, /workers \{ primary user \{ id firstName lastName \} \}/, 'asked for on the wire');
});

test('v1.5.0: an appointment carries its private notes and its workers\' ids', async () => {
  const f = fakeFetch([conn('infiniteAppointments', [
    { id: 'a1', date: '2026-10-06T13:00:00.000Z', status: 'ASSIGNED', notes: null,
      privateNotes: 'customer says feeder sticking, bring gasket kit', workers: [{ id: 'u2' }, null],
      serviceType: { id: 't1', display: 'Pool or Spa Check' }, customer: { id: 'cu1', streetAddress: '1109 Head of Pond' } },
    { id: 'a2', date: '2026-10-06T14:00:00.000Z', status: 'ASSIGNED', customer: { id: 'cu2' } },
  ])]);
  const { items } = await reader(f).getAppointments({ tenant: 't', startDate: '2026-10-04', endDate: '2026-10-10' });
  assert.strictEqual(items[0].privateNotes, 'customer says feeder sticking, bring gasket kit');
  assert.deepStrictEqual(items[0].workerIds, ['u2']);
  assert.strictEqual(items[1].privateNotes, null);
  assert.deepStrictEqual(items[1].workerIds, []);
  assert.match(f.calls[0].query, /\bprivateNotes\b/);
  assert.match(f.calls[0].query, /workers \{ id \}/);
});
