const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// Feedback is stored in the app's own `feedback` table (staging:private)
// for the owner to review — no external issue tracker involved.
function feedbackRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.post('/api/feedback', async (req, res) => {
    const { description } = req.body;
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return res.status(400).json({ error: 'Description is required' });
    }
    if (description.length > 2000) {
      return res.status(400).json({ error: 'Description too long (max 2000 chars)' });
    }

    try {
      await pool.query(
        'INSERT INTO feedback (user_id, username, description) VALUES ($1, $2, $3)',
        [req.user.id, req.user.username, description.trim()]
      );
      log.info('feedback', 'Feedback received', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('feedback', 'Failed to save feedback', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { feedbackRoutes };
