const { Pool } = require('pg');
const log = require('../services/logger');

let pool;

function getPool(config) {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl });
    pool.on('error', (err) => {
      log.error('db', 'Unexpected pool error', { message: err.message });
    });
  }
  return pool;
}

module.exports = { getPool };
