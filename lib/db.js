'use strict';

const { DatabaseSync } = require('node:sqlite');

/**
 * Same shape as agent-financial and agent-comms: a package that can stand alone
 * when it has to, and gets out of the way when the host already has a database.
 */
function openDatabase(dbPath) {
  if (!dbPath) {
    throw new Error('agent-field needs either { credentials }, { db }, or { dbPath }. '
      + 'Pass the host\'s own credential storage if this tenant is already connected.');
  }
  return new DatabaseSync(dbPath);
}

module.exports = { openDatabase };
