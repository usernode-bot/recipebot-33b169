const { Router } = require('express');
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// Collections and group cookbooks. A group cookbook is a collection with
// visibility 'group' plus rows in collection_members; the platform has no
// groups system, so membership + invite links are app-owned here.
//
// Access rules (enforced per-query):
//   private → owner only
//   group   → members only (owner is always a member)
//   public  → any authenticated user can view; only the owner curates
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
    if (collection.visibility === 'group') return isMember(collection.id, userId);
    return false;
  }

  // Owner for private/public collections; any member for group cookbooks.
  async function canCurate(collection, userId) {
    if (isOwner(collection, userId)) return true;
    if (collection.visibility === 'group') return isMember(collection.id, userId);
    return false;
  }

  const COUNTS = `
    (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id)::int AS item_count,
    (SELECT COUNT(*) FROM collection_members m WHERE m.collection_id = c.id)::int AS member_count`;

  // The requester's collections: owned + group cookbooks they belong to.
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

  // Create a collection; { group: true } makes it a group cookbook with the
  // creator as owner-member and an invite token ready to share.
  router.post('/api/collections', async (req, res) => {
    let name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (name.length > 120) name = name.slice(0, 120);
    let description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    if (description.length > 500) description = description.slice(0, 500);
    const isGroup = !!req.body?.group;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO collections (user_id, username, name, description, visibility)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, username, name, description, visibility, created_at`,
        [req.user.id, req.user.username || 'unknown', name, description || null,
         isGroup ? 'group' : 'private']
      );
      const collection = rows[0];
      let inviteToken = null;
      if (isGroup) {
        await client.query(
          `INSERT INTO collection_members (collection_id, user_id, username, role)
           VALUES ($1, $2, $3, 'owner')`,
          [collection.id, req.user.id, req.user.username || 'unknown']
        );
        inviteToken = crypto.randomBytes(12).toString('base64url');
        await client.query(
          `INSERT INTO collection_invites (token, collection_id, created_by)
           VALUES ($1, $2, $3)`,
          [inviteToken, collection.id, req.user.id]
        );
      }
      await client.query('COMMIT');
      log.info('collections', 'Created', { id: collection.id, group: isGroup, userId: req.user.id });
      res.json({ ...collection, invite_token: inviteToken, is_owner: true, item_count: 0, member_count: isGroup ? 1 : 0 });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('collections', 'Create failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // Invite-token preview (pre-join screen): cookbook name + counts.
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

  // Join a group cookbook via invite link.
  router.post('/api/collections/join/:token', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.id FROM collection_invites inv
         JOIN collections c ON c.id = inv.collection_id
         WHERE inv.token = $1 AND inv.revoked_at IS NULL AND c.visibility = 'group'`,
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
  // fallback otherwise), members + invite link for group cookbooks.
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

      const member = collection.visibility === 'group'
        ? await isMember(collection.id, req.user.id) : false;
      const owner = isOwner(collection, req.user.id);

      let members = [];
      let inviteToken = null;
      if (collection.visibility === 'group' && (member || owner)) {
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

      res.json({
        ...collection,
        is_owner: owner,
        is_member: member || owner,
        invite_token: inviteToken,
        members,
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

  // Rename / edit / publish (visibility flip) — owner only. Group
  // cookbooks stay group-scoped unless the owner deliberately publishes.
  router.patch('/api/collections/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const collection = await loadCollection(id);
      if (!collection || !isOwner(collection, req.user.id)) {
        return res.status(404).json({ error: 'Collection not found' });
      }
      let name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : null;
      const description = typeof req.body?.description === 'string'
        ? req.body.description.trim().slice(0, 500) : null;
      const visibility = ['private', 'group', 'public'].includes(req.body?.visibility)
        ? req.body.visibility : null;

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

  // Leave a cookbook (self) or remove a member (owner). The owner can't
  // leave their own cookbook — delete it instead.
  router.delete('/api/collections/:id/members/:userId', async (req, res) => {
    const id = parseInt(req.params.id);
    const targetId = parseInt(req.params.userId);
    try {
      const collection = await loadCollection(id);
      if (!collection) return res.status(404).json({ error: 'Collection not found' });
      const owner = isOwner(collection, req.user.id);
      if (targetId === collection.user_id) {
        return res.status(400).json({ error: 'The owner cannot leave their own cookbook' });
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

  return router;
}

module.exports = { collectionRoutes };
