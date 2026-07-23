const { Router } = require('express');
const { getPool } = require('../db/pool');
const { isEnabled, llmMode, MODELS, DEFAULT_MODEL, isValidModel } = require('../services/llm');
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
      const prefs = rows.length ? rows[0].preferences || {} : {};
      const defaultModel = isValidModel(config.anthropicModel) ? config.anthropicModel : DEFAULT_MODEL;
      const effectiveModel = isValidModel(prefs.model) ? prefs.model : defaultModel;
      res.json({
        user: {
          id: req.user.id,
          username: req.user.username,
          preferences: prefs,
        },
        llm: {
          enabled: isEnabled(config),
          mode: llmMode(config),
          models: MODELS,
          model: effectiveModel,
          defaultModel,
        },
        staging: config.isStaging,
      });
    } catch (err) {
      log.error('auth', 'Failed to load settings', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Today's (UTC) estimated LLM spend for the requester, for the "AI usage
  // today" section of the user menu. Spend is tracked locally per API turn
  // (see chat.js recordUsage) — the platform exposes no usage endpoint, so
  // this is an estimate, not the proxy's own accounting.
  router.get('/api/usage/today', async (req, res) => {
    try {
      let { rows } = await pool.query(
        `SELECT date, input_tokens, output_tokens, estimated_microcents
         FROM llm_usage WHERE user_id = $1 AND date = (NOW() AT TIME ZONE 'utc')::date`,
        [req.user.id]
      );
      // Staging: fall back to the seeded demo user's row so testers see a
      // populated meter (same convention as other staging demo fallbacks).
      if (!rows.length && config.isStaging) {
        ({ rows } = await pool.query(
          `SELECT date, input_tokens, output_tokens, estimated_microcents
           FROM llm_usage WHERE user_id = 0 AND date = (NOW() AT TIME ZONE 'utc')::date`
        ));
      }
      const row = rows[0];
      res.json({
        date: row ? row.date : null,
        inputTokens: row ? Number(row.input_tokens) : 0,
        outputTokens: row ? Number(row.output_tokens) : 0,
        estimatedCents: row ? Number(row.estimated_microcents) / 1e6 : 0,
        llm: { enabled: isEnabled(config), mode: llmMode(config) },
      });
    } catch (err) {
      log.error('auth', 'Failed to load usage', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/auth/preferences', async (req, res) => {
    // Language is NOT an app preference — it follows the platform-level
    // user setting (the JWT locale claim); any client-sent value is ignored.
    const { diet, complexity, serving, tempUnit, model } = req.body;

    if (model != null && !isValidModel(model)) {
      return res.status(400).json({ error: 'Unknown model' });
    }

    const prefs = {
      diet: diet || null,
      complexity: complexity || 'normal',
      serving: serving || 'normal',
      tempUnit: tempUnit === 'F' ? 'F' : 'C',
    };
    if (isValidModel(model)) prefs.model = model;

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
