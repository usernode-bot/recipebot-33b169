const { Router } = require('express');
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { sanitizeTags } = require('../services/tags');
const log = require('../services/logger');

// Aggregate joins shared by the feed and favorites queries.
const RATING_AGG = `
  LEFT JOIN (
    SELECT shared_recipe_id, AVG(rating) AS avg_rating, COUNT(*) AS rating_count
    FROM recipe_ratings GROUP BY shared_recipe_id
  ) agg ON agg.shared_recipe_id = s.id
  LEFT JOIN recipe_ratings my ON my.shared_recipe_id = s.id AND my.user_id = $1`;

// Social/lineage counters selected on every shared-recipe card.
const SOCIAL_COUNTS = `
  (SELECT COUNT(*) FROM made_it_marks mm WHERE mm.shared_recipe_id = s.id)::int AS made_count,
  (SELECT COUNT(*) FROM recipe_comments rc
   WHERE rc.shared_recipe_id = s.id AND rc.deleted_at IS NULL)::int AS comment_count,
  (SELECT COUNT(*) FROM shared_recipes s2 WHERE s2.forked_from_shared_id = s.id)::int AS remix_count`;

// URL-safe random slug for public recipe pages (/r/:slug). 8 random bytes
// → 11 base64url chars; collisions are theoretical but retried anyway.
function newShareSlug() {
  return crypto.randomBytes(8).toString('base64url');
}

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
                   WHERE s.conversation_id = c.id) AS is_shared,
           EXISTS (SELECT 1 FROM shared_recipes s
                   WHERE s.conversation_id = c.id
                     AND s.recipe_data = (SELECT m2.recipe_data FROM messages m2
                                          WHERE m2.conversation_id = c.id AND m2.recipe_data IS NOT NULL
                                          ORDER BY m2.created_at DESC LIMIT 1)) AS shared_up_to_date,
           (SELECT COUNT(*) FROM made_it_marks mm WHERE mm.conversation_id = c.id)::int AS made_count,
           c.forked_from_shared_id, c.forked_from_username
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
  // Each publish records a version row (v1 = first share) with an optional
  // updater note; publishing an unchanged recipe is a no-op.
  router.post('/api/recipes/share', async (req, res) => {
    const convId = parseInt(req.body?.conversationId);
    if (!convId) return res.status(400).json({ error: 'conversationId required' });
    let note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (note.length > 500) note = note.slice(0, 500);

    // Creator-confirmed tags (chips in the publish dialog). When omitted,
    // the tags already on the recipe JSON (AI-proposed) are kept.
    const confirmedTags = req.body?.tags !== undefined ? sanitizeTags(req.body.tags) : null;

    const client = await pool.connect();
    try {
      const { rows: conv } = await client.query(
        `SELECT id, forked_from_shared_id, forked_from_version, forked_from_username
         FROM conversations WHERE id = $2 AND ${ownerClause('user_id')}`,
        [req.user.id, convId]
      );
      if (!conv.length) return res.status(404).json({ error: 'Conversation not found' });

      const { rows: recipeRows } = await client.query(
        `SELECT recipe_data FROM messages
         WHERE conversation_id = $1 AND recipe_data IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [convId]
      );
      if (!recipeRows.length) {
        return res.status(404).json({ error: 'Conversation has no recipe to share' });
      }
      const recipeData = recipeRows[0].recipe_data;
      const tags = confirmedTags !== null ? confirmedTags : sanitizeTags(recipeData.tags);
      recipeData.tags = tags;
      const recipeJson = JSON.stringify(recipeData);

      await client.query('BEGIN');
      const { rows: existing } = await client.query(
        `SELECT id, recipe_data = $3::jsonb AS up_to_date
         FROM shared_recipes WHERE user_id = $1 AND conversation_id = $2
         FOR UPDATE`,
        [req.user.id, convId, recipeJson]
      );
      if (existing.length && existing[0].up_to_date) {
        await client.query('ROLLBACK');
        return res.json({ id: existing[0].id, unchanged: true });
      }

      // share_slug is set on first publish and preserved on republish so
      // public links stay stable; lineage is copied from the conversation.
      const { rows } = await client.query(
        `INSERT INTO shared_recipes
           (user_id, username, conversation_id, recipe_data, tags, share_slug,
            forked_from_shared_id, forked_from_version, forked_from_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, conversation_id)
         DO UPDATE SET recipe_data = EXCLUDED.recipe_data,
                       username = EXCLUDED.username,
                       tags = EXCLUDED.tags,
                       share_slug = COALESCE(shared_recipes.share_slug, EXCLUDED.share_slug),
                       forked_from_shared_id = EXCLUDED.forked_from_shared_id,
                       forked_from_version = EXCLUDED.forked_from_version,
                       forked_from_username = EXCLUDED.forked_from_username,
                       updated_at = NOW()
         RETURNING id, user_id, username, conversation_id, share_slug, tags, created_at, updated_at`,
        [
          req.user.id, req.user.username || 'unknown', convId, recipeJson, tags,
          newShareSlug(),
          conv[0].forked_from_shared_id, conv[0].forked_from_version, conv[0].forked_from_username,
        ]
      );
      const { rows: verRows } = await client.query(
        `INSERT INTO shared_recipe_versions (shared_recipe_id, version, recipe_data, note, user_id, username)
         SELECT $1::int, COALESCE(MAX(version), 0) + 1, $2::jsonb, $3::text, $4::int, $5::text
         FROM shared_recipe_versions WHERE shared_recipe_id = $1
         RETURNING version`,
        [rows[0].id, recipeJson, note || null, req.user.id, req.user.username || 'unknown']
      );
      await client.query('COMMIT');

      log.info('recipes', 'Shared', { sharedId: rows[0].id, conversationId: convId, userId: req.user.id, version: verRows[0].version });
      res.json({ ...rows[0], version: verRows[0].version });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('recipes', 'Share failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // Version history for a shared recipe, newest first.
  router.get('/api/shared-recipes/:id/versions', async (req, res) => {
    const sharedId = parseInt(req.params.id);
    try {
      const { rows } = await pool.query(
        `SELECT version, note, username, created_at, recipe_data
         FROM shared_recipe_versions
         WHERE shared_recipe_id = $1
         ORDER BY version DESC`,
        [sharedId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Recipe not found' });
      res.json(rows);
    } catch (err) {
      log.error('recipes', 'Versions failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Community feed: every shared recipe, newest first. Optional
  // ?tags=a,b filters to recipes carrying ANY of the given tags.
  router.get('/api/shared-recipes', async (req, res) => {
    try {
      const tagFilter = typeof req.query.tags === 'string'
        ? req.query.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12)
        : [];
      const params = [req.user.id];
      let where = '';
      if (tagFilter.length) {
        params.push(tagFilter);
        where = `WHERE s.tags && $${params.length}::text[]`;
      }
      const { rows } = await pool.query(
        `SELECT s.id, s.user_id, s.username, s.conversation_id, s.recipe_data AS data,
                s.created_at, s.updated_at, s.share_slug, s.tags,
                s.forked_from_shared_id, s.forked_from_version, s.forked_from_username,
                COALESCE((SELECT MAX(v.version) FROM shared_recipe_versions v
                          WHERE v.shared_recipe_id = s.id), 1)::int AS current_version,
                COALESCE(agg.avg_rating, 0)::float AS avg_rating,
                COALESCE(agg.rating_count, 0)::int AS rating_count,
                my.rating AS my_rating,
                ${SOCIAL_COUNTS},
                EXISTS (SELECT 1 FROM recipe_favorites f
                        WHERE f.shared_recipe_id = s.id AND f.user_id = $1) AS is_favorited,
                (s.user_id = $1) AS is_mine
         FROM shared_recipes s
         ${RATING_AGG}
         ${where}
         ORDER BY s.created_at DESC`,
        params
      );
      res.json(rows);
    } catch (err) {
      log.error('recipes', 'Feed failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Published descendants of a shared recipe ("12 remixes — see them").
  router.get('/api/shared-recipes/:id/remixes', async (req, res) => {
    const sharedId = parseInt(req.params.id);
    try {
      const { rows } = await pool.query(
        `SELECT s.id, s.username, s.share_slug, s.created_at,
                s.recipe_data->>'title' AS title,
                s.forked_from_version
         FROM shared_recipes s
         WHERE s.forked_from_shared_id = $1
         ORDER BY s.created_at DESC`,
        [sharedId]
      );
      res.json(rows);
    } catch (err) {
      log.error('recipes', 'Remixes failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── "Made it" marks ──────────────────────────────────────────────
  // Dual-target like favorites: a shared recipe (anyone) or one of your
  // own conversations. Multiple marks per user allowed — cooking a thing
  // twice counts twice; cooked-count = COUNT(*).
  router.post('/api/made-it', async (req, res) => {
    const sharedId = parseInt(req.body?.sharedRecipeId) || null;
    const convId = parseInt(req.body?.conversationId) || null;
    let note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (note.length > 500) note = note.slice(0, 500);
    if (!sharedId === !convId) {
      return res.status(400).json({ error: 'Exactly one of sharedRecipeId / conversationId required' });
    }

    try {
      if (sharedId) {
        const { rows } = await pool.query('SELECT id FROM shared_recipes WHERE id = $1', [sharedId]);
        if (!rows.length) return res.status(404).json({ error: 'Recipe not found' });
      } else {
        const { rows } = await pool.query(
          `SELECT id FROM conversations WHERE id = $2 AND ${ownerClause('user_id')}`,
          [req.user.id, convId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Conversation not found' });
      }

      await pool.query(
        `INSERT INTO made_it_marks (user_id, username, shared_recipe_id, conversation_id, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user.id, req.user.username || 'unknown', sharedId, convId, note || null]
      );

      const { rows: agg } = await pool.query(
        sharedId
          ? 'SELECT COUNT(*)::int AS made_count FROM made_it_marks WHERE shared_recipe_id = $1'
          : 'SELECT COUNT(*)::int AS made_count FROM made_it_marks WHERE conversation_id = $1',
        [sharedId || convId]
      );
      res.json({ ok: true, made_count: agg[0].made_count });
    } catch (err) {
      log.error('recipes', 'Made-it failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Made-it gallery for a shared recipe (notes from people who cooked it).
  router.get('/api/shared-recipes/:id/made-it', async (req, res) => {
    const sharedId = parseInt(req.params.id);
    try {
      const { rows } = await pool.query(
        `SELECT username, note, created_at FROM made_it_marks
         WHERE shared_recipe_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [sharedId]
      );
      res.json(rows);
    } catch (err) {
      log.error('recipes', 'Made-it list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Comments on published recipes ────────────────────────────────
  router.get('/api/shared-recipes/:id/comments', async (req, res) => {
    const sharedId = parseInt(req.params.id);
    try {
      const { rows } = await pool.query(
        `SELECT c.id, c.user_id, c.username, c.created_at,
                (c.deleted_at IS NOT NULL) AS deleted,
                CASE WHEN c.deleted_at IS NULL THEN c.body ELSE NULL END AS body,
                (c.user_id = $2) AS is_mine
         FROM recipe_comments c
         WHERE c.shared_recipe_id = $1
         ORDER BY c.created_at ASC`,
        [sharedId, req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('recipes', 'Comments failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/shared-recipes/:id/comments', async (req, res) => {
    const sharedId = parseInt(req.params.id);
    let body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'Comment body required' });
    if (body.length > 1000) body = body.slice(0, 1000);

    try {
      const { rows: shared } = await pool.query(
        'SELECT id FROM shared_recipes WHERE id = $1', [sharedId]);
      if (!shared.length) return res.status(404).json({ error: 'Recipe not found' });

      const { rows } = await pool.query(
        `INSERT INTO recipe_comments (shared_recipe_id, user_id, username, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, username, body, created_at`,
        [sharedId, req.user.id, req.user.username || 'unknown', body]
      );
      res.json({ ...rows[0], deleted: false, is_mine: true });
    } catch (err) {
      log.error('recipes', 'Comment failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Soft-delete a comment: allowed for the comment author or the owner of
  // the recipe it sits on.
  router.delete('/api/comments/:id', async (req, res) => {
    const commentId = parseInt(req.params.id);
    try {
      const { rowCount } = await pool.query(
        `UPDATE recipe_comments c SET deleted_at = NOW()
         WHERE c.id = $1 AND c.deleted_at IS NULL
           AND (c.user_id = $2 OR EXISTS (
             SELECT 1 FROM shared_recipes s
             WHERE s.id = c.shared_recipe_id AND s.user_id = $2))`,
        [commentId, req.user.id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Comment not found' });
      res.json({ ok: true });
    } catch (err) {
      log.error('recipes', 'Comment delete failed', { message: err.message });
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
                s.created_at, s.share_slug, s.tags,
                s.forked_from_shared_id, s.forked_from_version, s.forked_from_username,
                COALESCE((SELECT MAX(v.version) FROM shared_recipe_versions v
                          WHERE v.shared_recipe_id = s.id), 1)::int AS current_version,
                COALESCE(agg.avg_rating, 0)::float AS avg_rating,
                COALESCE(agg.rating_count, 0)::int AS rating_count,
                my.rating AS my_rating,
                ${SOCIAL_COUNTS},
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
