'use strict';

/**
 * The POM wire.
 *
 * agent-financial could make its read-only promise cheaply: QuickBooks is REST,
 * so a get() that takes no method argument physically cannot POST. POM is
 * GraphQL, where every call - read and write alike - is a POST to one URL. The
 * HTTP verb carries no meaning here, so the guarantee has to move up one layer,
 * onto the document itself.
 *
 * So there are two transports, and they are different functions, not one
 * function with a flag:
 *
 *   createReadTransport()  - parses the operation and THROWS on anything that
 *                            is not a query. There is no argument, option or
 *                            property that relaxes this.
 *   createWriteTransport() - will carry a mutation, and is only ever handed to
 *                            the writer seam in lib/writer.js.
 *
 * A flag would have been smaller and would have been the bug: one caller
 * passing `{ allowMutations: true }` and the structural claim is gone. The
 * reader never receives the write transport and has no closure reference to
 * it, so "the reader cannot write" is a statement about what exists in scope,
 * not about what callers remember to do.
 */

/**
 * Strip string literals, block strings and comments so an operation keyword
 * inside a user-supplied value cannot be mistaken for the real thing - and,
 * more to the point, so a mutation cannot hide behind one.
 */
function stripLiterals(doc) {
  return String(doc)
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/#[^\n\r]*/g, '');
}

/**
 * Every operation in the document. An anonymous `{ ... }` document is a query.
 * Returns e.g. ['query'] or ['query', 'mutation'].
 */
function operationsIn(doc) {
  const src = stripLiterals(doc).trim();
  if (!src) return [];
  const ops = [];
  const re = /(^|[}\s])(query|mutation|subscription)\b/g;
  let m;
  while ((m = re.exec(src)) !== null) ops.push(m[2]);
  // A document that opens with `{` is a shorthand query with no keyword.
  if (src.startsWith('{')) ops.unshift('query');
  return ops;
}

/** True when every operation in the document is a read. */
function isReadOnlyDocument(doc) {
  const ops = operationsIn(doc);
  return ops.length > 0 && ops.every((o) => o === 'query');
}

/**
 * POM answers a rejected query with HTTP 200 and an `errors` array - verified
 * against the live API, and the reason this is a shared helper rather than a
 * check each caller remembers. `res.ok` is not a success test here.
 */
async function post({ endpoint, apiKey, query, variables, fetchImpl, timeoutMs = 30000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        // Verified against the live API: Bearer is the only header POM accepts.
        // X-API-Key, x-api-key and a raw Authorization value all return
        // Unauthorized, so there is nothing to fall back to.
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('POM returned non-JSON (HTTP ' + res.status + '): ' + text.slice(0, 300));
  }

  if (json.errors?.length) {
    const first = json.errors[0];
    const err = new Error('POM GraphQL error: ' + first.message);
    err.code = first.extensions?.code;
    err.graphQLErrors = json.errors;
    // UNAUTHENTICATED is worth naming: it is what a tenant sees the day their
    // pasted key is revoked, and it should not read as a schema problem.
    if (err.code === 'UNAUTHENTICATED') {
      err.message = 'POM rejected the API key for this tenant (UNAUTHENTICATED). '
        + 'The key was revoked, rotated, or belongs to another company.';
    }
    throw err;
  }
  return json.data;
}

/**
 * The only wire the reader ever holds. It takes a document and variables, and
 * it will not carry a mutation - not for any caller, under any argument.
 */
function createReadTransport({ endpoint, fetchImpl = fetch, timeoutMs }) {
  return async function readQuery(apiKey, query, variables) {
    if (!isReadOnlyDocument(query)) {
      throw new Error(
        'fieldReader attempted a non-query GraphQL operation. This transport carries '
        + 'reads only; there is no option to relax it. If an agent needs to write to '
        + 'POM, it must be granted fieldWriter (lib/writer.js), which is off by default.'
      );
    }
    return post({ endpoint, apiKey, query, variables, fetchImpl, timeoutMs });
  };
}

/**
 * The write wire. Constructed only by lib/writer.js, only for a tenant that has
 * opted in and an agent that has been granted a scope. Nothing in the reader's
 * scope can reach this function.
 */
function createWriteTransport({ endpoint, fetchImpl = fetch, timeoutMs }) {
  return async function writeMutation(apiKey, query, variables) {
    return post({ endpoint, apiKey, query, variables, fetchImpl, timeoutMs });
  };
}

module.exports = {
  createReadTransport, createWriteTransport,
  isReadOnlyDocument, operationsIn, stripLiterals,
};
