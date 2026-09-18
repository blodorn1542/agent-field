# agent-field

The shared Field Services layer for the agent platform. Pool Office Manager
(Pool Service Manager) is one adapter behind the interface. Agents depend on
this package; it depends on no agent. The dependency runs one way, the same as
`agent-comms` and `agent-financial`.

There are two interfaces, and which one an agent is handed is the whole security
model:

| | `fieldReader` | `fieldWriter` |
|---|---|---|
| built by | `createFieldReader()` | `createFieldWriter()` |
| surface | 4 reads, frozen | **empty today, by design** |
| default | available to any agent | off for every tenant |
| transport | refuses non-query operations | mutation-capable |
| audit | none needed | every attempt, including refusals |

```js
const { createFieldReader } = require('agent-field');

const field = createFieldReader({ credentials });   // host's own storage

const visits = await field.getAppointments({
  tenant: 'elite-pools', startDate: '2026-09-01', endDate: '2026-09-30',
});
const reports = await field.getServiceReports({
  tenant: 'elite-pools', siteIds: visits.items.map((v) => v.siteId),
});
```

## The read interface

Four methods. This is the entire surface.

- `getAppointments({ tenant, startDate, endDate })` — scheduled visits. The date
  window is **required**; see "POM quirks" for why.
- `getServiceReports({ tenant, since?, until?, siteIds?, serviceTypeIds?, flag? })`
  — completed records, chemistry included. **Pass `since`.** See below.
- `getServiceTypes({ tenant })` — the raw service-type catalog, unnormalized.
- `getSites({ tenant })` — the serviced properties.

Each returns `{ items, truncated, pages }`. `truncated: true` means the page cap
was hit and you are holding a prefix — POM exposes no total count anywhere, so
this flag is the only way to tell a complete answer from a partial one.

## Per-tenant auth

POM is not OAuth. Each company generates a key in POM under **Settings → API
Keys**, ticks the per-object scopes, and pastes it in — the same per-tenant shape
as the QuickBooks connection, minus the redirect dance.

```js
await field.auth.verifyKey('pom_live_...');            // prove it works first
await field.auth.connect('elite-pools', 'pom_live_...'); // then store it
```

`connect()` verifies before storing and echoes back the POM account name, so a
company can see which account it just linked. Keys are never logged: everything
human-visible goes through `redact()`, which prints `pom_live_...mc78`.

A key with only View scopes ticked is the right key for a reader. That is
defence in depth, not the guarantee — the guarantee is below, and it holds even
if someone pastes a full-access key.

## Guardrails

### `fieldReader` has no path to a write

Five independent mechanisms, each in one place, each with a test.

| # | Guarantee | Where |
|---|---|---|
| 1 | The surface is an allow-list of four reads, checked in both directions — a missing method *and* an extra one both throw at construction | [`lib/interface.js`](lib/interface.js) `READ_METHODS`, `createFieldReader()` |
| 2 | The returned object is frozen, and re-frozen after spreading | [`lib/interface.js`](lib/interface.js) + [`index.js`](index.js) |
| 3 | Any adapter exposing `writes`, or naming a read after a mutating verb, is refused at construction | [`lib/interface.js`](lib/interface.js) `assertReadOnly()`, `MUTATING` |
| 4 | The reader's transport parses the GraphQL document and **throws on anything that is not a query** | [`lib/transport.js`](lib/transport.js) `createReadTransport()` |
| 5 | No write transport, writer factory, or adapter handle exists in the reader's scope | [`index.js`](index.js) `createFieldReader()` |

**On #4.** `agent-financial` got its read-only promise cheaply: QuickBooks is
REST, so a `get()` taking no method argument physically cannot POST. POM is
GraphQL — every call, read and write alike, is a POST to one URL, so the HTTP
verb carries no information. The guarantee moves onto the document itself. There
are two transport functions, not one function with a flag, because a flag is the
bug waiting to happen: one caller passing `{ allowMutations: true }` and the
structural claim is gone.

**On #5.** `adapterFor` is deliberately *not* on the object an agent holds. It
stays in `index.js`'s closure, because an agent that can reach the adapter can
walk past the four-method allow-list, and then the allow-list is decoration.

What this looks like in practice:

```js
field.createAppointment = async () => {};  // TypeError: object is not extensible
field.adapterFor                           // undefined
await readTransport(key, 'mutation M { ... }')
// Error: fieldReader attempted a non-query GraphQL operation. This transport
// carries reads only; there is no option to relax it.
```

`test/interface.test.js` walks the reader's whole object graph to six levels
deep and asserts that nothing write-shaped is reachable — it proves the claim
rather than restating it.

### `fieldWriter` is built but empty

`WRITES` in [`lib/writer.js`](lib/writer.js) is the registry of every write this
package will ever perform, and it is `Object.freeze([])`. A constructed writer
therefore has no callable write methods. The methods are missing because we have
not yet named which agents write or what they write, and a seam built around
imagined methods fits the imagined ones.

What *is* finished is the part that is expensive to retrofit — four gates, in
order, every one logged whether it passes or fails:

1. **Tenant opt-in.** Off for every company until that company turns it on.
   `undefined` reads as off, and only a literal `true` enables it — not `1`, not
   `'yes'`.
2. **Per-agent grant.** A tenant opting in does not open the door to every
   agent. Each agent holds named scopes; each write declares the scope it needs.
3. **Approval.** Anything marked `consequential` needs a held approval naming
   that tenant, agent and method. **No approvals port configured means every
   consequential write is refused** — the correct failure direction.
4. **Audit.** Every attempt is recorded before it runs and after it resolves,
   refusals included. A log that only records successes cannot answer the
   question you actually ask it.

`consequential: true` is the default posture, because the output of a
field-service system is somebody driving to somebody else's house.

Adding the first write is one frozen descriptor in `WRITES` — the gates above
already apply to it, and `test/writer.test.js` already exercises them.

## POM quirks worth knowing

All verified against the live API with a read-only key on 2026-09-18.
Introspection is disabled on their production Apollo server, so these were
recovered by probing rather than read from a schema.

- **Errors arrive as HTTP 200** with an `errors` array. `res.ok` is not a
  success test.
- **`Authorization: Bearer` is the only accepted header.** `X-API-Key`,
  `x-api-key` and a raw `Authorization` value all return `Unauthorized`.
- **A list query returns nothing without its `selector`.**
  `infiniteAppointments` with only `first` returns an empty edge list *and no
  error* — indistinguishable from a company with no appointments. This is why
  `getAppointments` makes the date window mandatory.
- **The two selectors are different types.** Appointments take
  `{ startDate, endDate }`. Services take `{ filters: { … } }`, and its date
  filters are `DateTimeFilter` — `equals`/`in`/`not`/`notIn` and **no range
  operators**.
- **A service date window is served by sorting, not filtering.** The service
  connection is ascending by default and sortable via
  `sort: [{ field: startTime, order: DESC }]`. `getServiceReports({ since })`
  sorts newest-first and stops at the first record older than `since`. On the
  Elite Pools tenant that is **1 page / 370ms for one day**, against 200 pages /
  41s for an unwindowed walk that still truncates. An unwindowed read walks the
  company's entire history — always pass `since` in a recurring job.
- **`sort` is a list**, `[ServicesSort!]`, not a single object.
- **Page size caps at 100.** `first: 101` is a validation error.
- **A service type's name is `display`.** There is no `name` on `Type`.
- **POM misspells cyanuric acid as `cynuricAcid`.** Matched on the wire,
  corrected once on the way out.
- **A "site" is a POM `Customer`.** POM's `locations` object is the operator's
  own business address — one row for the whole company.

### Chemistry

Chemistry lives as flat scalars directly on the Service record. There is no
separate readings object and no separate endpoint. Exposed under corrected
names:

`ph`, `freeChlorine`, `combinedChlorine`, `totalAlkalinity`, `calciumHardness`,
`cyanuricAcid`, `salt`, `phosphates`, `copper`, `iron`, `waterTemperature`

`null` means **not recorded** and must never be read as zero — `0` is a real
recorded reading and the two are different findings. `chemistryRecorded` counts
how many of the eleven were actually entered.

On the Elite Pools tenant, `combinedChlorine`, `copper` and `iron` came back null
on all 1,200 records sampled. They are carried through rather than dropped,
because a field empty for one company is not necessarily empty for the next.

### Missed and overdue service

A missed service is an appointment with no matching service report. Two things
to know before building that:

- There is **no foreign key** between `Appointment` and `Service` in either
  direction. Matching is on site + service type + date proximity.
- Appointments carry a `status` (`COMPLETE` / `OPEN`) and the shaped record
  exposes `completed`. That is a cheaper first signal than the join, though it
  reflects what a tech marked rather than whether a report exists.

That logic is deliberately **not** in this package — it is a judgement about what
counts as missed, and it belongs to whichever agent is making the call.

## Service-type normalization

`getServiceTypes()` returns a company's catalog exactly as that company keeps it.
The mapping to canonical names lives in **tenant config, never in this repo**,
and is re-runnable.

```js
const { applyMapping, suggestMapping } = require('agent-field');

const catalog = await field.getServiceTypes({ tenant: 'elite-pools' });
const result = applyMapping(catalog.items, tenantConfig.serviceTypeMapping);
// { types, byCanonical, unmapped, stale, complete, counts }
```

The live Elite Pools catalog is why this split exists: 96 types including
`Pool Opening - NO USE`, `Pool Opening - Vinyl`, `Pool Service - Weekly`,
`Pool Service - Indoor` and `Estimate Description:Salt System Install`. Any rule
general enough to sort that in code is wrong for the next company, and being
wrong here means an agent classifying a pool opening as a weekly clean.

Mappings are keyed by **POM id, not display name** — names get edited in POM's
UI, ids do not. Re-running after a company adds a type surfaces exactly that
type in `unmapped`; a mapping pointing at a type POM no longer has shows up in
`stale`. `complete` ignores inactive and deleted types, so onboarding is not held
open over something retired in 2023.

`suggestMapping()` offers a slug of the company's own wording so a human can
click through 96 types quickly. It is never applied automatically.

## Layout

```
index.js                  composition; the two factories
lib/interface.js          fieldReader - the frozen four-method allow-list
lib/writer.js             fieldWriter - empty registry + the four gates
lib/transport.js          read transport (refuses mutations) / write transport
lib/credentials.js        per-tenant API key storage + redaction
lib/audit.js              append-only write audit, credential-scrubbing
lib/normalize.js          re-runnable service-type mapping (pure)
lib/adapters/pom.js       the one POM adapter
```

## Tests

```bash
npm test
```

58 tests. The ones that matter most are in `test/interface.test.js`
(the reader has no write path) and `test/writer.test.js` (the four gates refuse
in the right order and log it).
