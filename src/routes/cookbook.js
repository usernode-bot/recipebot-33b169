const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// Aggregate joins shared by the feed, favorites and cookbook queries.
// Kept in step with the copy in src/routes/recipes.js (same alias shape:
// `s` is the shared recipe, `agg`/`my` the rating join).
const RATING_AGG = `
  LEFT JOIN (
    SELECT shared_recipe_id, AVG(rating) AS avg_rating, COUNT(*) AS rating_count
    FROM recipe_ratings GROUP BY shared_recipe_id
  ) agg ON agg.shared_recipe_id = s.id
  LEFT JOIN recipe_ratings my ON my.shared_recipe_id = s.id AND my.user_id = $1`;

// Same per-card counters the community feed selects (shared_recipes cards).
const SOCIAL_COUNTS = `
  (SELECT COUNT(*) FROM made_it_marks mm WHERE mm.shared_recipe_id = s.id)::int AS made_count,
  (SELECT COUNT(*) FROM recipe_comments rc
   WHERE rc.shared_recipe_id = s.id AND rc.deleted_at IS NULL)::int AS comment_count,
  (SELECT COUNT(*) FROM shared_recipes s2 WHERE s2.forked_from_shared_id = s.id)::int AS remix_count`;

// ── The personal Cookbook (issue: "Made it / Forked" tab) ─────────────
//
// One endpoint for everything the current user cooked or forked. Three
// selectors feed the same row shape:
//
//   cooked   — made_it_marks rows the user made (multi-target: a shared
//              recipe of anyone's, or one of their own conversations)
//   favorited — shared recipes they hearted (homepage favorites already
//              covers this section on the box, so it is NOT duplicated here;
//              see the endpoints below for the exact split)
//   forked   — their conversations with fork lineage (from forking another
//              user's shared recipe), joined to that source's published
//              snapshot so lineage credit renders
//
// Rows carry `via` ('made_shared' | 'made_own' | 'forked') so the client can
// label the kicker honestly, and `made_at` / `forked_at` so the list can
// sort by "when you cooked it" instead of publication date. A recipe that
// appears under more than one selector is deduplicated client-side; the
// server returns one row per source event, newest event first.
function cookbookRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // In staging, owner-scoped selectors also cover the seeded demo rows
  // (user_id = 0, see src/db/migrate.js) so testers can exercise the flows.
  const ownerClause = (col) =>
    config.isStaging ? `${col} IN ($1, 0)` : `${col} = $1`;

  // Same pattern for mark ownership: made_it_marks rows seeded for the
  // demo user (0) must be visible to every staging tester. In production
  // this is just the signed-in user.
  const markOwnerClause = (col) =>
    config.isStaging ? `${col} IN ($1, 0)` : `${col} = $1`;

  // GET /api/cookbook — the three-part list. Kept to one round trip: the
  // homepage already fans out over six fetches per refresh.
  router.get('/api/cookbook', async (req, res) => {
    try {
      // 1. Shared recipes the user marked "Made it". A recipe cooked twice
      //    shows once with its latest cook time (MAX, not the newest mark's
      //    note — the note gallery stays on the recipe page).
      const { rows: cookedShared } = await pool.query(
        `SELECT s.id, s.user_id, s.username, s.conversation_id,
                s.recipe_data AS data, s.created_at, s.updated_at, s.share_slug,
                s.tags, s.forked_from_shared_id, s.forked_from_version,
                s.forked_from_username,
                COALESCE((SELECT MAX(v.version) FROM shared_recipe_versions v
                          WHERE v.shared_recipe_id = s.id), 1)::int AS current_version,
                COALESCE(agg.avg_rating, 0)::float AS avg_rating,
                COALESCE(agg.rating_count, 0)::int AS rating_count,
                my.rating AS my_rating,
                ${SOCIAL_COUNTS},
                EXISTS (SELECT 1 FROM recipe_favorites f
                        WHERE f.shared_recipe_id = s.id AND f.user_id = $1) AS is_favorited,
                (s.user_id = $1) AS is_mine,
                'made_shared'::text AS via,
                MAX(mm.created_at) AS made_at,
                (SELECT note FROM made_it_marks m2
                 WHERE m2.shared_recipe_id = s.id AND m2.user_id = $1
                 ORDER BY m2.created_at DESC LIMIT 1) AS my_note
         FROM made_it_marks mm
         JOIN shared_recipes s ON s.id = mm.shared_recipe_id
         ${RATING_AGG}
         WHERE ${markOwnerClause('mm.user_id')}
         GROUP BY s.id, agg.avg_rating, agg.rating_count, my.rating
         ORDER BY MAX(mm.created_at) DESC, s.id DESC`,
        [req.user.id]
      );

      // 2. Own conversations the user marked "Made it" — includes the demo
      //    rows in staging via ownerClause, mirroring /api/recipes.
      const { rows: cookedOwn } = await pool.query(
        `SELECT * FROM (
         SELECT DISTINCT ON (c.id)
           m.id, m.recipe_data AS data, m.conversation_id, m.created_at,
           c.title AS conversation_title,
           EXISTS (SELECT 1 FROM recipe_favorites f
                   WHERE f.conversation_id = c.id AND f.user_id = $1) AS is_favorited,
           EXISTS (SELECT 1 FROM shared_recipes s
                   WHERE s.conversation_id = c.id) AS is_shared,
           (SELECT COUNT(*) FROM made_it_marks mm WHERE mm.conversation_id = c.id)::int AS made_count,
           c.forked_from_shared_id, c.forked_from_version, c.forked_from_username,
           'made_own'::text AS via,
           MAX(mm.created_at) OVER (PARTITION BY c.id) AS made_at
         FROM made_it_marks mm
         JOIN conversations c ON c.id = mm.conversation_id
         JOIN messages m ON m.conversation_id = c.id AND m.recipe_data IS NOT NULL
         WHERE ${markOwnerClause('mm.user_id')} AND ${ownerClause('c.user_id')}
         ORDER BY c.id, m.created_at DESC
         ) r ORDER BY r.made_at DESC, r.conversation_id DESC`,
        [req.user.id]
      );

      // 3. Recipes they forked: conversations with fork lineage, joined to
      //    the published snapshot they forked from (may be deleted — the
      //    LEFT JOIN then yields NULLs and the client falls back to the
      //    bare lineage credit, same as the box's remix line).
      const { rows: forked } = await pool.query(
        `SELECT s.id, s.user_id AS source_user_id, s.username AS source_username,
                s.recipe_data AS data, s.created_at AS source_created_at,
                s.share_slug, s.tags,
                s.forked_from_shared_id, s.forked_from_version,
                s.forked_from_username,
                COALESCE((SELECT MAX(v.version) FROM shared_recipe_versions v
                          WHERE v.shared_recipe_id = s.id), 1)::int AS current_version,
                COALESCE(agg.avg_rating, 0)::float AS avg_rating,
                COALESCE(agg.rating_count, 0)::int AS rating_count,
                my.rating AS my_rating,
                ${SOCIAL_COUNTS},
                (s.user_id = $1) AS is_mine,
                'forked'::text AS via,
                c.id AS conversation_id,
                c.created_at AS forked_at,
                m.recipe_data AS own_data,
                m.created_at AS own_recipe_at
         FROM conversations c
         JOIN messages m ON m.conversation_id = c.id AND m.recipe_data IS NOT NULL
           AND m.created_at = (SELECT MAX(m2.created_at) FROM messages m2
                               WHERE m2.conversation_id = c.id AND m2.recipe_data IS NOT NULL)
         JOIN shared_recipes s ON s.id = c.forked_from_shared_id
         ${RATING_AGG}
         WHERE ${ownerClause('c.user_id')}
           AND c.forked_from_shared_id IS NOT NULL
         ORDER BY c.created_at DESC`,
        [req.user.id]
      );

      res.json({ cookedShared, cookedOwn, forked });
    } catch (err) {
      log.error('cookbook', 'List failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Unmark every "made it" mark the current user has on one target. Multiple
  // marks are the point of the table (you can cook a thing twice) — this is
  // the cookbook's way to take a recipe back out, so it removes ALL of the
  // user's marks on the target, not just one.
  router.delete('/api/made-it', async (req, res) => {
    const sharedId = parseInt(req.query.sharedRecipeId) || null;
    const convId = parseInt(req.query.conversationId) || null;
    if (!sharedId === !convId) {
      return res.status(400).json({ error: 'Exactly one of sharedRecipeId / conversationId required' });
    }
    try {
      await pool.query(
        sharedId
          ? 'DELETE FROM made_it_marks WHERE user_id = $1 AND shared_recipe_id = $2'
          : 'DELETE FROM made_it_marks WHERE user_id = $1 AND conversation_id = $2',
        [req.user.id, sharedId || convId]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('cookbook', 'Unmake failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { cookbookRoutes };
