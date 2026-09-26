const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPool } = require('./pool');
const log = require('../services/logger');

// Sentinel owner for staging demo rows. In staging, list endpoints include
// this user's rows so testers see a populated homepage/recipe panel.
const DEMO_USER_ID = 0;
const DEMO_CONV_ID = 900001;

async function migrate(config) {
  const pool = getPool(config);

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');

  log.info('db', 'Running migrations...');
  await pool.query(schema);
  log.info('db', 'Schema up to date');

  // Clean up stale rate limit rows
  await pool.query(
    "DELETE FROM rate_limits WHERE date < CURRENT_DATE - INTERVAL '7 days'"
  );
  await pool.query(
    "DELETE FROM llm_usage WHERE date < (NOW() AT TIME ZONE 'utc')::date - INTERVAL '7 days'"
  );

  // On startup, all 'processing' replies are dead (no background stream running)
  const { rowCount } = await pool.query(
    `UPDATE pending_replies SET status = 'error', updated_at = NOW()
     WHERE status = 'processing'`
  );
  if (rowCount > 0) {
    log.info('db', `Cleaned up ${rowCount} stale pending_replies`);
  }

  if (config.isStaging) {
    await seedStagingDemo(pool);
  }

  // Backfill public share slugs for every shared recipe that predates the
  // public-page feature (owner decision: ALL previously published recipes
  // get public pages — no republish gate). Idempotent (WHERE share_slug IS
  // NULL) and collision-safe (unique index + retry). Runs after the staging
  // seed so seeded rows get slugs on the same boot.
  await backfillShareSlugs(pool);
}

async function backfillShareSlugs(pool) {
  const { rows } = await pool.query(
    'SELECT id FROM shared_recipes WHERE share_slug IS NULL'
  );
  let filled = 0;
  for (const row of rows) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = crypto.randomBytes(8).toString('base64url');
      try {
        await pool.query(
          'UPDATE shared_recipes SET share_slug = $2 WHERE id = $1 AND share_slug IS NULL',
          [row.id, slug]
        );
        filled++;
        break;
      } catch (err) {
        if (err.code !== '23505') throw err; // retry only on unique violation
      }
    }
  }
  if (filled > 0) {
    log.info('db', `Backfilled share slugs for ${filled} shared recipes`);
  }
}

const DEMO_RECIPE = {
  version: 1,
  title: 'Staging Demo Chicken Stir Fry',
  description: 'A quick weeknight stir fry seeded for staging previews.',
  default_servings: 4,
  prep_time: '15 min',
  cook_time: '10 min',
  tags: ['chinese', 'dinner', 'one-pot'],
  notes: 'Staging demo data — works with tofu instead of chicken.',
  steps: [
    {
      title: 'Prep chicken',
      description: 'Dice the chicken into 1-inch cubes and season with the salt.',
      temperature_f: null,
      ingredients: [
        {
          name: 'chicken breast, boneless skinless',
          grams: 500,
          volume: { amount: 2, unit: 'cup' },
          macros: { calories: 550, protein_g: 110, carbs_g: 0, fat_g: 12, fiber_g: 0 },
        },
        {
          name: 'salt',
          grams: 3,
          volume: { amount: 0.5, unit: 'tsp' },
          macros: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
        },
      ],
    },
    {
      title: 'Sear chicken',
      description: 'Heat the oil in a wok over high heat and stir-fry the chicken until golden, about 5 minutes.',
      temperature_f: 425,
      ingredients: [
        {
          name: 'vegetable oil',
          grams: 14,
          volume: { amount: 1, unit: 'tbsp' },
          macros: { calories: 124, protein_g: 0, carbs_g: 0, fat_g: 14, fiber_g: 0 },
        },
      ],
    },
    {
      title: 'Add vegetables',
      description: 'Add the broccoli and the soy sauce; toss for 3 minutes until crisp-tender, then serve.',
      temperature_f: null,
      ingredients: [
        {
          name: 'broccoli florets',
          grams: 200,
          volume: { amount: 2, unit: 'cup' },
          macros: { calories: 68, protein_g: 5.6, carbs_g: 13, fat_g: 0.8, fiber_g: 5.2 },
        },
        {
          name: 'soy sauce',
          grams: 16,
          volume: { amount: 1, unit: 'tbsp' },
          macros: { calories: 9, protein_g: 1.3, carbs_g: 0.8, fat_g: 0, fiber_g: 0 },
        },
      ],
    },
  ],
};

const DEMO_RECIPE_2 = {
  ...DEMO_RECIPE,
  title: 'Staging Demo Tofu Stir Fry',
  description: 'Vegan variant of the staging demo stir fry.',
  tags: ['chinese', 'dinner', 'one-pot', 'vegan'],
  notes: 'Staging demo data.',
  steps: [
    {
      title: 'Prep tofu',
      description: 'Press the tofu, cut into cubes, and toss with the salt.',
      temperature_f: null,
      ingredients: [
        {
          name: 'extra-firm tofu',
          grams: 400,
          volume: { amount: 2, unit: 'cup' },
          macros: { calories: 380, protein_g: 40, carbs_g: 8, fat_g: 22, fiber_g: 2 },
        },
        {
          name: 'salt',
          grams: 3,
          volume: { amount: 0.5, unit: 'tsp' },
          macros: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
        },
      ],
    },
    {
      ...DEMO_RECIPE.steps[1],
      title: 'Sear tofu',
      description: 'Heat the oil in a wok over high heat and sear the tofu until golden, about 5 minutes.',
    },
    DEMO_RECIPE.steps[2],
  ],
};

// Edited-recipe variants for the issue #16 regression seeds — distinct
// titles so the dapp.json tests (and testers) can tell the two apart.
const DEMO_RECIPE_ACCEPTED = { ...DEMO_RECIPE_2, title: 'Staging Demo Accepted Tofu Stir Fry' };
const DEMO_RECIPE_PENDING = { ...DEMO_RECIPE_2, title: 'Staging Demo Pending Tofu Stir Fry' };
// Issue #24 regression variants: a conversation where an older proposal was
// left undecided and a newer one was accepted, and one whose decision is
// recorded in the pre-#24 representation (status = 'acknowledged').
const DEMO_RECIPE_SUPERSEDED = { ...DEMO_RECIPE_2, title: 'Staging Demo Superseded Tofu Stir Fry' };
const DEMO_RECIPE_LEGACY = { ...DEMO_RECIPE_2, title: 'Staging Demo Legacy Tofu Stir Fry' };

// Regression seeds for issues #16 / #24 (accept-edit screen reappearing): a
// conversation whose recipe was edited, with pending_replies rows in given
// terminal states and decisions. Message/reply timestamps are staggered
// explicitly because the client compares message created_at against the
// reply's created_at to decide whether to re-show the Accept/Reject diff (a
// multi-row INSERT would give every row the same NOW()).
//
// Never seed status = 'processing': migrate() flips every processing row to
// 'error' on each boot, so such a seed wouldn't survive a restart.
//
// `extraReply` optionally seeds an EARLIER reply row (an abandoned proposal),
// which is the shape that used to resurrect a settled diff.
async function seedEditDecisionDemo(
  pool, convId, title, newRecipe, replyId, replyStatus, editDecision = null, extraReply = null,
  ageDays = 0
) {
  await pool.query(
    `INSERT INTO conversations (id, user_id, title, preferences)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [convId, DEMO_USER_ID, title, JSON.stringify({ complexity: 'normal', serving: 'normal' })]
  );

  const { rows } = await pool.query(
    'SELECT 1 FROM messages WHERE conversation_id = $1 LIMIT 1',
    [convId]
  );
  if (rows.length === 0) {
    // `ageDays` shifts the WHOLE conversation back in time so "Your recipes"
    // has an unambiguous newest-first order in staging (issue #40). The
    // within-conversation spacing is untouched: the issue #16 / #24
    // regressions depend on old recipe → reply → newer recipe, with the
    // pending_replies row (seeded below, also shifted) landing between the
    // two recipe messages.
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, recipe_data, created_at) VALUES
       ($1, 'user', 'Staging demo: make me a quick chicken stir fry', NULL, NOW() - $6::interval - interval '11 min'),
       ($1, 'assistant', $2, $3, NOW() - $6::interval - interval '10 min'),
       ($1, 'user', 'Staging demo: now make it vegan', NULL, NOW() - $6::interval - interval '6 min'),
       ($1, 'assistant', $4, $5, NOW() - $6::interval - interval '4 min')`,
      [
        convId,
        `[Recipe: ${DEMO_RECIPE.title}]`,
        JSON.stringify(DEMO_RECIPE),
        `[Recipe: ${newRecipe.title}]`,
        JSON.stringify(newRecipe),
        `${ageDays} days`,
      ]
    );
  }

  // An older, never-answered proposal — seeded BEFORE the main reply so it
  // can only ever be the loser of the "newest reply wins" lookup.
  if (extraReply) {
    await pool.query(
      `INSERT INTO pending_replies (id, conversation_id, user_id, status, edit_decision, events, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '[]', NOW() - $6::interval - interval '8 min',
               NOW() - $6::interval - interval '7 min')
       ON CONFLICT (id) DO NOTHING`,
      [extraReply.replyId, convId, DEMO_USER_ID, extraReply.status,
       extraReply.editDecision || null, `${ageDays} days`]
    );
  }

  // Reply created between the old and new recipe messages, so the client
  // treats the newer recipe message as this reply's proposed edit. Shifted
  // by the same `ageDays` as the messages above so the relation holds.
  await pool.query(
    `INSERT INTO pending_replies (id, conversation_id, user_id, status, edit_decision, decided_at, events, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $5::varchar IS NULL THEN NULL ELSE NOW() - $6::interval - interval '3 min' END,
             '[]', NOW() - $6::interval - interval '5 min', NOW() - $6::interval - interval '4 min')
     ON CONFLICT (id) DO NOTHING`,
    [replyId, convId, DEMO_USER_ID, replyStatus, editDecision, `${ageDays} days`]
  );
}

async function seedStagingDemo(pool) {
  // Idempotent: fixed high IDs, ON CONFLICT DO NOTHING. SERIAL sequences
  // start far below 900001, so app-created rows won't collide.
  await pool.query(
    `INSERT INTO conversations (id, user_id, title, preferences)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [DEMO_CONV_ID, DEMO_USER_ID, 'Staging demo — Chicken Stir Fry', JSON.stringify({ complexity: 'normal', serving: 'normal' })]
  );

  const { rows } = await pool.query(
    'SELECT 1 FROM messages WHERE conversation_id = $1 LIMIT 1',
    [DEMO_CONV_ID]
  );
  if (rows.length === 0) {
    // Explicit timestamps (rather than the NOW() default) so this
    // conversation's newest recipe sits at a known point in the "Your
    // recipes" recency order — see the ageDays ladder below (issue #40).
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, recipe_data, created_at) VALUES
       ($1, 'user', 'Staging demo: make me a quick chicken stir fry', NULL, NOW() - interval '2 days 20 min'),
       ($1, 'assistant', 'Here''s a quick weeknight chicken stir fry — ready in about 25 minutes.', NULL, NOW() - interval '2 days 18 min'),
       ($1, 'assistant', '[Recipe: Staging Demo Chicken Stir Fry]', $2, NOW() - interval '2 days 15 min'),
       ($1, 'user', 'Staging demo: now make it vegan', NULL, NOW() - interval '2 days 10 min'),
       ($1, 'assistant', 'Swapped the chicken for extra-firm tofu.', NULL, NOW() - interval '2 days 6 min'),
       ($1, 'assistant', '[Recipe: Staging Demo Tofu Stir Fry]', $3, NOW() - interval '2 days 4 min')`,
      [DEMO_CONV_ID, JSON.stringify(DEMO_RECIPE), JSON.stringify(DEMO_RECIPE_2)]
    );
    log.info('db', 'Seeded staging demo conversation');
  }

  // Issue #16 regression seeds: an already-accepted edit (must open to the
  // normal recipe view) and an undecided edit (must open to the diff).
  // The trailing ageDays argument spaces these conversations out in time so
  // the homepage's newest-first recipe order is visible (issue #40).
  await seedEditDecisionDemo(
    pool, 900003, 'Staging demo — Accepted edit stir fry',
    DEMO_RECIPE_ACCEPTED, 900301, 'done', 'accepted', null, 5
  );
  await seedEditDecisionDemo(
    pool, 900004, 'Staging demo — Pending edit stir fry',
    DEMO_RECIPE_PENDING, 900302, 'done', null, null, 0
  );

  // Issue #24 regression seeds. 900006: a newer accepted edit alongside an
  // older reply the user never answered — the old lookup skipped the decided
  // row and re-showed the stale proposal's diff, costing an extra Accept
  // click. 900007: a decision recorded the pre-#24 way (status =
  // 'acknowledged', no edit_decision) must still count as decided.
  await seedEditDecisionDemo(
    pool, 900006, 'Staging demo — Superseded edit stir fry',
    DEMO_RECIPE_SUPERSEDED, 900304, 'done', 'accepted',
    { replyId: 900303, status: 'done', editDecision: null }, 9
  );
  await seedEditDecisionDemo(
    pool, 900007, 'Staging demo — Legacy acknowledged edit',
    DEMO_RECIPE_LEGACY, 900305, 'acknowledged', null, null, 14
  );
  log.info('db', 'Seeded staging edit-decision demo conversations');

  // Failed-fix-up demo: a conversation whose last reply ended with a failed
  // "Fixing recipe format..." step, so reloaded history shows the ✕ and
  // warning icons (silent-failure fix) instead of misleading checkmarks.
  await pool.query(
    `INSERT INTO conversations (id, user_id, title, preferences)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [900005, DEMO_USER_ID, 'Staging demo — Failed recipe fix-up', JSON.stringify({ complexity: 'normal', serving: 'normal' })]
  );
  const { rows: fixupDemoRows } = await pool.query(
    'SELECT 1 FROM messages WHERE conversation_id = $1 LIMIT 1',
    [900005]
  );
  if (fixupDemoRows.length === 0) {
    const failedReplyLog = [
      { type: 'thinking', kind: 'thinking', text: 'Thinking...' },
      { type: 'text', content: 'Doubling the garlic and halving the fennel now.' },
      { type: 'status', kind: 'fixup', text: 'Fixing recipe format...', ok: false },
      { type: 'warning', kind: 'truncated', text: 'Response was cut off' },
    ];
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, recipe_data, response_log, created_at) VALUES
       ($1, 'user', 'Staging demo: make me a quick chicken stir fry', NULL, NULL, NOW() - interval '12 min'),
       ($1, 'assistant', '[Recipe: Staging Demo Chicken Stir Fry]', $2, NULL, NOW() - interval '11 min'),
       ($1, 'user', 'Staging demo: double the garlic', NULL, $3, NOW() - interval '5 min'),
       ($1, 'assistant', '[Recipe update FAILED — display_recipe was not called successfully. The response was cut off by the output length limit. The current recipe is unchanged; you must call display_recipe with the full corrected recipe on your next turn.]', NULL, NULL, NOW() - interval '4 min')`,
      [900005, JSON.stringify(DEMO_RECIPE), JSON.stringify(failedReplyLog)]
    );
    log.info('db', 'Seeded staging failed-fix-up demo conversation');
  }

  // Timed-out-web-read demo (issue #43): a reply that read a source and then
  // hit the AI timeout. The failure is persisted in the response_log, so
  // reopening the conversation must show the ✕ on the "Reading:" step, the
  // explanation, and a working "Try again" button — the behaviour that simply
  // vanished on reload before this change.
  await pool.query(
    `INSERT INTO conversations (id, user_id, title, preferences, created_at)
     VALUES ($1, $2, $3, $4, NOW() - interval '2 days')
     ON CONFLICT (id) DO NOTHING`,
    [900008, DEMO_USER_ID, 'Staging demo — Timed-out web read', JSON.stringify({ complexity: 'serious', serving: 'normal' })]
  );
  const { rows: timeoutDemoRows } = await pool.query(
    'SELECT 1 FROM messages WHERE conversation_id = $1 LIMIT 1',
    [900008]
  );
  if (timeoutDemoRows.length === 0) {
    const sourceUrl = 'https://www.seriouseats.com/best-vegetarian-bean-chile-recipe';
    const timedOutReplyLog = [
      { type: 'thinking', kind: 'thinking', text: 'Thinking...', detail: 'The user wants the Serious Eats treatment, so I should read the source first.' },
      {
        type: 'status', kind: 'search', text: 'Searching: serious eats vegetarian bean chili',
        query: 'serious eats vegetarian bean chili',
        results: [{ title: 'The Best Vegetarian Bean Chili', url: sourceUrl }],
      },
      // ok:false mirrors what markLastStatusFailed writes at runtime: the step
      // that was in flight when the reply died renders with an ✕.
      { type: 'status', kind: 'fetch', text: `Reading: ${sourceUrl}`, url: sourceUrl, ok: false },
      {
        type: 'error', kind: 'timeout', ok: false,
        text: 'The AI took too long to answer — this usually happens with very long recipes. Your message is still here; tap Try again.',
      },
    ];
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, recipe_data, response_log, created_at) VALUES
       ($1, 'user', 'Staging demo: a hearty vegetarian bean chili', NULL, NULL, NOW() - interval '2 days'),
       ($1, 'assistant', '[Recipe: Staging Demo Chicken Stir Fry]', $2, NULL, NOW() - interval '2 days' + interval '1 min'),
       ($1, 'user', 'Staging demo: make this like the Serious Eats version', NULL, $3, NOW() - interval '2 days' + interval '6 min')`,
      [900008, JSON.stringify(DEMO_RECIPE), JSON.stringify(timedOutReplyLog)]
    );
    // status='error' is what conversations.js reports as the newest reply, and
    // what the client turns into the Try again affordance.
    await pool.query(
      `INSERT INTO pending_replies (id, conversation_id, user_id, status, events, created_at, updated_at)
       VALUES (900306, 900008, $1, 'error', '[]'::jsonb,
               NOW() - interval '2 days' + interval '6 min',
               NOW() - interval '2 days' + interval '8 min')
       ON CONFLICT (id) DO NOTHING`,
      [DEMO_USER_ID]
    );
    log.info('db', 'Seeded staging timed-out-web-read demo conversation');
  }

  // Drafts (issue #32): conversations that never produced a recipe. Every
  // other seeded conversation has one, so without these the homepage's
  // Drafts section — now the FIRST section of "Your box" (issue #40),
  // compact rows plus the "Show N more" disclosure past three — would never
  // render in staging. Four rows so the disclosure itself is visible.
  //
  // The timestamps carry the issue #40 demonstration: conversation
  // created_at and message created_at are seeded independently, and the
  // FIRST entry is the proof row — the OLDEST conversation of the set but
  // the most recently messaged, so it can only sort first under the new
  // last-activity order (the old `ORDER BY c.created_at DESC` put it last).
  const DRAFTS = [
    { title: 'Staging demo — Draft: something with leftover rice',
      createdDaysAgo: 40, activeDaysAgo: 0, activeHours: 2 },
    { title: 'Staging demo — Draft: birthday cake ideas',
      createdDaysAgo: 1, activeDaysAgo: 1 },
    { title: 'Staging demo — Draft: what to do with a glut of tomatoes',
      createdDaysAgo: 4, activeDaysAgo: 4 },
    { title: 'Staging demo — Draft: cold lunches for the week',
      createdDaysAgo: 30, activeDaysAgo: 30 },
  ];
  for (let i = 0; i < DRAFTS.length; i++) {
    const convId = 900010 + i;
    const draft = DRAFTS[i];
    await pool.query(
      `INSERT INTO conversations (id, user_id, title, preferences, created_at)
       VALUES ($1, $2, $3, $4, NOW() - $5::interval)
       ON CONFLICT (id) DO NOTHING`,
      [convId, DEMO_USER_ID, draft.title,
       JSON.stringify({ complexity: 'normal', serving: 'normal' }),
       `${draft.createdDaysAgo} days`]
    );
    const { rows: draftMsgs } = await pool.query(
      'SELECT 1 FROM messages WHERE conversation_id = $1 LIMIT 1', [convId]);
    if (draftMsgs.length === 0) {
      await pool.query(
        `INSERT INTO messages (conversation_id, role, content, recipe_data, created_at) VALUES
         ($1, 'user', $2, NULL, NOW() - $3::interval - $4::interval)`,
        [convId, 'Staging demo: still thinking about this one.',
         `${draft.activeDaysAgo} days`, `${draft.activeHours || 0} hours`]
      );
    }
  }
  log.info('db', 'Seeded staging draft conversations');

  // Two of the demo user's own recipes are favorited (issue #40): 900003 is
  // 5 days old, 900007 is 14, so own-recipe cards in "Your favorites" lead
  // with 900003. NOTE: is_favorited is scoped to the REQUESTER
  // (recipe_favorites.user_id = $1), not to the row's owner, so a staging
  // tester signed in as themselves won't see these — they favorite a card
  // with the heart to check that ordering. Seeded anyway so the demo user's
  // own view is coherent. Own-conversation favorites are the dual-target
  // form of recipe_favorites; the partial unique index keeps this idempotent.
  await pool.query(
    `INSERT INTO recipe_favorites (user_id, conversation_id)
     VALUES ($1, 900003), ($1, 900007)
     ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
     DO NOTHING`,
    [DEMO_USER_ID]
  );
  log.info('db', 'Seeded staging own-recipe favorites');

  // Social features: seed the community feed with two shared recipes from
  // two distinct fake creators, plus ratings so aggregates visibly render.
  // Fixed high IDs + ON CONFLICT keep this idempotent across reboots.
  await pool.query(
    `INSERT INTO shared_recipes (id, user_id, username, conversation_id, recipe_data)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [900001, DEMO_USER_ID, 'staging-demo-user', DEMO_CONV_ID, JSON.stringify(DEMO_RECIPE)]
  );
  await pool.query(
    `INSERT INTO shared_recipes (id, user_id, username, conversation_id, recipe_data)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [900002, 900002, 'staging-demo-chef', 900002, JSON.stringify(DEMO_RECIPE_2)]
  );
  // Version history for the demo chef's shared recipe: v1 (chicken) → v2
  // (tofu, matching its current recipe_data) so testers can browse history.
  // Shared recipe 900001 gets its v1 from the schema backfill and is left
  // deliberately stale (shared copy = chicken, conversation's latest recipe
  // = tofu) so "Update shared copy" is active and the note flow is testable.
  await pool.query(
    `INSERT INTO shared_recipe_versions (shared_recipe_id, version, recipe_data, note, user_id, username)
     VALUES ($1, 1, $2, NULL, 900002, 'staging-demo-chef'),
            ($1, 2, $3, 'Swapped chicken for tofu to make it vegan', 900002, 'staging-demo-chef')
     ON CONFLICT (shared_recipe_id, version) DO NOTHING`,
    [900002, JSON.stringify(DEMO_RECIPE), JSON.stringify(DEMO_RECIPE_2)]
  );
  // The schema backfill runs before this seed on a fresh staging DB, so
  // give 900001 its v1 explicitly (same semantics, idempotent).
  await pool.query(
    `INSERT INTO shared_recipe_versions (shared_recipe_id, version, recipe_data, note, user_id, username)
     VALUES ($1, 1, $2, NULL, $3, 'staging-demo-user')
     ON CONFLICT (shared_recipe_id, version) DO NOTHING`,
    [900001, JSON.stringify(DEMO_RECIPE), DEMO_USER_ID]
  );

  await pool.query(
    `INSERT INTO recipe_ratings (shared_recipe_id, user_id, rating) VALUES
       (900001, 900101, 5),
       (900001, 900102, 4),
       (900002, 900103, 3)
     ON CONFLICT (shared_recipe_id, user_id) DO NOTHING`
  );
  log.info('db', 'Seeded staging shared recipes and ratings');

  // ── Social-features seeds (collections, cookbook, lineage, made-it,
  //    comments, tags, share slug) ─────────────────────────────────────

  // Fixed share slug for 900001 so dapp.json tests can hit /r/<slug>.
  await pool.query(
    `UPDATE shared_recipes SET share_slug = 'staging-demo-recipe' WHERE id = 900001`
  );
  // Tag mirror columns for the seeded shares (recipe_data already carries
  // the same tags via DEMO_RECIPE/DEMO_RECIPE_2).
  await pool.query(
    `UPDATE shared_recipes SET tags = $2::text[] WHERE id = $1`,
    [900001, DEMO_RECIPE.tags]
  );
  await pool.query(
    `UPDATE shared_recipes SET tags = $2::text[] WHERE id = $1`,
    [900002, DEMO_RECIPE_2.tags]
  );

  // Remix lineage: a third shared recipe forked from 900001 so the
  // "remixed from" credit line and remix list render.
  const DEMO_REMIX = {
    ...DEMO_RECIPE_2,
    title: 'Staging Demo Remixed Stir Fry',
    description: 'A remix of the staging demo stir fry, seeded to show lineage.',
    tags: ['chinese', 'dinner', 'vegan'],
  };
  await pool.query(
    `INSERT INTO shared_recipes
       (id, user_id, username, conversation_id, recipe_data, tags,
        forked_from_shared_id, forked_from_version, forked_from_username)
     VALUES (900005, 900005, 'staging-demo-remixer', 900005, $1, $2::text[], 900001, 1, 'staging-demo-user')
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(DEMO_REMIX), DEMO_REMIX.tags]
  );
  await pool.query(
    `INSERT INTO shared_recipe_versions (shared_recipe_id, version, recipe_data, note, user_id, username)
     VALUES (900005, 1, $1, NULL, 900005, 'staging-demo-remixer')
     ON CONFLICT (shared_recipe_id, version) DO NOTHING`,
    [JSON.stringify(DEMO_REMIX)]
  );

  // Collections — one concept, three states the UI must render (issue #34):
  //   900001 private, no members  → "Collection" (Invite people + Make public)
  //   900002 public               → "Public collection" (Public pill, comments)
  //   900003 private + 3 members  → "Shared collection · 3 members" + invite
  // 900001 also carries a snapshot-only item that simulates a deleted source.
  await pool.query(
    `INSERT INTO collections (id, user_id, username, name, description, visibility) VALUES
       (900001, 0, 'staging-demo-user', 'Staging Demo Weeknight', 'Quick dinners seeded for staging.', 'private'),
       (900002, 0, 'staging-demo-user', 'Staging Demo Community Picks', 'A public seeded collection.', 'public'),
       (900003, 0, 'staging-demo-user', 'Staging Demo Family Cookbook', 'Shared collection seeded for staging.', 'private')
     ON CONFLICT (id) DO NOTHING`
  );
  const SNAPSHOT_ONLY = {
    ...DEMO_RECIPE,
    title: 'Staging Demo Deleted-Source Casserole',
    description: 'Saved copy whose original shared recipe was deleted — renders from its snapshot.',
  };
  await pool.query(
    `INSERT INTO collection_items
       (id, collection_id, added_by_user_id, added_by_username, shared_recipe_id, conversation_id, recipe_snapshot, snapshot_title)
     VALUES
       (900001, 900001, 0, 'staging-demo-user', 900001, NULL, $1, $2),
       (900002, 900001, 0, 'staging-demo-user', NULL, NULL, $3, $4),
       (900003, 900002, 0, 'staging-demo-user', 900002, NULL, $5, $6),
       (900004, 900003, 0, 'staging-demo-user', NULL, 900001, $1, $2),
       (900005, 900003, 900101, 'staging-demo-cook', 900005, NULL, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      JSON.stringify(DEMO_RECIPE), DEMO_RECIPE.title,
      JSON.stringify(SNAPSHOT_ONLY), SNAPSHOT_ONLY.title,
      JSON.stringify(DEMO_RECIPE_2), DEMO_RECIPE_2.title,
      JSON.stringify(DEMO_REMIX), DEMO_REMIX.title,
    ]
  );
  await pool.query(
    `INSERT INTO collection_members (collection_id, user_id, username, role) VALUES
       (900003, 0, 'staging-demo-user', 'owner'),
       (900003, 900101, 'staging-demo-cook', 'member'),
       (900003, 900102, 'staging-demo-baker', 'member')
     ON CONFLICT (collection_id, user_id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO collection_invites (token, collection_id, created_by)
     VALUES ('staging-demo-invite', 900003, 0)
     ON CONFLICT (token) DO NOTHING`
  );

  // Made-it marks: cooked-counts + one note on the shared recipe, plus one
  // mark on the demo conversation for the "made 1×" box label.
  await pool.query(
    `INSERT INTO made_it_marks (id, user_id, username, shared_recipe_id, conversation_id, note) VALUES
       (900001, 900101, 'staging-demo-cook', 900001, NULL, 'Staging demo note: came out great, added extra ginger.'),
       (900002, 900102, 'staging-demo-baker', 900001, NULL, NULL),
       (900003, 900101, 'staging-demo-cook', 900001, NULL, NULL),
       (900004, 0, 'staging-demo-user', NULL, 900001, NULL)
     ON CONFLICT (id) DO NOTHING`
  );

  // Comments: one live, one soft-deleted (renders as "comment deleted").
  await pool.query(
    `INSERT INTO recipe_comments (id, shared_recipe_id, user_id, username, body, deleted_at) VALUES
       (900001, 900001, 900103, 'staging-demo-critic', 'Staging demo comment: worked perfectly on a weeknight.', NULL),
       (900002, 900001, 900102, 'staging-demo-baker', 'Staging demo deleted comment', NOW())
     ON CONFLICT (id) DO NOTHING`
  );

  // Collection comments (issue #35) — a brand-new table, so staging starts
  // empty and the thread would render blank without these. Two live rows on
  // the public collection plus one soft-deleted (proves the "comment
  // deleted" placeholder renders and stays out of the count), one on the
  // shared collection.
  await pool.query(
    `INSERT INTO collection_comments (id, collection_id, user_id, username, body, deleted_at) VALUES
       (900001, 900002, 900103, 'staging-demo-critic', 'Staging demo collection comment: great weeknight shelf.', NULL),
       (900002, 900002, 900102, 'staging-demo-baker', 'Staging demo deleted collection comment', NOW()),
       (900003, 900003, 900101, 'staging-demo-cook', 'Staging demo collection comment: adding Nan''s dumplings next.', NULL)
     ON CONFLICT (id) DO NOTHING`
  );
  log.info('db', 'Seeded staging collections, members, lineage, made-it and comments');

  // Shopping list demo (spec: staged against an otherwise empty staging DB).
  // Existence-checked because the table has no natural key. Quantities are
  // the merged form of the two demo stir fries plus two fake-source rows, so
  // /?list=1 renders a populated, merged, partially-checked screen. Runs
  // after the shared-recipe seed so shared_recipe_id = 900001 satisfies the
  // shopping_list_items FK.
  const { rows: listRows } = await pool.query(
    'SELECT 1 FROM shopping_list_items WHERE user_id = $1 LIMIT 1',
    [DEMO_USER_ID]
  );
  if (listRows.length === 0) {
    await pool.query(
      `INSERT INTO shopping_list_items
       (user_id, username, shared_recipe_id, conversation_id, recipe_title,
        category, name, grams, volume_amount, volume_unit, checked)
       VALUES
       ($1, $2, 900001, 900001, 'Staging Demo Chicken Stir Fry', 'produce', 'broccoli florets', 300, 3, 'cup', false),
       ($1, $2, 900001, 900001, 'Staging Demo Chicken Stir Fry', 'pantry', 'soy sauce', 32, 2, 'tbsp', false),
       ($1, $2, 900001, 900001, 'Staging Demo Chicken Stir Fry', 'meat', 'chicken breast, boneless skinless', 500, 0, '', true),
       ($1, $2, 900001, 900001, 'Staging Demo Chicken Stir Fry', 'pantry', 'extra-firm tofu', 400, 0, '', false),
       ($1, $2, 900001, 900001, 'Staging Demo Chicken Stir Fry', 'pantry', 'salt', 6, 1, 'tsp', false),
       ($1, $2, NULL, NULL, 'Staging demo weekly shopping', 'dairy', 'whole milk', 480, 2, 'cup', false),
       ($1, $2, NULL, NULL, 'Staging demo weekly shopping', 'produce', 'cherry tomatoes', 300, 1, 'pint', false)`,
      [DEMO_USER_ID, 'staging-demo-user']
    );
    log.info('db', 'Seeded staging demo shopping list');
  }

  // Demo AI-usage row for the user-menu "AI usage today" meter (llm_usage is
  // staging:private, so staging starts empty). Seeded fresh for *today*
  // (UTC) each boot so it never goes stale; the upsert SETs fixed values
  // rather than accumulating, so reboots don't inflate it. 45k in / 12k out
  // at Sonnet 5 pricing = 31,500,000 microcents ≈ $0.32.
  await pool.query(
    `INSERT INTO llm_usage (user_id, date, input_tokens, output_tokens, estimated_microcents)
     VALUES ($1, (NOW() AT TIME ZONE 'utc')::date, 45000, 12000, 31500000)
     ON CONFLICT (user_id, date) DO UPDATE SET
       input_tokens = EXCLUDED.input_tokens,
       output_tokens = EXCLUDED.output_tokens,
       estimated_microcents = EXCLUDED.estimated_microcents`,
    [DEMO_USER_ID]
  );
  log.info('db', 'Seeded staging demo llm_usage row');
}

module.exports = { migrate, DEMO_USER_ID };
