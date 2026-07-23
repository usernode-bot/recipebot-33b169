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
        `SELECT c.id, c.title, c.created_at,
           (SELECT s.share_slug FROM shared_recipes s
            WHERE s.conversation_id = c.id LIMIT 1) AS share_slug,
           EXISTS (SELECT 1 FROM recipe_favorites f
                   WHERE f.conversation_id = c.id AND f.user_id = $1) AS is_favorited,
           EXISTS (SELECT 1 FROM shared_recipes s
                   WHERE s.conversation_id = c.id) AS is_shared,
           EXISTS (SELECT 1 FROM shared_recipes s
                   WHERE s.conversation_id = c.id
                     AND s.recipe_data = (SELECT m.recipe_data FROM messages m
                                          WHERE m.conversation_id = c.id AND m.recipe_data IS NOT NULL
                                          ORDER BY m.created_at DESC LIMIT 1)) AS shared_up_to_date
         FROM conversations c
         WHERE ${ownerClause('c.user_id')} ORDER BY c.created_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('conversations', 'List failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Favorite / unfavorite one of your own conversations (its recipe).
  router.put('/api/conversations/:id/favorite', async (req, res) => {
    try {
      const convId = parseInt(req.params.id);
      const { rows: conv } = await pool.query(
        `SELECT id FROM conversations WHERE id = $2 AND ${ownerClause('user_id')}`,
        [req.user.id, convId]
      );
      if (!conv.length) return res.status(404).json({ error: 'Conversation not found' });

      await pool.query(
        `INSERT INTO recipe_favorites (user_id, conversation_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
         DO NOTHING`,
        [req.user.id, convId]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'Favorite failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/conversations/:id/favorite', async (req, res) => {
    try {
      const convId = parseInt(req.params.id);
      await pool.query(
        'DELETE FROM recipe_favorites WHERE user_id = $1 AND conversation_id = $2',
        [req.user.id, convId]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'Unfavorite failed', { message: err.message });
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
        `SELECT id, status, created_at FROM pending_replies WHERE conversation_id = $1 AND ${config.isStaging ? 'user_id IN ($2, 0)' : 'user_id = $2'} AND status IN ('processing', 'done') ORDER BY created_at DESC LIMIT 1`,
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
      const { rowCount: deleted } = await pool.query(
        'DELETE FROM conversations WHERE id = $1 AND user_id = $2',
        [convId, req.user.id]
      );
      if (!deleted) return res.json({ ok: true });
      // No FK exists across the private/public boundary — clean up the
      // published snapshot (cascades its ratings/favorites) and any
      // own-conversation favorite explicitly.
      await pool.query(
        'DELETE FROM shared_recipes WHERE conversation_id = $1 AND user_id = $2',
        [convId, req.user.id]
      );
      await pool.query(
        'DELETE FROM recipe_favorites WHERE conversation_id = $1 AND user_id = $2',
        [convId, req.user.id]
      );
      // Same cross-boundary cleanup for the new dual-target tables:
      // conversation-target made-it marks and collection items go with the
      // conversation (shared-target rows cascade via FK; shared-target
      // collection items survive via their snapshot instead).
      await pool.query(
        'DELETE FROM made_it_marks WHERE conversation_id = $1',
        [convId]
      );
      await pool.query(
        'DELETE FROM collection_items WHERE conversation_id = $1',
        [convId]
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
