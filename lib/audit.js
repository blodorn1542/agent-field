'use strict';

const { redact } = require('./credentials');

/**
 * The write audit log.
 *
 * Every attempt to change POM through this package lands here - including the
 * ones that were refused. A log that only records successes cannot answer the
 * question you actually ask it at 2am, which is "what tried to touch this
 * company's schedule, and who let it".
 *
 * Rows are append-only by intent: there is no update or delete in this module.
 *
 * Arguments are stored as a JSON digest with the API key stripped. An audit
 * trail that leaks the credential it was protecting is a downgrade, not a
 * control.
 */

const OUTCOMES = Object.freeze([
  'attempted',            // a write was requested
  'denied_tenant_opt_out',// the company has not turned writes on
  'denied_no_grant',      // this agent was never granted this scope
  'denied_unapproved',    // consequential, and no approval was held
  'approved',             // an approval was presented and accepted
  'succeeded',
  'failed',
]);

const SECRET_KEYS = /^(apikey|api_key|key|token|secret|authorization|password)$/i;

/** Deep-copy `args` for storage, replacing anything credential-shaped. */
function scrub(value) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && value.startsWith('pom_') ? redact(value) : value;
  }
  if (Array.isArray(value)) return value.map(scrub);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? redact(v) : scrub(v);
  }
  return out;
}

function createAudit(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS field_write_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      at            TEXT NOT NULL,
      tenant_id     TEXT NOT NULL,
      provider      TEXT NOT NULL,
      agent         TEXT NOT NULL,
      method        TEXT NOT NULL,
      scope         TEXT,
      consequential INTEGER NOT NULL DEFAULT 0,
      outcome       TEXT NOT NULL,
      approval_id   TEXT,
      approved_by   TEXT,
      args_digest   TEXT,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS field_write_audit_tenant
      ON field_write_audit (tenant_id, at);
  `);

  function record(entry) {
    if (!OUTCOMES.includes(entry.outcome)) {
      throw new Error('Unknown audit outcome "' + entry.outcome + '"');
    }
    db.prepare(`
      INSERT INTO field_write_audit (at, tenant_id, provider, agent, method, scope,
        consequential, outcome, approval_id, approved_by, args_digest, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      entry.at ?? new Date().toISOString(),
      entry.tenantId, entry.provider ?? 'pom', entry.agent, entry.method,
      entry.scope ?? null,
      entry.consequential ? 1 : 0,
      entry.outcome,
      entry.approvalId ?? null,
      entry.approvedBy ?? null,
      entry.args === undefined ? null : JSON.stringify(scrub(entry.args)),
      entry.error ? String(entry.error).slice(0, 2000) : null,
    );
  }

  function list(tenantId, { limit = 100 } = {}) {
    return db.prepare(
      'SELECT * FROM field_write_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT ?'
    ).all(tenantId, limit);
  }

  return { record, list };
}

/** Fail at construction when a host passes something that is not the port. */
function assertAuditPort(a) {
  if (typeof a?.record !== 'function') {
    throw new Error('audit port is missing record(entry). agent-field will not construct a '
      + 'writer without somewhere to log what it does.');
  }
  return a;
}

module.exports = { createAudit, assertAuditPort, scrub, OUTCOMES };
