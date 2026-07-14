const fs = require('fs');
const path = require('path');
const { getPool } = require('./pool');
const log = require('../services/logger');

// Sentinel owner for staging demo rows. In staging, list endpoints include
// this user's rows so testers see a populated sidebar/recipe panel.
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
}

const DEMO_RECIPE = {
  version: 1,
  title: 'Staging Demo Chicken Stir Fry',
  description: 'A quick weeknight stir fry seeded for staging previews.',
  default_servings: 4,
  prep_time: '15 min',
  cook_time: '10 min',
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
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, recipe_data) VALUES
       ($1, 'user', 'Staging demo: make me a quick chicken stir fry', NULL),
       ($1, 'assistant', 'Here''s a quick weeknight chicken stir fry — ready in about 25 minutes.', NULL),
       ($1, 'assistant', '[Recipe: Staging Demo Chicken Stir Fry]', $2),
       ($1, 'user', 'Staging demo: now make it vegan', NULL),
       ($1, 'assistant', 'Swapped the chicken for extra-firm tofu.', NULL),
       ($1, 'assistant', '[Recipe: Staging Demo Tofu Stir Fry]', $3)`,
      [DEMO_CONV_ID, JSON.stringify(DEMO_RECIPE), JSON.stringify(DEMO_RECIPE_2)]
    );
    log.info('db', 'Seeded staging demo conversation');
  }
}

module.exports = { migrate, DEMO_USER_ID };
