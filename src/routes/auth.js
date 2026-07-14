const { Router } = require('express');
const { getPool } = require('../db/pool');
const { isEnabled, llmMode } = require('../services/llm');
const log = require('../services/logger');

// Identity comes from the platform JWT (see src/middleware/auth.js).
// This router only exposes the current user + their saved preferences.
function authRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/auth/me', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT preferences FROM user_settings WHERE user_id = $1',
        [req.user.id]
      );
      res.json({
        user: {
          id: req.user.id,
          username: req.user.username,
          preferences: rows.length ? rows[0].preferences || {} : {},
        },
        llm: { enabled: isEnabled(config), mode: llmMode(config) },
        staging: config.isStaging,
      });
    } catch (err) {
      log.error('auth', 'Failed to load settings', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/auth/preferences', async (req, res) => {
    const { diet, complexity, serving, tempUnit } = req.body;
    const prefs = {
      diet: diet || null,
      complexity: complexity || 'normal',
      serving: serving || 'normal',
      tempUnit: tempUnit === 'F' ? 'F' : 'C',
    };

    try {
      await pool.query(
        `INSERT INTO user_settings (user_id, username, preferences)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET username = $2, preferences = $3`,
        [req.user.id, req.user.username, JSON.stringify(prefs)]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('auth', 'Failed to save preferences', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { authRoutes };
