const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// No-login public recipe pages (§6.7 first rung of the onboarding ladder):
// GET /r/:slug serves a standalone, full recipe page — ingredients, servings
// scaler, cook mode — with OG/Twitter meta tags so share links unfurl as
// cards. GET /api/public/recipes/:slug feeds it (exempted from the JWT gate
// via the /api/public/ prefix in src/middleware/auth.js). Everything else
// (feed, chat, forking, saving) still requires the platform account.
//
// Lookups are slug-only on purpose — no numeric-ID enumeration — and the
// payload carries usernames but never user ids.

const PLATFORM_APP_URL = 'https://social-vibecoding.usernodelabs.org/#app/recipebot-33b169/full';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function publicRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  async function loadBySlug(slug) {
    if (!slug || typeof slug !== 'string' || slug.length > 64) return null;
    const { rows } = await pool.query(
      `SELECT s.id, s.username, s.recipe_data, s.tags, s.share_slug,
              s.created_at, s.updated_at,
              s.forked_from_shared_id, s.forked_from_username,
              o.share_slug AS forked_from_slug,
              o.recipe_data->>'title' AS forked_from_title,
              COALESCE((SELECT MAX(v.version) FROM shared_recipe_versions v
                        WHERE v.shared_recipe_id = s.id), 1)::int AS current_version,
              (SELECT COUNT(*) FROM made_it_marks mm WHERE mm.shared_recipe_id = s.id)::int AS made_count,
              (SELECT COUNT(*) FROM shared_recipes s2 WHERE s2.forked_from_shared_id = s.id)::int AS remix_count
       FROM shared_recipes s
       LEFT JOIN shared_recipes o ON o.id = s.forked_from_shared_id
       WHERE s.share_slug = $1`,
      [slug]
    );
    if (!rows.length) return null;
    const rec = rows[0];

    const { rows: comments } = await pool.query(
      `SELECT username, body, created_at FROM recipe_comments
       WHERE shared_recipe_id = $1 AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 100`,
      [rec.id]
    );
    const { rows: madeIt } = await pool.query(
      `SELECT username, note, created_at FROM made_it_marks
       WHERE shared_recipe_id = $1 AND note IS NOT NULL
       ORDER BY created_at DESC LIMIT 25`,
      [rec.id]
    );
    const { rows: remixes } = await pool.query(
      `SELECT s.recipe_data->>'title' AS title, s.username, s.share_slug, s.created_at
       FROM shared_recipes s
       WHERE s.forked_from_shared_id = $1
       ORDER BY s.created_at DESC LIMIT 25`,
      [rec.id]
    );

    return {
      username: rec.username,
      recipe: rec.recipe_data,
      tags: rec.tags || [],
      share_slug: rec.share_slug,
      current_version: rec.current_version,
      made_count: rec.made_count,
      remix_count: rec.remix_count,
      forked_from: rec.forked_from_shared_id ? {
        username: rec.forked_from_username,
        title: rec.forked_from_title,
        slug: rec.forked_from_slug,
      } : null,
      comments,
      made_it_notes: madeIt,
      remixes,
      updated_at: rec.updated_at,
    };
  }

  router.get('/api/public/recipes/:slug', async (req, res) => {
    try {
      const data = await loadBySlug(req.params.slug);
      if (!data) return res.status(404).json({ error: 'Recipe not found' });
      res.set('Cache-Control', 'public, max-age=60');
      res.json(data);
    } catch (err) {
      log.error('public', 'Public recipe failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Anonymous SPA data sources ────────────────────────────────────
  // The logged-out app browses through these. Same row shapes as the
  // authenticated endpoints minus every personalized field (my_rating /
  // is_favorited / is_mine) and minus user ids — usernames only.

  // Community feed. Mirrors GET /api/shared-recipes (recipes.js) closely
  // enough that the SPA's card builders and Store.openShared render the
  // rows unchanged. ?tags=a,b filters by array overlap.
  router.get('/api/public/feed', async (req, res) => {
    try {
      const tagFilter = typeof req.query.tags === 'string'
        ? req.query.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12)
        : [];
      const params = [];
      let where = '';
      if (tagFilter.length) {
        params.push(tagFilter);
        where = `WHERE s.tags && $${params.length}::text[]`;
      }
      const { rows } = await pool.query(
        `SELECT s.id, s.username, s.recipe_data AS data, s.tags, s.share_slug,
                s.created_at, s.updated_at,
                s.forked_from_shared_id, s.forked_from_version, s.forked_from_username,
                COALESCE((SELECT MAX(v.version) FROM shared_recipe_versions v
                          WHERE v.shared_recipe_id = s.id), 1)::int AS current_version,
                COALESCE((SELECT AVG(r.rating) FROM recipe_ratings r
                          WHERE r.shared_recipe_id = s.id), 0)::float AS avg_rating,
                (SELECT COUNT(*) FROM recipe_ratings r
                 WHERE r.shared_recipe_id = s.id)::int AS rating_count,
                (SELECT COUNT(*) FROM made_it_marks mm WHERE mm.shared_recipe_id = s.id)::int AS made_count,
                (SELECT COUNT(*) FROM recipe_comments rc
                 WHERE rc.shared_recipe_id = s.id AND rc.deleted_at IS NULL)::int AS comment_count,
                (SELECT COUNT(*) FROM shared_recipes s2 WHERE s2.forked_from_shared_id = s.id)::int AS remix_count
         FROM shared_recipes s
         ${where}
         ORDER BY s.created_at DESC`,
        params
      );
      res.set('Cache-Control', 'public, max-age=60');
      res.json(rows);
    } catch (err) {
      log.error('public', 'Public feed failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Public collections rail. Strictly visibility='public'; never member
  // lists, member counts, or invite tokens.
  router.get('/api/public/collections', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.id, c.name, c.description, c.username, c.created_at,
                (SELECT COUNT(*) FROM collection_items i
                 WHERE i.collection_id = c.id)::int AS item_count
         FROM collections c
         WHERE c.visibility = 'public'
         ORDER BY c.created_at DESC`
      );
      res.set('Cache-Control', 'public, max-age=60');
      res.json(rows);
    } catch (err) {
      log.error('public', 'Public collections failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Public collection detail. 404 unless visibility='public' (numeric-id
  // probing can only reveal already-public collections). Items appear only
  // when their shared_recipe_id resolves to a LIVE shared recipe —
  // snapshot-only items (deleted source) and own-conversation items are
  // omitted: the snapshot is the saver's private copy, and serving it
  // publicly would defeat the "delete = takedown" contract.
  router.get('/api/public/collections/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(404).json({ error: 'Collection not found' });
    try {
      const { rows: coll } = await pool.query(
        `SELECT c.id, c.name, c.description, c.username, c.visibility, c.created_at
         FROM collections c
         WHERE c.id = $1 AND c.visibility = 'public'`,
        [id]
      );
      if (!coll.length) return res.status(404).json({ error: 'Collection not found' });

      const { rows: items } = await pool.query(
        `SELECT i.id, i.shared_recipe_id, i.added_by_username, i.created_at,
                s.recipe_data AS data, s.username, s.share_slug, s.tags
         FROM collection_items i
         JOIN shared_recipes s ON s.id = i.shared_recipe_id
         WHERE i.collection_id = $1
         ORDER BY i.created_at DESC`,
        [id]
      );

      res.set('Cache-Control', 'public, max-age=60');
      res.json({
        ...coll[0],
        is_owner: false,
        is_member: false,
        invite_token: null,
        members: [],
        items: items.map((i) => ({
          id: i.id,
          shared_recipe_id: i.shared_recipe_id,
          conversation_id: null,
          added_by_username: i.added_by_username,
          created_at: i.created_at,
          share_slug: i.share_slug,
          data: i.data,
          username: i.username,
          tags: i.tags,
          snapshot_only: false,
        })),
      });
    } catch (err) {
      log.error('public', 'Public collection failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/r/:slug', async (req, res) => {
    try {
      const data = await loadBySlug(req.params.slug);
      if (!data) {
        return res.status(404).send(notFoundPage());
      }
      res.set('Cache-Control', 'public, max-age=60');
      res.send(recipePage(data, `${req.protocol}://${req.get('host')}/r/${data.share_slug}`));
    } catch (err) {
      log.error('public', 'Public page failed', { message: err.message });
      res.status(500).send('<!doctype html><meta charset="utf-8"><title>Error</title><p>Something went wrong.</p>');
    }
  });

  return router;
}

function notFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Recipe not found — RecipeBot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>body{font-family:Inter,system-ui,sans-serif;background:#FAF6EE;color:#1F2B47;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
@media(prefers-color-scheme:dark){body{background:#141A2B;color:#F3EDDF}}</style>
</head><body><div style="max-width:24rem;padding:2rem;text-align:center">
<h1 style="font-family:Fraunces,Georgia,serif;font-size:1.35rem;margin:0 0 .5rem">Recipe not found</h1>
<p style="color:#5A6378;font-size:.9rem;margin:0 0 1.25rem">This recipe may have been unpublished or deleted by its author.</p>
<a href="${PLATFORM_APP_URL}" style="display:inline-block;padding:.5rem 1rem;background:#b85a24;color:#fff;border-radius:.6rem;text-decoration:none;font-size:.9rem">Open RecipeBot</a>
</div></body></html>`;
}

function recipePage(data, pageUrl) {
  const r = data.recipe;
  const title = r.title || 'Recipe';
  const metaBits = [];
  if (r.prep_time) metaBits.push(`Prep ${r.prep_time}`);
  if (r.cook_time) metaBits.push(`Cook ${r.cook_time}`);
  metaBits.push(`Serves ${r.default_servings}`);
  const description = (r.description || `A recipe by ${data.username} on RecipeBot.`) +
    ` · ${metaBits.join(' · ')}`;
  // Embedded JSON: escape "<" so recipe content can never close the script.
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — RecipeBot</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="RecipeBot">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700;9..144,900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* Warm-paper editorial palette; dark mode is the same ink at night. */
  :root{color-scheme:light dark;
    --page:#FAF6EE;--panel:#F3EDDF;--card:#FFFFFF;--ink:#1F2B47;--soft:#5A6378;
    --hairline:#E7DFCC;--brass:#C9A227;--paprika:#E07A3F;--paprika-deep:#b85a24}
  @media(prefers-color-scheme:dark){:root{
    --page:#141A2B;--panel:#1F2B47;--card:#1F2B47;--ink:#F3EDDF;--soft:#A5ABBE;
    --hairline:#333B54}}
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,-apple-system,sans-serif;margin:0;background:var(--page);color:var(--ink);line-height:1.55}
  .wrap{max-width:680px;margin:0 auto;padding:24px 20px 80px}
  a{color:var(--paprika-deep);text-decoration:none}
  @media(prefers-color-scheme:dark){a{color:var(--paprika)}}
  a:hover{text-decoration:underline}
  .brand{font-size:13px;color:var(--soft);display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid var(--ink)}
  .brand b{font-family:Fraunces,Georgia,serif;color:var(--ink)}
  .kicker{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--brass);margin:0 0 6px}
  h1{font-family:Fraunces,Georgia,serif;font-size:32px;font-weight:900;margin:0 0 4px;letter-spacing:-.01em}
  .byline{font-size:14px;color:var(--soft);margin:0 0 4px}
  .lineage{font-size:13px;color:var(--soft);margin:0 0 8px}
  .desc{color:var(--soft);font-size:15px;margin:8px 0}
  .tags{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
  .tag{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:3px 10px;border-radius:99px;border:1px solid var(--brass);color:var(--brass)}
  .metaline{display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-size:14px;color:var(--soft);margin:14px 0}
  .servings{display:inline-flex;align-items:center;gap:6px;background:var(--panel);border:1px solid var(--hairline);border-radius:10px;padding:2px 6px}
  .servings button{width:26px;height:26px;border:none;background:none;color:inherit;font-size:16px;cursor:pointer;border-radius:6px}
  .servings button:hover{background:var(--hairline)}
  #servings-n{font-weight:600;min-width:20px;text-align:center}
  .cta{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
  .btn{display:inline-block;padding:10px 16px;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;border:none}
  .btn-primary{background:var(--paprika-deep);color:#fff}
  .btn-primary:hover{background:var(--paprika)}
  .btn-secondary{background:var(--panel);border:1px solid var(--hairline);color:var(--ink)}
  h2{font-family:Fraunces,Georgia,serif;font-size:19px;font-weight:700;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--hairline)}
  .step{display:flex;gap:14px;padding:14px;border-radius:8px;background:var(--card);border:1px solid var(--hairline);box-shadow:0 1px 3px rgba(31,43,71,.06);margin:10px 0}
  .stepnum{flex:none;width:28px;height:28px;border-radius:50%;background:var(--paprika-deep);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
  .steptitle{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:15px;margin:2px 0 4px}
  .stepdesc{font-size:14px;margin:0}
  .ings{margin:8px 0 0;padding-left:10px;border-left:2px solid var(--hairline);font-size:13px;color:var(--soft)}
  .ings div{display:flex;justify-content:space-between;gap:10px;padding:1px 0}
  .social{font-size:13px;color:var(--soft)}
  .temp{color:var(--paprika-deep)!important}
  .note,.comment{padding:10px 12px;border-radius:8px;background:var(--card);border:1px solid var(--hairline);margin:8px 0;font-size:14px}
  .note b,.comment b{font-size:13px}
  .note p,.comment p{margin:2px 0 0;color:var(--soft)}
  .foot{margin-top:36px;padding-top:16px;border-top:1px solid var(--hairline);font-size:13px;color:var(--soft)}
  /* cook mode overlay — ink at night regardless of scheme */
  #cook{position:fixed;inset:0;background:#141A2B;color:#F3EDDF;display:none;flex-direction:column;z-index:50}
  #cook.open{display:flex}
  #cook header{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid #333B54}
  #cook header div{font-family:Fraunces,Georgia,serif}
  #cook-body{flex:1;overflow-y:auto;display:flex;align-items:center;justify-content:center;padding:24px}
  #cook-step{max-width:560px}
  #cook-step .stepdesc{font-size:22px;line-height:1.5;font-weight:300}
  #cook nav{display:flex;gap:10px;padding:16px 20px;border-top:1px solid #333B54}
  #cook nav button{flex:1;padding:14px;font-size:16px;border-radius:10px;border:none;cursor:pointer;background:#28304B;color:#F3EDDF}
  #cook nav button.primary{background:var(--paprika-deep);color:#fff}
  #cook .ings{color:#A5ABBE;border-left-color:#333B54}
  #cook .btn-secondary{background:#28304B;border:none;color:#F3EDDF}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span>🍳 <b>RecipeBot</b></span><a href="${PLATFORM_APP_URL}">Open the app →</a></div>
  <p class="kicker">Shared recipe</p>
  <h1 id="title"></h1>
  <p class="byline" id="byline"></p>
  <p class="lineage" id="lineage" style="display:none"></p>
  <p class="desc" id="desc" style="display:none"></p>
  <div class="tags" id="tags"></div>
  <div class="metaline">
    <span class="servings">Servings
      <button id="serv-minus" aria-label="Fewer servings">−</button>
      <span id="servings-n"></span>
      <button id="serv-plus" aria-label="More servings">+</button>
    </span>
    <span id="times"></span>
    <span class="social" id="social-counts"></span>
  </div>
  <div class="cta">
    <button class="btn btn-primary" id="cook-btn">🍳 Cook mode</button>
    <a class="btn btn-secondary" href="${PLATFORM_APP_URL}">Save this to your box</a>
  </div>
  <h2>Ingredients</h2>
  <div id="ingredients"></div>
  <h2>Steps</h2>
  <div id="steps"></div>
  <div id="notes"></div>
  <div id="remixes-section" style="display:none">
    <h2>Remixes</h2>
    <div id="remixes"></div>
  </div>
  <div id="madeit-section" style="display:none">
    <h2>Made it</h2>
    <div id="madeit"></div>
  </div>
  <div id="comments-section" style="display:none">
    <h2>Comments</h2>
    <div id="comments"></div>
  </div>
  <div class="foot">
    Shared by <b id="foot-user"></b> on RecipeBot — recipes without the ads or the life story.
    <a href="/">Browse more recipes →</a> ·
    <a href="${PLATFORM_APP_URL}">Cook, remix, and keep your own box →</a>
  </div>
</div>

<div id="cook">
  <header>
    <div id="cook-title" style="font-weight:600"></div>
    <button class="btn btn-secondary" id="cook-exit">✕ Exit</button>
  </header>
  <div id="cook-body"><div id="cook-step"></div></div>
  <nav>
    <button id="cook-prev">← Previous</button>
    <button id="cook-next" class="primary">Next →</button>
  </nav>
</div>

<script>
var DATA = ${payload};
(function () {
  var r = DATA.recipe;
  var servings = r.default_servings || 1;
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var FRACTIONS = [[0,''],[0.125,'\\u215B'],[0.25,'\\u00BC'],[0.333,'\\u2153'],[0.375,'\\u215C'],[0.5,'\\u00BD'],[0.625,'\\u215D'],[0.667,'\\u2154'],[0.75,'\\u00BE'],[0.875,'\\u215E'],[1,'']];
  function frac(n) {
    if (!n) return '0';
    var whole = Math.floor(n), f = n - whole, best = FRACTIONS[0];
    for (var i = 0; i < FRACTIONS.length; i++) {
      if (Math.abs(f - FRACTIONS[i][0]) < Math.abs(f - best[0])) best = FRACTIONS[i];
    }
    if (best[0] >= 1) return String(whole + 1);
    if (!best[1]) return String(whole || 0);
    return whole ? whole + best[1] : best[1];
  }
  function vol(v, scale) {
    if (!v) return '';
    return frac(v.amount * scale) + ' ' + v.unit;
  }
  function scale() { return servings / (r.default_servings || 1); }

  function ingHtml(step, sc) {
    if (!step.ingredients || !step.ingredients.length) return '';
    var h = '<div class="ings">';
    step.ingredients.forEach(function (ing) {
      var g = Math.round(ing.grams * sc);
      var v = vol(ing.volume, sc);
      h += '<div><span>' + esc(ing.name) + '</span><span>' + g + 'g' + (v ? ' · ' + v : '') + '</span></div>';
    });
    return h + '</div>';
  }

  function render() {
    document.getElementById('servings-n').textContent = servings;
    var sc = scale();
    var ings = '';
    var steps = '';
    (r.steps || []).forEach(function (step, i) {
      if (step.ingredients && step.ingredients.length) {
        ings += '<div class="step" style="padding:10px 14px"><div style="flex:1">' +
          '<div class="steptitle">Step ' + (i + 1) + (step.title ? ': ' + esc(step.title) : '') + '</div>' +
          ingHtml(step, sc) + '</div></div>';
      }
      steps += '<div class="step"><div class="stepnum">' + (i + 1) + '</div><div style="flex:1;min-width:0">' +
        (step.title ? '<div class="steptitle">' + esc(step.title) + '</div>' : '') +
        '<p class="stepdesc">' + esc(step.description) + '</p>' +
        (step.temperature_f ? '<p class="stepdesc" style="color:#e07a3f">' + step.temperature_f + '°F / ' + Math.round((step.temperature_f - 32) * 5 / 9) + '°C</p>' : '') +
        ingHtml(step, sc) + '</div></div>';
    });
    document.getElementById('ingredients').innerHTML = ings || '<p class="social">No ingredients listed.</p>';
    document.getElementById('steps').innerHTML = steps;
  }

  document.getElementById('title').textContent = r.title || 'Recipe';
  document.getElementById('byline').textContent = 'by ' + DATA.username +
    (DATA.current_version > 1 ? ' · v' + DATA.current_version : '');
  if (DATA.forked_from) {
    var l = document.getElementById('lineage');
    l.style.display = '';
    l.innerHTML = '⑂ remixed from ' + (DATA.forked_from.slug
      ? '<a href="/r/' + esc(DATA.forked_from.slug) + '">' + esc(DATA.forked_from.username) + "'s " + esc(DATA.forked_from.title || 'recipe') + '</a>'
      : esc(DATA.forked_from.username || 'another cook') + "'s " + esc(DATA.forked_from.title || 'recipe'));
  }
  if (r.description) {
    var d = document.getElementById('desc');
    d.style.display = '';
    d.textContent = r.description;
  }
  document.getElementById('tags').innerHTML = (DATA.tags || []).map(function (t) {
    return '<span class="tag">' + esc(t) + '</span>';
  }).join('');
  var times = [];
  if (r.prep_time) times.push('Prep: ' + r.prep_time);
  if (r.cook_time) times.push('Cook: ' + r.cook_time);
  document.getElementById('times').textContent = times.join(' · ');
  var counts = [];
  if (DATA.made_count) counts.push('cooked ' + DATA.made_count + '×');
  if (DATA.remix_count) counts.push(DATA.remix_count + ' remix' + (DATA.remix_count === 1 ? '' : 'es'));
  document.getElementById('social-counts').textContent = counts.join(' · ');
  document.getElementById('foot-user').textContent = DATA.username;
  if (r.notes) {
    document.getElementById('notes').innerHTML = '<h2>Notes</h2><div class="note">' + esc(r.notes) + '</div>';
  }
  if (DATA.remixes && DATA.remixes.length) {
    document.getElementById('remixes-section').style.display = '';
    document.getElementById('remixes').innerHTML = DATA.remixes.map(function (x) {
      var name = esc(x.title || 'Untitled') + ' <span style="opacity:.7">by ' + esc(x.username) + '</span>';
      return '<div class="note">' + (x.share_slug
        ? '<a href="/r/' + esc(x.share_slug) + '">' + name + '</a>' : name) + '</div>';
    }).join('');
  }
  if (DATA.made_it_notes && DATA.made_it_notes.length) {
    document.getElementById('madeit-section').style.display = '';
    document.getElementById('madeit').innerHTML = DATA.made_it_notes.map(function (m) {
      return '<div class="note"><b>' + esc(m.username) + '</b> made it<p>' + esc(m.note) + '</p></div>';
    }).join('');
  }
  if (DATA.comments && DATA.comments.length) {
    document.getElementById('comments-section').style.display = '';
    document.getElementById('comments').innerHTML = DATA.comments.map(function (c) {
      return '<div class="comment"><b>' + esc(c.username) + '</b><p>' + esc(c.body) + '</p></div>';
    }).join('');
  }

  document.getElementById('serv-minus').addEventListener('click', function () {
    servings = Math.max(1, servings - 1); render();
  });
  document.getElementById('serv-plus').addEventListener('click', function () {
    servings = servings + 1; render();
  });

  // Minimal cook mode: full-screen one-step-at-a-time with wake lock.
  var cookIdx = 0;
  var wakeLock = null;
  function renderCookStep() {
    var steps = r.steps || [];
    var el = document.getElementById('cook-step');
    if (cookIdx >= steps.length) {
      el.innerHTML = '<p style="font-size:40px;text-align:center">🎉</p><p class="stepdesc" style="text-align:center">You\\'re done! Enjoy your meal.</p>' +
        '<p style="text-align:center;margin-top:20px"><a class="btn btn-primary" href="${PLATFORM_APP_URL}" style="text-decoration:none">Keep this recipe — open RecipeBot</a></p>';
      document.getElementById('cook-next').style.visibility = 'hidden';
      return;
    }
    document.getElementById('cook-next').style.visibility = '';
    var step = steps[cookIdx];
    el.innerHTML = '<div style="color:#C9A227;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;margin-bottom:12px">Step ' + (cookIdx + 1) + ' of ' + steps.length +
      (step.title ? ' — ' + esc(step.title) : '') + '</div>' +
      '<p class="stepdesc">' + esc(step.description) + '</p>' +
      (step.temperature_f ? '<p class="stepdesc" style="color:#e07a3f;margin-top:10px">' + step.temperature_f + '°F / ' + Math.round((step.temperature_f - 32) * 5 / 9) + '°C</p>' : '') +
      ingHtml(step, scale());
    document.getElementById('cook-prev').disabled = cookIdx === 0;
  }
  document.getElementById('cook-btn').addEventListener('click', function () {
    cookIdx = 0;
    document.getElementById('cook-title').textContent = r.title || 'Recipe';
    document.getElementById('cook').classList.add('open');
    renderCookStep();
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (wl) { wakeLock = wl; }).catch(function () {});
    }
  });
  document.getElementById('cook-exit').addEventListener('click', function () {
    document.getElementById('cook').classList.remove('open');
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  });
  document.getElementById('cook-prev').addEventListener('click', function () {
    if (cookIdx > 0) { cookIdx--; renderCookStep(); }
  });
  document.getElementById('cook-next').addEventListener('click', function () {
    cookIdx++; renderCookStep();
  });

  render();
})();
</script>
</body>
</html>`;
}

module.exports = { publicRoutes };
