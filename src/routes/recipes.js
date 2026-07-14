const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

function recipeRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/recipes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (c.id)
           m.id, m.recipe_data AS data, m.conversation_id, m.created_at,
           c.title AS conversation_title
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE ${config.isStaging ? 'c.user_id IN ($1, 0)' : 'c.user_id = $1'} AND m.recipe_data IS NOT NULL
         ORDER BY c.id, m.created_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('recipes', 'List failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { recipeRoutes };
