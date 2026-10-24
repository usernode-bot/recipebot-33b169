const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// How many suggestions one search may return, and how much ingredient text
// we accept. Both are deliberately small: the pantry page is a short list,
// and an unbounded query string is not a reason to scan every recipe.
const MAX_RESULTS = 12;
const MAX_INGREDIENTS = 25;
const MAX_INGREDIENT_LENGTH = 60;
// Recent community shares considered per search. Matching runs in JS over
// the recipe JSON (the shape the LLM contract guarantees), so this bounds
// the work a single pantry request can cause.
const MAX_SHARED_RECIPES = 500;

// Free text → a comparable form: lowercase, punctuation collapsed to
// spaces ("chicken breast, boneless" → "chicken breast boneless").
function normalizeIngredient(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Very small singularizer — enough for "eggs"/"egg", "tomatoes"/"tomato",
// not a general stemmer. Matching is a convenience here, so approximation
// is fine; a miss only means a recipe ranks lower.
function singularize(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && (word.endsWith('oes') || word.endsWith('ses'))) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function ingredientTokens(value) {
  return normalizeIngredient(value)
    .split(' ')
    .filter(Boolean)
    .map(singularize);
}

// A pantry item matches a recipe ingredient when the whole phrase appears
// ("chicken" in "chicken breast") or when every word of the phrase appears
// in the ingredient name ("soy sauce" in "soy sauce, low sodium"). One-word
// input is the common case and is handled by the first test.
function ingredientMatches(user, recipeName) {
  if (!user || !user.norm || user.norm.length < 2) return false;
  const recipeNorm = normalizeIngredient(recipeName);
  if (!recipeNorm) return false;
  if (recipeNorm.includes(user.norm)) return true;
  const recipeTokens = new Set(ingredientTokens(recipeName));
  return user.tokens.every((token) => recipeTokens.has(token));
}

function prepareIngredients(raw) {
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const clipped = text.slice(0, MAX_INGREDIENT_LENGTH);
    const norm = normalizeIngredient(clipped);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ norm, tokens: ingredientTokens(clipped) });
    if (out.length >= MAX_INGREDIENTS) break;
  }
  return out;
}

// Accepts ?ingredients=a,b and/or repeated ?ingredient=a&ingredient=b, which
// is what URLSearchParams.append produces from the page.
function parseIngredientQuery(query) {
  const raw = [];
  for (const key of ['ingredients', 'ingredient']) {
    const value = query[key];
    if (Array.isArray(value)) raw.push(...value);
    else if (typeof value === 'string') raw.push(value);
  }
  const parts = [];
  for (const chunk of raw) {
    for (const part of String(chunk).split(',')) parts.push(part);
  }
  return prepareIngredients(parts);
}

// Every distinct ingredient named by the recipe's steps. Names are
// deduplicated case-insensitively so a recipe used across several steps
// does not count the same ingredient twice.
function recipeIngredientNames(recipe) {
  const names = [];
  const seen = new Set();
  for (const step of Array.isArray(recipe?.steps) ? recipe.steps : []) {
    for (const ingredient of Array.isArray(step?.ingredients) ? step.ingredients : []) {
      const name = typeof ingredient?.name === 'string' ? ingredient.name.trim() : '';
      const norm = normalizeIngredient(name);
      if (!name || !norm || seen.has(norm)) continue;
      seen.add(norm);
      names.push(name);
    }
  }
  return names;
}

function scoreRecipe(recipe, pantry) {
  const names = recipeIngredientNames(recipe);
  const have = [];
  const missing = [];
  // Count pantry items, not ingredient lines: one item ("chicken") can
  // cover two lines ("chicken breast", "chicken stock"), and "you have 2
  // of 5" must never exceed the number of chips the user entered.
  const used = new Set();
  for (const name of names) {
    const matched = pantry.find((item) => ingredientMatches(item, name));
    if (matched) {
      have.push(name);
      used.add(matched);
    } else {
      missing.push(name);
    }
  }
  return {
    have,
    missing,
    have_count: used.size,
    ingredient_count: names.length,
  };
}

function pantryRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Suggestions are owner-scoped like every other personal list: in staging
  // the seeded demo rows (user_id = 0) are included so testers see a
  // populated page, exactly as /api/recipes does.
  const ownerClause = (col) => (config.isStaging ? `${col} IN ($1, 0)` : `${col} = $1`);

  router.get('/api/pantry/suggest', async (req, res) => {
    const pantry = parseIngredientQuery(req.query);
    if (!pantry.length) {
      return res.status(400).json({ error: 'At least one ingredient is required' });
    }

    try {
      // The requester's own latest recipe per conversation (the same rows
      // the homepage shows), then recent community shares. Own recipes are
      // read first so a recipe the user owns wins a title tie.
      const [own, shared] = await Promise.all([
        pool.query(
          `SELECT DISTINCT ON (c.id) c.id AS conversation_id, m.recipe_data
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE ${ownerClause('c.user_id')} AND m.recipe_data IS NOT NULL
           ORDER BY c.id, m.created_at DESC`,
          [req.user.id]
        ),
        pool.query(
          `SELECT id AS shared_id, username, recipe_data
           FROM shared_recipes
           ORDER BY created_at DESC
           LIMIT $1`,
          [MAX_SHARED_RECIPES]
        ),
      ]);

      const seenTitles = new Set();
      const suggestions = [];

      const consider = (recipe, source, extra) => {
        if (!recipe || typeof recipe !== 'object') return;
        const title = typeof recipe.title === 'string' ? recipe.title.trim() : '';
        const titleKey = normalizeIngredient(title);
        if (!titleKey || seenTitles.has(titleKey)) return;
        const score = scoreRecipe(recipe, pantry);
        if (!score.have_count) return;
        seenTitles.add(titleKey);
        suggestions.push({ recipe, source, ...extra, ...score });
      };

      for (const row of own.rows) {
        consider(row.recipe_data, 'mine', { conversation_id: row.conversation_id });
      }
      for (const row of shared.rows) {
        consider(row.recipe_data, 'shared', {
          shared_id: row.shared_id,
          username: row.username,
        });
      }

      suggestions.sort((a, b) =>
        (b.have_count - a.have_count)
        || (a.missing.length - b.missing.length)
        || String(a.recipe.title || '').localeCompare(String(b.recipe.title || '')));

      res.json(suggestions.slice(0, MAX_RESULTS));
    } catch (err) {
      log.error('pantry', 'Suggestion search failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { pantryRoutes, ingredientMatches, normalizeIngredient };
