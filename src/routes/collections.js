const { Router } = require('express');
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// Collections — ONE concept (issue #34). There is no separate "group
// cookbook" object: a collection is a named shelf of recipes with two
// orthogonal properties.
//
//   visibility  'private' (unlisted) | 'public' (listed in the community
//               feed). One-way — see PATCH below (issue #33).
//   membership  collection_members + collection_invites, available on ANY
//               collection. The platform has no groups system, so
//               membership and invite links are app-owned here.
//
// Access rules (enforced per-query):
//   view    → owner, any member, or anyone when visibility = 'public'
//   curate  → owner or any member (add/remove recipes)
//   admin   → owner only (rename, delete, invite, make public)
//   comment → anyone who can view
function collectionRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Staging demo rows are owned by sentinel user 0 (see migrate.js); the
  // demo-inclusive id set makes them behave as the tester's own.
  const idSet = (userId) => (config.isStaging ? [userId, 0] : [userId]);

  async function loadCollection(id) {
    const { rows } = await pool.query('SELECT * FROM collections WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async function isMember(collectionId, userId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM collection_members WHERE collection_id = $1 AND user_id = ANY($2::int[])`,
      [collectionId, idSet(userId)]
    );
    return rows.length > 0;
  }

  function isOwner(collection, userId) {
    return idSet(userId).includes(collection.user_id);
  }

  async function canView(collection, userId) {
    if (collection.visibility === 'public') return true;
    if (isOwner(collection, userId)) return true;
    return isMember(collection.id, userId);
  }

  // Adding/removing recipes: the owner and every member.
  async function canCurate(collection, userId) {
    if (isOwner(collection, userId)) return true;
    return isMember(collection.id, userId);
  }

  // is_shared drives the "Shared collection · N members" label: other people
  // are in it, or an invite link is out there waiting to be used.
  const COUNTS = `
    (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id)::int AS item_count,
    (SELECT COUNT(*) FROM collection_members m WHERE m.collection_id = c.id)::int AS member_count,
    (SELECT COUNT(*) FROM collection_comments cc
     WHERE cc.collection_id = c.id AND cc.deleted_at IS NULL)::int AS comment_count,
    ((SELECT COUNT(*) FROM collection_members m WHERE m.collection_id = c.id) > 1
     OR EXISTS (SELECT 1 FROM collection_invites inv
                WHERE inv.collection_id = c.id AND inv.revoked_at IS NULL)) AS is_shared`;

  // The requester's collections: owned + collections they're a member of.
  router.get('/api/collections', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.id, c.user_id, c.username, c.name, c.description, c.visibility,
                c.created_at, ${COUNTS},
                (c.user_id = ANY($1::int[])) AS is_owner
         FROM collections c
         WHERE c.user_id = ANY($1::int[])
            OR EXISTS (SELECT 1 FROM collection_members m
                       WHERE m.collection_id = c.id AND m.user_id = ANY($1::int[]))
         ORDER BY c.created_at DESC`,
        [idSet(req.user.id)]
      );
      res.json(rows);
    } catch (err) {
      log.error('collections', 'List failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Public collections for the community feed rail.
  router.get('/api/collections/public', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.id, c.user_id, c.username, c.name, c.description, c.created_at,
                ${COUNTS},
                (c.user_id = $1) AS is_mine
         FROM collections c
         WHERE c.visibility = 'public'
         ORDER BY c.created_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('collections', 'Public list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create a collection. Always starts private and unshared — publishing and
  // inviting are later, deliberate actions on the collection itself.
  router.post('/api/collections', async (req, res) => {
    let name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (name.length > 120) name = name.slice(0, 120);
    let description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    if (description.length > 500) description = description.slice(0, 500);

    try {
      const { rows } = await pool.query(
        `INSERT INTO collections (user_id, username, name, description, visibility)
         VALUES ($1, $2, $3, $4, 'private')
         RETURNING id, user_id, username, name, description, visibility, created_at`,
        [req.user.id, req.user.username || 'unknown', name, description || null]
      );
      const collection = rows[0];
      log.info('collections', 'Created', { id: collection.id, userId: req.user.id });
      res.json({
        ...collection,
        is_owner: true,
        is_shared: false,
        item_count: 0,
        member_count: 0,
        comment_count: 0,
      });
    } catch (err) {
      log.error('collections', 'Create failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Mint (or reuse) the invite link for a collection — owner only. The owner
  // is upserted as a member at the same time so member_count is coherent
  // once a collection starts being shared.
  router.post('/api/collections/:id/invite', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad id' });
    const client = await pool.connect();
    try {
      const { rows: colls } = await client.query(
        'SELECT * FROM collections WHERE id = $1', [id]);
      const collection = colls[0];
      if (!collection || !isOwner(collection, req.user.id)) {
        return res.status(404).json({ error: 'Collection not found' });
      }

      await client.query('BEGIN');
      await client.query(
        `INSERT INTO collection_members (collection_id, user_id, username, role)
         VALUES ($1, $2, $3, 'owner')
         ON CONFLICT (collection_id, user_id) DO NOTHING`,
        [id, collection.user_id, collection.username || 'unknown']
      );
      const { rows: existing } = await client.query(
        `SELECT token FROM collection_invites
         WHERE collection_id = $1 AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [id]
      );
      let token = existing.length ? existing[0].token : null;
      if (!token) {
        token = crypto.randomBytes(12).toString('base64url');
        await client.query(
          `INSERT INTO collection_invites (token, collection_id, created_by)
           VALUES ($1, $2, $3)`,
          [token, id, req.user.id]
        );
      }
      await client.query('COMMIT');
      log.info('collections', 'Invite issued', { id, userId: req.user.id });
      res.json({ invite_token: token });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('collections', 'Invite failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // Invite-token preview (pre-join screen): collection name + counts.
  router.get('/api/collections/invite/:token', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.id, c.name, c.description, c.username, ${COUNTS}
         FROM collection_invites inv
         JOIN collections c ON c.id = inv.collection_id
         WHERE inv.token = $1 AND inv.revoked_at IS NULL`,
        [req.params.token]
      );
      if (!rows.length) return res.status(404).json({ error: 'Invite not found' });
      const already = await isMember(rows[0].id, req.user.id);
      res.json({ ...rows[0], already_member: already });
    } catch (err) {
      log.error('collections', 'Invite lookup failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Join a collection via invite link. Deliberately NOT gated on visibility:
  // membership is orthogonal to listing, and pre-#34 invites were minted for
  // rows the migration folded into 'private'.
  router.post('/api/collections/join/:token', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.id FROM collection_invites inv
         JOIN collections c ON c.id = inv.collection_id
         WHERE inv.token = $1 AND inv.revoked_at IS NULL`,
        [req.params.token]
      );
      if (!rows.length) return res.status(404).json({ error: 'Invite not found' });
      await pool.query(
        `INSERT INTO collection_members (collection_id, user_id, username, role)
         VALUES ($1, $2, $3, 'member')
         ON CONFLICT (collection_id, user_id) DO NOTHING`,
        [rows[0].id, req.user.id, req.user.username || 'unknown']
      );
      log.info('collections', 'Joined via invite', { collectionId: rows[0].id, userId: req.user.id });
      res.json({ ok: true, collection_id: rows[0].id });
    } catch (err) {
      log.error('collections', 'Join failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Collection detail: items (live shared data when available, snapshot
  // fallback otherwise), members + invite link for owner/members, comments.
  router.get('/api/collections/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      const collection = await loadCollection(id);
      if (!collection || !(await canView(collection, req.user.id))) {
        return res.status(404).json({ error: 'Collection not found' });
      }

      const { rows: items } = await pool.query(
        `SELECT i.id, i.shared_recipe_id, i.conversation_id, i.added_by_user_id,
                i.added_by_username, i.created_at, i.recipe_snapshot, i.snapshot_title,
                s.recipe_data AS live_data, s.username AS live_username, s.share_slug
         FROM collection_items i
         LEFT JOIN shared_recipes s ON s.id = i.shared_recipe_id
         WHERE i.collection_id = $1
         ORDER BY i.created_at DESC`,
        [id]
      );

      const member = await isMember(collection.id, req.user.id);
      const owner = isOwner(collection, req.user.id);

      let members = [];
      let inviteToken = null;
      if (member || owner) {
        ({ rows: members } = await pool.query(
          `SELECT user_id, username, role, created_at FROM collection_members
           WHERE collection_id = $1 ORDER BY created_at ASC`,
          [id]
        ));
        const { rows: inv } = await pool.query(
          `SELECT token FROM collection_invites
           WHERE collection_id = $1 AND revoked_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [id]
        );
        inviteToken = inv.length ? inv[0].token : null;
      }

      const { rows: comments } = await pool.query(
        `SELECT cc.id, cc.user_id, cc.username, cc.created_at,
                (cc.deleted_at IS NOT NULL) AS deleted,
                CASE WHEN cc.deleted_at IS NULL THEN cc.body ELSE NULL END AS body,
                (cc.user_id = $2) AS is_mine
         FROM collection_comments cc
         WHERE cc.collection_id = $1
         ORDER BY cc.created_at ASC`,
        [id, req.user.id]
      );

      res.json({
        ...collection,
        is_owner: owner,
        is_member: member || owner,
        is_shared: members.length > 1 || !!inviteToken,
        invite_token: inviteToken,
        members,
        comments,
        comment_count: comments.filter((c) => !c.deleted).length,
        items: items.map((i) => ({
          id: i.id,
          shared_recipe_id: i.shared_recipe_id,
          conversation_id: i.conversation_id,
          added_by_username: i.added_by_username,
          added_by_user_id: i.added_by_user_id,
          created_at: i.created_at,
          share_slug: i.share_slug || null,
          // Live published data wins; deleted sources fall back to the
          // snapshot taken when the recipe was saved ("you have your copy").
          data: i.live_data || i.recipe_snapshot,
          username: i.live_username || i.added_by_username,
          snapshot_only: !i.live_data && !i.conversation_id,
        })),
      });
    } catch (err) {
      log.error('collections', 'Detail failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Rename / edit / make public — owner only.
  //
  // Publicity is ONE-WAY (issue #33): a collection that is public stays
  // public, so anyone who found it keeps it. Enforced here and not just in
  // the UI — a stale client must not be able to un-publish. The escape hatch
  // is DELETE.
  router.patch('/api/collections/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const collection = await loadCollection(id);
      if (!collection || !isOwner(collection, req.user.id)) {
        return res.status(404).json({ error: 'Collection not found' });
      }
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : null;
      const description = typeof req.body?.description === 'string'
        ? req.body.description.trim().slice(0, 500) : null;

      let visibility = null;
      if (req.body?.visibility !== undefined) {
        if (req.body.visibility === 'public') {
          visibility = 'public';
        } else if (req.body.visibility !== collection.visibility) {
          return res.status(400).json({ error: 'Collections stay public once public' });
        }
      }

      await pool.query(
        `UPDATE collections SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           visibility = COALESCE($4, visibility),
           updated_at = NOW()
         WHERE id = $1`,
        [id, name || null, description, visibility]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('collections', 'Update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/collections/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const collection = await loadCollection(id);
      if (!collection || !isOwner(collection, req.user.id)) {
        return res.status(404).json({ error: 'Collection not found' });
      }
      await pool.query('DELETE FROM collections WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      log.error('collections', 'Delete failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Add a recipe: either a shared recipe (anyone's) or one of your own
  // conversations. A snapshot of the recipe JSON is ALWAYS stored so the
  // save survives source deletion.
  router.post('/api/collections/:id/items', async (req, res) => {
    const id = parseInt(req.params.id);
    const sharedId = parseInt(req.body?.sharedRecipeId) || null;
    const convId = parseInt(req.body?.conversationId) || null;
    if (!sharedId === !convId) {
      return res.status(400).json({ error: 'Exactly one of sharedRecipeId / conversationId required' });
    }

    try {
      const collection = await loadCollection(id);
      if (!collection || !(await canCurate(collection, req.user.id))) {
        return res.status(404).json({ error: 'Collection not found' });
      }

      let snapshot = null;
      if (sharedId) {
        const { rows } = await pool.query(
          'SELECT recipe_data FROM shared_recipes WHERE id = $1', [sharedId]);
        if (!rows.length) return res.status(404).json({ error: 'Recipe not found' });
        snapshot = rows[0].recipe_data;
      } else {
        const ownerIds = idSet(req.user.id);
        const { rows: conv } = await pool.query(
          'SELECT id FROM conversations WHERE id = $1 AND user_id = ANY($2::int[])',
          [convId, ownerIds]
        );
        if (!conv.length) return res.status(404).json({ error: 'Conversation not found' });
        const { rows } = await pool.query(
          `SELECT recipe_data FROM messages
           WHERE conversation_id = $1 AND recipe_data IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
          [convId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Conversation has no recipe yet' });
        snapshot = rows[0].recipe_data;
      }

      const conflictClause = sharedId
        ? 'ON CONFLICT (collection_id, shared_recipe_id) WHERE shared_recipe_id IS NOT NULL DO NOTHING'
        : 'ON CONFLICT (collection_id, conversation_id) WHERE conversation_id IS NOT NULL DO NOTHING';
      const { rows: inserted } = await pool.query(
        `INSERT INTO collection_items
           (collection_id, added_by_user_id, added_by_username, shared_recipe_id,
            conversation_id, recipe_snapshot, snapshot_title)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ${conflictClause}
         RETURNING id`,
        [id, req.user.id, req.user.username || 'unknown', sharedId, convId,
         JSON.stringify(snapshot), snapshot.title || null]
      );
      res.json({ ok: true, added: inserted.length > 0 });
    } catch (err) {
      log.error('collections', 'Add item failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Remove an item — the person who added it or the collection owner.
  router.delete('/api/collections/:id/items/:itemId', async (req, res) => {
    const id = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);
    try {
      const collection = await loadCollection(id);
      if (!collection) return res.status(404).json({ error: 'Collection not found' });
      const owner = isOwner(collection, req.user.id);
      const { rowCount } = await pool.query(
        owner
          ? 'DELETE FROM collection_items WHERE id = $1 AND collection_id = $2'
          : 'DELETE FROM collection_items WHERE id = $1 AND collection_id = $2 AND added_by_user_id = $3',
        owner ? [itemId, id] : [itemId, id, req.user.id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Item not found' });
      res.json({ ok: true });
    } catch (err) {
      log.error('collections', 'Remove item failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Leave a collection (self) or remove a member (owner). The owner can't
  // leave their own collection — delete it instead.
  router.delete('/api/collections/:id/members/:userId', async (req, res) => {
    const id = parseInt(req.params.id);
    const targetId = parseInt(req.params.userId);
    try {
      const collection = await loadCollection(id);
      if (!collection) return res.status(404).json({ error: 'Collection not found' });
      const owner = isOwner(collection, req.user.id);
      if (targetId === collection.user_id) {
        return res.status(400).json({ error: 'The owner cannot leave their own collection' });
      }
      if (!owner && targetId !== req.user.id) {
        return res.status(403).json({ error: 'Only the owner can remove other members' });
      }
      await pool.query(
        'DELETE FROM collection_members WHERE collection_id = $1 AND user_id = $2',
        [id, targetId]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('collections', 'Remove member failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Comments on collections (issue #35) ──────────────────────────
  // Same row shape as the recipe thread (recipes.js) so the client renders
  // both with one widget. Anyone who can VIEW the collection can comment.

  router.get('/api/collections/:id/comments', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      const collection = await loadCollection(id);
      if (!collection || !(await canView(collection, req.user.id))) {
        return res.status(404).json({ error: 'Collection not found' });
      }
      const { rows } = await pool.query(
        `SELECT cc.id, cc.user_id, cc.username, cc.created_at,
                (cc.deleted_at IS NOT NULL) AS deleted,
                CASE WHEN cc.deleted_at IS NULL THEN cc.body ELSE NULL END AS body,
                (cc.user_id = $2) AS is_mine
         FROM collection_comments cc
         WHERE cc.collection_id = $1
         ORDER BY cc.created_at ASC`,
        [id, req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('collections', 'Comments failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/collections/:id/comments', async (req, res) => {
    const id = parseInt(req.params.id);
    let body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'Comment body required' });
    if (body.length > 1000) body = body.slice(0, 1000);

    try {
      const collection = await loadCollection(id);
      if (!collection || !(await canView(collection, req.user.id))) {
        return res.status(404).json({ error: 'Collection not found' });
      }
      const { rows } = await pool.query(
        `INSERT INTO collection_comments (collection_id, user_id, username, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, username, body, created_at`,
        [id, req.user.id, req.user.username || 'unknown', body]
      );
      res.json({ ...rows[0], deleted: false, is_mine: true });
    } catch (err) {
      log.error('collections', 'Comment failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Soft-delete a collection comment: the author or the collection's owner.
  // Distinct path from /api/comments/:id, which is the recipe thread.
  router.delete('/api/collection-comments/:id', async (req, res) => {
    const commentId = parseInt(req.params.id);
    try {
      const { rowCount } = await pool.query(
        `UPDATE collection_comments cc SET deleted_at = NOW()
         WHERE cc.id = $1 AND cc.deleted_at IS NULL
           AND (cc.user_id = $2 OR EXISTS (
             SELECT 1 FROM collections c
             WHERE c.id = cc.collection_id AND c.user_id = ANY($3::int[])))`,
        [commentId, req.user.id, idSet(req.user.id)]
      );
      if (!rowCount) return res.status(404).json({ error: 'Comment not found' });
      res.json({ ok: true });
    } catch (err) {
      log.error('collections', 'Comment delete failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { collectionRoutes };
