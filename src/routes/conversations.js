const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

function conversationRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // In staging, list/read endpoints also expose the seeded demo rows
  // (user_id = 0, see src/db/migrate.js) so testers see populated data.
  const ownerClause = (col) =>
    config.isStaging ? `${col} IN ($1, 0)` : `${col} = $1`;

  router.get('/api/conversations', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, title, created_at FROM conversations WHERE ${ownerClause('user_id')} ORDER BY created_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('conversations', 'List failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'INSERT INTO conversations (user_id) VALUES ($1) RETURNING id, title, created_at',
        [req.user.id]
      );
      log.info('conversations', 'Created', { id: rows[0].id, userId: req.user.id });
      res.json(rows[0]);
    } catch (err) {
      log.error('conversations', 'Create failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/conversations/:id/messages', async (req, res) => {
    try {
      const convId = parseInt(req.params.id);
      const { rows: conv } = await pool.query(
        `SELECT id, preferences, ui_state FROM conversations WHERE id = $1 AND ${config.isStaging ? 'user_id IN ($2, 0)' : 'user_id = $2'}`,
        [convId, req.user.id]
      );

      if (conv.length === 0) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const { rows } = await pool.query(
        'SELECT role, content, recipe_data, response_log, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
        [convId]
      );

      const { rows: pendingRows } = await pool.query(
        `SELECT id, status, created_at FROM pending_replies WHERE conversation_id = $1 AND user_id = $2 AND status IN ('processing', 'done') ORDER BY created_at DESC LIMIT 1`,
        [convId, req.user.id]
      );
      const pendingReply = pendingRows.length ? {
        id: pendingRows[0].id,
        status: pendingRows[0].status,
        createdAt: pendingRows[0].created_at,
      } : null;

      res.json({
        messages: rows,
        preferences: conv[0].preferences || {},
        ui_state: conv[0].ui_state || {},
        pendingReply,
      });
    } catch (err) {
      log.error('conversations', 'Get messages failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/conversations/:id/ui-state', async (req, res) => {
    try {
      const convId = parseInt(req.params.id);
      const { ui_state } = req.body;
      await pool.query(
        'UPDATE conversations SET ui_state = $1 WHERE id = $2 AND user_id = $3',
        [JSON.stringify(ui_state || {}), convId, req.user.id]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'Update ui_state failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/conversations/:id', async (req, res) => {
    try {
      const convId = parseInt(req.params.id);
      await pool.query(
        'DELETE FROM conversations WHERE id = $1 AND user_id = $2',
        [convId, req.user.id]
      );
      log.info('conversations', 'Deleted', { id: convId });
      res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'Delete failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { conversationRoutes };
