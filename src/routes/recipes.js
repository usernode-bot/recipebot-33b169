const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// Aggregate joins shared by the feed and favorites queries.
const RATING_AGG = `
  LEFT JOIN (
    SELECT shared_recipe_id, AVG(rating) AS avg_rating, COUNT(*) AS rating_count
    FROM recipe_ratings GROUP BY shared_recipe_id
  ) agg ON agg.shared_recipe_id = s.id
  LEFT JOIN recipe_ratings my ON my.shared_recipe_id = s.id AND my.user_id = $1`;

function recipeRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // In staging, owner-scoped endpoints also cover the seeded demo rows
  // (user_id = 0, see src/db/migrate.js) so testers can exercise the flows.
  const ownerClause = (col) =>
    config.isStaging ? `${col} IN ($1, 0)` : `${col} = $1`;

  // The requester's created recipes (latest recipe per conversation).
  router.get('/api/recipes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (c.id)
           m.id, m.recipe_data AS data, m.conversation_id, m.created_at,
           c.title AS conversation_title,
           EXISTS (SELECT 1 FROM recipe_favorites f
                   WHERE f.conversation_id = c.id AND f.user_id = $1) AS is_favorited,
           EXISTS (SELECT 1 FROM shared_recipes s
                   WHERE s.conversation_id = c.id) AS is_shared
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

  // Publish (or update) a snapshot of the conversation's latest recipe.
  router.post('/api/recipes/share', async (req, res) => {
    const convId = parseInt(req.body?.conversationId);
    if (!convId) return res.status(400).json({ error: 'conversationId required' });

    try {
      const { rows: conv } = await pool.query(
        `SELECT id FROM conversations WHERE id = $2 AND ${ownerClause('user_id')}`,
        [req.user.id, convId]
      );
      if (!conv.length) return res.status(404).json({ error: 'Conversation not found' });

      const { rows: recipeRows } = await pool.query(
        `SELECT recipe_data FROM messages
         WHERE conversation_id = $1 AND recipe_data IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [convId]
      );
      if (!recipeRows.length) {
        return res.status(404).json({ error: 'Conversation has no recipe to share' });
      }

      const { rows } = await pool.query(
        `INSERT INTO shared_recipes (user_id, username, conversation_id, recipe_data)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, conversation_id)
         DO UPDATE SET recipe_data = EXCLUDED.recipe_data,
                       username = EXCLUDED.username,
                       updated_at = NOW()
         RETURNING id, user_id, username, conversation_id, created_at, updated_at`,
        [req.user.id, req.user.username || 'unknown', convId, JSON.stringify(recipeRows[0].recipe_data)]
      );
      log.info('recipes', 'Shared', { sharedId: rows[0].id, conversationId: convId, userId: req.user.id });
      res.json(rows[0]);
    } catch (err) {
      log.error('recipes', 'Share failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Community feed: every shared recipe, newest first.
  router.get('/api/shared-recipes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT s.id, s.user_id, s.username, s.conversation_id, s.recipe_data AS data,
                s.created_at, s.updated_at,
                COALESCE(agg.avg_rating, 0)::float AS avg_rating,
                COALESCE(agg.rating_count, 0)::int AS rating_count,
                my.rating AS my_rating,
                EXISTS (SELECT 1 FROM recipe_favorites f
                        WHERE f.shared_recipe_id = s.id AND f.user_id = $1) AS is_favorited,
                (s.user_id = $1) AS is_mine
         FROM shared_recipes s
         ${RATING_AGG}
         ORDER BY s.created_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('recipes', 'Feed failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Rate a shared recipe (1-5, upsert). Rating your own is rejected.
  router.put('/api/shared-recipes/:id/rating', async (req, res) => {
    const sharedId = parseInt(req.params.id);
    const rating = parseInt(req.body?.rating);
    if (!(rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: 'rating must be 1-5' });
    }

    try {
      const { rows: shared } = await pool.query(
        'SELECT user_id FROM shared_recipes WHERE id = $1',
        [sharedId]
      );
      if (!shared.length) return res.status(404).json({ error: 'Recipe not found' });
      if (shared[0].user_id === req.user.id) {
        return res.status(400).json({ error: 'You cannot rate your own recipe' });
      }

      await pool.query(
        `INSERT INTO recipe_ratings (shared_recipe_id, user_id, rating)
         VALUES ($1, $2, $3)
         ON CONFLICT (shared_recipe_id, user_id) DO UPDATE SET rating = EXCLUDED.rating`,
        [sharedId, req.user.id, rating]
      );

      const { rows: agg } = await pool.query(
        `SELECT COALESCE(AVG(rating), 0)::float AS avg_rating, COUNT(*)::int AS rating_count
         FROM recipe_ratings WHERE shared_recipe_id = $1`,
        [sharedId]
      );
      res.json({ ok: true, my_rating: rating, ...agg[0] });
    } catch (err) {
      log.error('recipes', 'Rate failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Favorite / unfavorite a shared recipe.
  router.put('/api/shared-recipes/:id/favorite', async (req, res) => {
    const sharedId = parseInt(req.params.id);
    try {
      const { rows: shared } = await pool.query(
        'SELECT id FROM shared_recipes WHERE id = $1',
        [sharedId]
      );
      if (!shared.length) return res.status(404).json({ error: 'Recipe not found' });

      await pool.query(
        `INSERT INTO recipe_favorites (user_id, shared_recipe_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, shared_recipe_id) WHERE shared_recipe_id IS NOT NULL
         DO NOTHING`,
        [req.user.id, sharedId]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('recipes', 'Favorite failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/shared-recipes/:id/favorite', async (req, res) => {
    const sharedId = parseInt(req.params.id);
    try {
      await pool.query(
        'DELETE FROM recipe_favorites WHERE user_id = $1 AND shared_recipe_id = $2',
        [req.user.id, sharedId]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('recipes', 'Unfavorite failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The requester's favorited shared recipes (homepage favorites section).
  router.get('/api/favorites', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT s.id, s.user_id, s.username, s.conversation_id, s.recipe_data AS data,
                s.created_at,
                COALESCE(agg.avg_rating, 0)::float AS avg_rating,
                COALESCE(agg.rating_count, 0)::int AS rating_count,
                my.rating AS my_rating,
                TRUE AS is_favorited,
                (s.user_id = $1) AS is_mine
         FROM recipe_favorites f
         JOIN shared_recipes s ON s.id = f.shared_recipe_id
         ${RATING_AGG}
         WHERE f.user_id = $1 AND f.shared_recipe_id IS NOT NULL
         ORDER BY f.created_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('recipes', 'Favorites list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { recipeRoutes };
