const { Router } = require('express');
const { getPool } = require('../db/pool');
const { categorizeIngredient } = require('../services/shopping-categories');
const log = require('../services/logger');

// Per-user shopping list (schema.sql shopping_list_items). Rows are snapshot
// copies of recipe ingredients; adding a recipe MERGES into them by
// lower(trim(name)) + exact volume_unit, summing grams and volume.amount.
// Recipe sources are dual-target like favorites/made-it: an owned
// conversation or a published shared recipe, exactly one.
function shoppingListRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // In staging, owner-scoped endpoints also cover the seeded demo rows
  // (user_id = 0, see src/db/migrate.js) so testers can exercise the flows.
  // n is the parameter position the user id occupies in that query; Postgres
  // requires every $n to be distinct, so "IN ($n, 0)" is the safe spelling.
  const ownerClause = (col, n = 1) =>
    config.isStaging ? `${col} IN ($${n}, 0)` : `${col} = $${n}`;

  // Effective scale: how many times the BASE recipe the user is adding.
  // Same formula as the recipe view's scaleFor(): servings over the recipe's
  // default, times the panel's Scale multiplier. Card buttons send nothing,
  // which lands on 1 (base recipe at default servings).
  function scaleFor(recipe, body) {
    const base = recipe?.default_servings || 1;
    const servings = parseInt(body?.servings, 10) || base;
    const scale = parseFloat(body?.scale);
    const scaleNum = Number.isFinite(scale) && scale > 0 ? scale : 1;
    return (Math.max(1, servings) / base) * scaleNum;
  }

  // Everything a merged insert needs, from a client recipe snapshot.
  // Excludes from_step rows: those are intermediate step outputs ("prepared
  // dough"), not things you buy.
  function ingredientsOf(recipe, scale) {
    const out = [];
    for (const step of recipe?.steps || []) {
      for (const ing of step?.ingredients || []) {
        if (ing.from_step) continue;
        out.push({
          name: String(ing.name || '').trim(),
          grams: Math.max(0, Number(ing.grams) || 0) * scale,
          volumeAmount: Math.max(0, Number(ing.volume?.amount) || 0) * scale,
          volumeUnit: String(ing.volume?.unit || '').trim().slice(0, 30),
        });
      }
    }
    return out.filter((i) => i.name);
  }

  router.get('/api/shopping-list', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM shopping_list_items
         WHERE ${ownerClause('user_id')}
         ORDER BY
           CASE category
             WHEN 'produce' THEN 1 WHEN 'dairy' THEN 2 WHEN 'meat' THEN 3
             WHEN 'pantry' THEN 4 ELSE 5 END,
           lower(name), id`,
        [req.user.id]
      );
      res.json({
        items: rows,
        total: rows.length,
        checked: rows.filter((r) => r.checked).length,
      });
    } catch (err) {
      log.error('shopping-list', 'List failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Add a recipe's ingredients. POST is /api/shopping-list; the bulk-clear
  // endpoint lives at /clear-checked (a subpath of the same noun).
  router.post('/api/shopping-list/clear-checked', async (req, res) => {
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM shopping_list_items WHERE user_id = $1 AND checked = TRUE',
        [req.user.id]
      );
      res.json({ ok: true, removed: rowCount });
    } catch (err) {
      log.error('shopping-list', 'Clear checked failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/shopping-list', async (req, res) => {
    const sharedId = parseInt(req.body?.sharedRecipeId) || null;
    const convId = parseInt(req.body?.conversationId) || null;
    if (!sharedId === !convId) {
      return res.status(400).json({ error: 'Exactly one of sharedRecipeId / conversationId required' });
    }

    try {
      let recipe = null;
      let title = null;
      if (sharedId) {
        const { rows } = await pool.query(
          'SELECT recipe_data, recipe_data->>\'title\' AS title FROM shared_recipes WHERE id = $1',
          [sharedId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Recipe not found' });
        recipe = rows[0].recipe_data;
        title = rows[0].title;
      } else {
        const { rows } = await pool.query(
          `SELECT recipe_data FROM messages
           WHERE conversation_id = $2 AND recipe_data IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
          [req.user.id, convId]
        );
        const { rows: conv } = await pool.query(
          `SELECT id, title FROM conversations WHERE id = $2 AND ${ownerClause('user_id')}`,
          [req.user.id, convId]
        );
        if (!conv.length) return res.status(404).json({ error: 'Conversation not found' });
        if (!rows.length) {
          return res.status(404).json({ error: 'Conversation has no recipe to add' });
        }
        recipe = rows[0].recipe_data;
        title = conv[0].title;
      }

      const scale = scaleFor(recipe, req.body);
      const ingredients = ingredientsOf(recipe, scale);

      await pool.query('BEGIN');
      try {
        for (const ing of ingredients) {
          const category = categorizeIngredient(ing.name);
          const { rows: existing } = await pool.query(
            `SELECT id, grams, volume_amount FROM shopping_list_items
             WHERE user_id = $1 AND lower(trim(name)) = lower(trim($2)) AND volume_unit = $3
             ORDER BY id LIMIT 1
             FOR UPDATE`,
            [req.user.id, ing.name, ing.volumeUnit]
          );
          if (existing.length) {
            await pool.query(
              `UPDATE shopping_list_items
               SET grams = grams + $2, volume_amount = volume_amount + $3
               WHERE id = $1`,
              [existing[0].id, ing.grams, ing.volumeAmount]
            );
          } else {
            await pool.query(
              `INSERT INTO shopping_list_items
               (user_id, username, shared_recipe_id, conversation_id, recipe_title,
                category, name, grams, volume_amount, volume_unit)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [req.user.id, req.user.username || 'unknown', sharedId, convId,
               title, category, ing.name, ing.grams, ing.volumeAmount, ing.volumeUnit]
            );
          }
        }
        const { rows: counts } = await pool.query(
          'SELECT COUNT(*)::int AS item_count FROM shopping_list_items WHERE user_id = $1',
          [req.user.id]
        );
        await pool.query('COMMIT');
        log.info('shopping-list', 'Added recipe', {
          userId: req.user.id, sharedId, convId, items: ingredients.length,
        });
        res.json({ ok: true, item_count: counts[0].item_count });
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
    } catch (err) {
      log.error('shopping-list', 'Add failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/shopping-list/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const checked = req.body?.checked;
    if (!id || typeof checked !== 'boolean') {
      return res.status(400).json({ error: 'id and boolean checked required' });
    }
    try {
      const { rowCount } = await pool.query(
        `UPDATE shopping_list_items SET checked = $2
         WHERE id = $1 AND ${ownerClause('user_id', 3)}`,
        [id, checked, req.user.id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Item not found' });
      res.json({ ok: true });
    } catch (err) {
      log.error('shopping-list', 'Update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/shopping-list/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM shopping_list_items WHERE id = $1 AND ${ownerClause('user_id', 2)}`,
        [id, req.user.id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Item not found' });
      res.json({ ok: true });
    } catch (err) {
      log.error('shopping-list', 'Delete failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { shoppingListRoutes };
