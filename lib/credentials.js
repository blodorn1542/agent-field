'use strict';

/**
 * Where a tenant's POM API key lives.
 *
 * POM is not OAuth. Each company generates a key in POM's own UI (Settings ->
 * API Keys), ticks the per-object scopes it wants, and pastes the key in - the
 * same per-tenant shape as the QuickBooks connection in agent-financial, minus
 * the redirect dance. There is no refresh token and nothing expires on a timer;
 * a key stops working when someone revokes or rotates it, which surfaces as
 * UNAUTHENTICATED on the next read.
 *
 * The port is the same three functions agent-financial uses, so a host can hand
 * over its existing row-returning function instead of remapping fields:
 *
 *   get(tenantId, provider)          -> stored row, or null
 *   save(tenantId, provider, creds)  creds: { apiKey, endpoint, externalName, scopes }
 *   remove(tenantId, provider)
 *
 * Reads come back snake_case, because that is what a SQLite row looks like.
 *
 * Two things this deliberately does NOT do. It does not encrypt the key at
 * rest - that is the host's storage decision, and pretending otherwise with a
 * key sitting in the same process would be theatre. And it never logs the key:
 * see redact() below, which is what the audit log and every error path use.
 */

function createCredentials(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS field_connections (
      tenant_id      TEXT NOT NULL,
      provider       TEXT NOT NULL,
      api_key        TEXT,
      endpoint       TEXT,
      external_name  TEXT,
      scopes         TEXT,
      connected_at   TEXT,
      updated_at     TEXT,
      PRIMARY KEY (tenant_id, provider)
    );
  `);

  function get(tenantId, provider) {
    return db.prepare(
      'SELECT * FROM field_connections WHERE tenant_id = ? AND provider = ?'
    ).get(tenantId, provider) ?? null;
  }

  function save(tenantId, provider, creds) {
    const now = new Date().toISOString();
    const existing = get(tenantId, provider);
    db.prepare(`
      INSERT INTO field_connections (tenant_id, provider, api_key, endpoint,
        external_name, scopes, connected_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, provider) DO UPDATE SET
        api_key = excluded.api_key,
        endpoint = COALESCE(excluded.endpoint, field_connections.endpoint),
        external_name = COALESCE(excluded.external_name, field_connections.external_name),
        scopes = COALESCE(excluded.scopes, field_connections.scopes),
        updated_at = excluded.updated_at
    `).run(
      tenantId, provider,
      creds.apiKey ?? null,
      creds.endpoint ?? null,
      creds.externalName ?? null,
      creds.scopes ? JSON.stringify(creds.scopes) : null,
      existing?.connected_at ?? now, now,
    );
  }

  function remove(tenantId, provider) {
    db.prepare('DELETE FROM field_connections WHERE tenant_id = ? AND provider = ?')
      .run(tenantId, provider);
  }

  return { get, save, remove };
}

/** Fail at construction, clearly, when a host passes something that is not the port. */
function assertCredentialsPort(c) {
  for (const fn of ['get', 'save', 'remove']) {
    if (typeof c?.[fn] !== 'function') {
      throw new Error('credentials port is missing ' + fn + '(). It needs get(tenantId, '
        + 'provider), save(tenantId, provider, creds) and remove(tenantId, provider).');
    }
  }
  return c;
}

/**
 * POM keys are `pom_live_` + 43 chars. Everything that might be seen by a human
 * - audit rows, error messages, onboarding confirmations - goes through here.
 */
function redact(apiKey) {
  const s = String(apiKey ?? '');
  if (!s) return '(none)';
  const prefix = s.startsWith('pom_live_') ? 'pom_live_' : s.slice(0, 4);
  return prefix + '...' + s.slice(-4);
}

/** A pasted key that is obviously not a POM key should fail at paste time. */
function assertKeyShape(apiKey) {
  const s = String(apiKey ?? '').trim();
  if (!/^pom_(live|test)_[A-Za-z0-9._-]{8,}$/.test(s)) {
    throw new Error('That does not look like a POM API key. Expected it to start with '
      + '"pom_live_" - copy it from POM under Settings -> API Keys.');
  }
  return s;
}

module.exports = { createCredentials, assertCredentialsPort, redact, assertKeyShape };
