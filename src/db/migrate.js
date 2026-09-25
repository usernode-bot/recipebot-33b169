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

// Issue #63: a wider world tour of demo recipes so staging previews show
// many cuisines (and, with the cuisine-tinted chips in home.js, many hues).
// Same rules as every seed here: fixed high IDs, ON CONFLICT DO NOTHING,
// obviously fake "Staging demo" titles, fake identities only. Realistic
// content is deliberate — a tester should see recipes they'd actually cook.
const DEMO_CUISINE_RECIPES = [
  {
    id: 910001,
    username: 'staging-demo-nonna',
    title: 'Staging Demo Cacio e Pepe',
    description: 'Four ingredients, Roman comfort food. The sauce comes together entirely from starchy pasta water and pecorino.',
    servings: 2,
    prep: '5 min',
    cook: '12 min',
    tags: ['italian', 'vegetarian', 'pasta'],
    steps: [
      { title: 'Boil the pasta',
        description: 'Cook the spaghetti in well-salted water until just shy of al dente, about 8 minutes. Reserve a mug of pasta water.',
        temperature_f: null,
        ingredients: [{ name: 'spaghetti', grams: 220, volume: { amount: 8, unit: 'oz' },
          macros: { calories: 820, protein_g: 29, carbs_g: 164, fat_g: 3, fiber_g: 6 } }] },
      { title: 'Build the sauce',
        description: 'Toast the pepper in a dry pan until fragrant, then add pasta water and bring to a simmer.',
        temperature_f: null,
        ingredients: [{ name: 'black peppercorns, coarsely ground', grams: 4, volume: { amount: 2, unit: 'tsp' },
          macros: { calories: 10, protein_g: 0.4, carbs_g: 2, fat_g: 0.2, fiber_g: 0.8 } }] },
      { title: 'Emulsify',
        description: 'Off heat, toss the pasta with the pecorino and the pepper water until glossy, adding splashes of pasta water as needed.',
        temperature_f: null,
        ingredients: [{ name: 'pecorino romano, finely grated', grams: 90, volume: { amount: 1.5, unit: 'cup' },
          macros: { calories: 390, protein_g: 34, carbs_g: 3, fat_g: 27, fiber_g: 0 } }] },
    ],
  },
  {
    id: 910002,
    username: 'staging-demo-nonna',
    title: 'Staging Demo Mushroom Risotto',
    description: 'Slow-stirred arborio with roasted cremini mushrooms and a finishing spoon of butter.',
    servings: 4,
    prep: '10 min',
    cook: '35 min',
    tags: ['italian', 'vegetarian', 'rice'],
    steps: [
      { title: 'Roast the mushrooms',
        description: 'Toss the cremini with oil and salt and roast until browned, about 20 minutes.',
        temperature_f: 425,
        ingredients: [{ name: 'cremini mushrooms, quartered', grams: 350, volume: { amount: 4, unit: 'cup' },
          macros: { calories: 105, protein_g: 12, carbs_g: 8, fat_g: 1, fiber_g: 3 } },
          { name: 'olive oil', grams: 14, volume: { amount: 1, unit: 'tbsp' },
          macros: { calories: 120, protein_g: 0, carbs_g: 0, fat_g: 14, fiber_g: 0 } }] },
      { title: 'Sweat and toast',
        description: 'Soft onion in butter, then stir the arborio through until the grains look glassy at the edges.',
        temperature_f: null,
        ingredients: [{ name: 'arborio rice', grams: 320, volume: { amount: 1.75, unit: 'cup' },
          macros: { calories: 1170, protein_g: 22, carbs_g: 254, fat_g: 4, fiber_g: 4 } },
          { name: 'yellow onion, diced', grams: 110, volume: { amount: 1, unit: 'cup' },
          macros: { calories: 44, protein_g: 1.2, carbs_g: 10, fat_g: 0.1, fiber_g: 1.9 } }] },
      { title: 'Add stock in waves',
        description: 'Add warm vegetable stock a ladle at a time, stirring until absorbed before the next, until the rice is creamy and just set, about 18 minutes.',
        temperature_f: null,
        ingredients: [{ name: 'vegetable stock', grams: 1000, volume: { amount: 4, unit: 'cup' },
          macros: { calories: 40, protein_g: 2, carbs_g: 8, fat_g: 0, fiber_g: 0 } }] },
      { title: 'Finish',
        description: 'Fold in the roasted mushrooms, the parmesan and the butter; rest one minute off heat before serving.',
        temperature_f: null,
        ingredients: [{ name: 'parmesan, grated', grams: 50, volume: { amount: 0.5, unit: 'cup' },
          macros: { calories: 215, protein_g: 17, carbs_g: 2, fat_g: 14, fiber_g: 0 } }] },
    ],
  },
  {
    id: 910003,
    username: 'staging-demo-sichuan',
    title: 'Staging Demo Mapo Tofu',
    description: 'Silken tofu in a doubanjiang chili-bean sauce, numbing with Sichuan pepper, finished with scallion.',
    servings: 3,
    prep: '10 min',
    cook: '15 min',
    tags: ['chinese', 'dinner', 'spicy', 'vegan'],
    steps: [
      { title: 'Blanch the tofu',
        description: 'Cube the silken tofu and slip it into salted simmering water for 2 minutes; hold in the warm water.',
        temperature_f: 212,
        ingredients: [{ name: 'silken tofu', grams: 600, volume: { amount: 3, unit: 'cup' },
          macros: { calories: 480, protein_g: 54, carbs_g: 18, fat_g: 26, fiber_g: 4 } }] },
      { title: 'Fry the aromatics',
        description: 'Bloom the doubanjiang and the fermented black beans in hot oil until the oil turns red, then add garlic and ginger.',
        temperature_f: 375,
        ingredients: [{ name: 'chili bean sauce (doubanjiang)', grams: 30, volume: { amount: 3, unit: 'tbsp' },
          macros: { calories: 40, protein_g: 3, carbs_g: 4, fat_g: 1, fiber_g: 1 } }] },
      { title: 'Simmer together',
        description: 'Add stock and the drained tofu; simmer 5 minutes, starch to gloss, and shower with ground Sichuan pepper and scallion.',
        temperature_f: null,
        ingredients: [{ name: 'vegetable stock', grams: 250, volume: { amount: 1, unit: 'cup' },
          macros: { calories: 10, protein_g: 0.5, carbs_g: 2, fat_g: 0, fiber_g: 0 } }] },
    ],
  },
  {
    id: 910004,
    username: 'staging-demo-shakshuka',
    title: 'Staging Demo Shakshuka',
    description: 'Eggs poached in a smoky tomato and pepper stew, straight from the pan with bread.',
    servings: 2,
    prep: '10 min',
    cook: '25 min',
    tags: ['middle-eastern', 'breakfast', 'vegetarian'],
    steps: [
      { title: 'Soften the base',
        description: 'Cook onion and peppers in olive oil until limp and sweet, about 10 minutes.',
        temperature_f: null,
        ingredients: [{ name: 'red bell pepper, sliced', grams: 150, volume: { amount: 1, unit: 'cup' },
          macros: { calories: 46, protein_g: 1.5, carbs_g: 9, fat_g: 0.4, fiber_g: 3.1 } }] },
      { title: 'Build the stew',
        description: 'Add cumin and paprika, then the crushed tomatoes; simmer until thickened, about 12 minutes.',
        temperature_f: null,
        ingredients: [{ name: 'crushed tomatoes', grams: 400, volume: { amount: 1.75, unit: 'cup' },
          macros: { calories: 130, protein_g: 6, carbs_g: 28, fat_g: 1, fiber_g: 8 } }] },
      { title: 'Poach the eggs',
        description: 'Make wells, crack in the eggs, cover and cook until the whites set and yolks still run, 6 to 8 minutes.',
        temperature_f: null,
        ingredients: [{ name: 'eggs', grams: 220, volume: { amount: 4, unit: 'large' },
          macros: { calories: 315, protein_g: 25, carbs_g: 2, fat_g: 21, fiber_g: 0 } }] },
    ],
  },
  {
    id: 910005,
    username: 'staging-demo-masala',
    title: 'Staging Demo Chana Masala',
    description: 'Chickpeas simmered in a gingery tomato gravy, warm with garam masala and finished with lemon.',
    servings: 4,
    prep: '10 min',
    cook: '30 min',
    tags: ['indian', 'vegan', 'dinner'],
    steps: [
      { title: 'Bloom the spices',
        description: 'Fry onion until deep gold, then add garlic, ginger, cumin, coriander and turmeric until fragrant.',
        temperature_f: null,
        ingredients: [{ name: 'yellow onion, diced', grams: 150, volume: { amount: 1, unit: 'cup' },
          macros: { calories: 60, protein_g: 1.7, carbs_g: 14, fat_g: 0.2, fiber_g: 2.9 } }] },
      { title: 'Simmer the curry',
        description: 'Add tomatoes and the drained chickpeas; simmer until the gravy coats a spoon, about 20 minutes.',
        temperature_f: null,
        ingredients: [{ name: 'chickpeas, cooked', grams: 720, volume: { amount: 4, unit: 'cup' },
          macros: { calories: 960, protein_g: 52, carbs_g: 160, fat_g: 14, fiber_g: 44 } },
          { name: 'diced tomatoes', grams: 400, volume: { amount: 1.75, unit: 'cup' },
          macros: { calories: 80, protein_g: 4, carbs_g: 18, fat_g: 0.8, fiber_g: 4 } }] },
      { title: 'Finish and serve',
        description: 'Stir in garam masala, squeeze in lemon and top with cilantro. Serve with rice or flatbread.',
        temperature_f: null,
        ingredients: [{ name: 'garam masala', grams: 4, volume: { amount: 2, unit: 'tsp' },
          macros: { calories: 10, protein_g: 0.4, carbs_g: 2, fat_g: 0.1, fiber_g: 0.6 } }] },
    ],
  },
  {
    id: 910006,
    username: 'staging-demo-limeleaf',
    title: 'Staging Demo Green Curry Chicken',
    description: 'Thai green curry with chicken, bamboo shoots and Thai basil in coconut cream.',
    servings: 4,
    prep: '15 min',
    cook: '25 min',
    tags: ['thai', 'dinner', 'spicy'],
    steps: [
      { title: 'Fry the curry paste',
        description: 'Crack the coconut cream in a hot wok until the oil separates, then fry the green curry paste until fragrant.',
        temperature_f: null,
        ingredients: [{ name: 'Thai green curry paste', grams: 70, volume: { amount: 4, unit: 'tbsp' },
          macros: { calories: 70, protein_g: 2, carbs_g: 8, fat_g: 3, fiber_g: 2 } }] },
      { title: 'Build the curry',
        description: 'Add chicken to seal, then coconut milk, fish sauce and palm sugar; simmer 10 minutes.',
        temperature_f: null,
        ingredients: [{ name: 'chicken thigh, boneless, sliced', grams: 450, volume: { amount: 2, unit: 'cup' },
          macros: { calories: 740, protein_g: 100, carbs_g: 0, fat_g: 33, fiber_g: 0 } },
          { name: 'coconut milk', grams: 400, volume: { amount: 1.75, unit: 'cup' },
          macros: { calories: 710, protein_g: 7, carbs_g: 12, fat_g: 70, fiber_g: 0 } }] },
      { title: 'Vegetables and basil',
        description: 'Add bamboo shoots and bell pepper for 5 minutes; off heat, fold in Thai basil and serve with jasmine rice.',
        temperature_f: null,
        ingredients: [{ name: 'bamboo shoots, sliced', grams: 200, volume: { amount: 1.5, unit: 'cup' },
          macros: { calories: 54, protein_g: 3.6, carbs_g: 8, fat_g: 0.4, fiber_g: 4 } }] },
    ],
  },
  {
    id: 910007,
    username: 'staging-demo-spicecaravan',
    title: 'Staging Demo Vegetable Tagine',
    description: 'Slow-simmered squash, carrots and chickpeas under a lid of cumin, cinnamon and preserved lemon.',
    servings: 4,
    prep: '20 min',
    cook: '45 min',
    tags: ['moroccan', 'vegan', 'one-pot'],
    steps: [
      { title: 'Layer the tagine',
        description: 'Onion and garlic beneath, carrots and squash above, spices scattered over the top.',
        temperature_f: null,
        ingredients: [{ name: 'butternut squash, cubed', grams: 600, volume: { amount: 4, unit: 'cup' },
          macros: { calories: 270, protein_g: 6, carbs_g: 66, fat_g: 0.6, fiber_g: 12 } },
          { name: 'carrots, sliced', grams: 200, volume: { amount: 1.5, unit: 'cup' },
          macros: { calories: 82, protein_g: 1.9, carbs_g: 19, fat_g: 0.5, fiber_g: 5.6 } }] },
      { title: 'Cook low and slow',
        description: 'Add stock, cover and simmer gently until the vegetables are tender and the sauce is syrupy, about 40 minutes.',
        temperature_f: null,
        ingredients: [{ name: 'vegetable stock', grams: 350, volume: { amount: 1.5, unit: 'cup' },
          macros: { calories: 14, protein_g: 0.7, carbs_g: 3, fat_g: 0, fiber_g: 0 } }] },
      { title: 'Finish bright',
        description: 'Stir in chickpeas to warm, then lift with lemon juice, apricots and toasted almonds.',
        temperature_f: null,
        ingredients: [{ name: 'chickpeas, cooked', grams: 360, volume: { amount: 2, unit: 'cup' },
          macros: { calories: 480, protein_g: 26, carbs_g: 80, fat_g: 7, fiber_g: 22 } }] },
    ],
  },
  {
    id: 910008,
    username: 'staging-demo-deli',
    title: 'Staging Demo Smash Burger',
    description: 'Thin patties smashed on a screaming-hot griddle, lacy edges, American cheese, squished under a soft bun.',
    servings: 2,
    prep: '10 min',
    cook: '10 min',
    tags: ['american', 'dinner', 'grill'],
    steps: [
      { title: 'Ball the beef',
        description: 'Divide the beef into four loose balls; do not compact them.',
        temperature_f: null,
        ingredients: [{ name: 'ground beef, 20% fat', grams: 450, volume: { amount: 1, unit: 'lb' },
          macros: { calories: 1120, protein_g: 90, carbs_g: 0, fat_g: 81, fiber_g: 0 } }] },
      { title: 'Smash hard',
        description: 'On a 400-degree griddle, smash each ball flat for 10 seconds; season and cook until the edge crust is deep brown.',
        temperature_f: 400,
        ingredients: [{ name: 'salt', grams: 4, volume: { amount: 0.75, unit: 'tsp' },
          macros: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 } }] },
      { title: 'Flip once, dress',
        description: 'Flip, lay on cheese, and stack on toasted potato buns with pickles and special sauce.',
        temperature_f: null,
        ingredients: [{ name: 'American cheese slices', grams: 60, volume: { amount: 4, unit: 'slice' },
          macros: { calories: 240, protein_g: 12, carbs_g: 8, fat_g: 18, fiber_g: 0 } }] },
    ],
  },
  {
    id: 910009,
    username: 'staging-demo-aegean',
    title: 'Staging Demo Greek Lemon Orzo Salad',
    description: 'Chilled orzo tossed with cucumber, feta, olives and a lemon-oregano dressing.',
    servings: 4,
    prep: '15 min',
    cook: '12 min',
    tags: ['greek', 'lunch', 'vegetarian', 'cold'],
    steps: [
      { title: 'Cook the orzo',
        description: 'Boil the orzo until just tender, drain and rinse briefly under cold water.',
        temperature_f: 212,
        ingredients: [{ name: 'orzo', grams: 300, volume: { amount: 1.75, unit: 'cup' },
          macros: { calories: 640, protein_g: 22, carbs_g: 132, fat_g: 3, fiber_g: 6 } }] },
      { title: 'Whisk the dressing',
        description: 'Emulsify lemon juice, oregano and olive oil with a pinch of salt.',
        temperature_f: null,
        ingredients: [{ name: 'olive oil', grams: 60, volume: { amount: 4.5, unit: 'tbsp' },
          macros: { calories: 530, protein_g: 0, carbs_g: 0, fat_g: 60, fiber_g: 0 } }] },
      { title: 'Toss and chill',
        description: 'Fold through cucumber, red onion, olives and feta; chill 30 minutes before serving.',
        temperature_f: null,
        ingredients: [{ name: 'feta, crumbled', grams: 120, volume: { amount: 1, unit: 'cup' },
          macros: { calories: 320, protein_g: 16, carbs_g: 4, fat_g: 26, fiber_g: 0 } }] },
    ],
  },
  {
    id: 910010,
    username: 'staging-demo-patisserie',
    title: 'Staging Demo Coq au Vin',
    description: 'Chicken braised in red wine with pearl onions, mushrooms and lardons until spoon-tender.',
    servings: 4,
    prep: '25 min',
    cook: '60 min',
    tags: ['french', 'dinner', 'braise'],
    steps: [
      { title: 'Render the lardons',
        description: 'Crisp the bacon in the Dutch oven; brown the chicken in the fat in two batches.',
        temperature_f: null,
        ingredients: [{ name: 'chicken thighs, bone-in', grams: 900, volume: { amount: 6, unit: 'piece' },
          macros: { calories: 1620, protein_g: 180, carbs_g: 0, fat_g: 90, fiber_g: 0 } }] },
      { title: 'Braise',
        description: 'Deglaze with the red wine, add pearl onions, mushrooms, garlic and thyme; cover and braise until tender.',
        temperature_f: 325,
        ingredients: [{ name: 'red cooking wine', grams: 500, volume: { amount: 2, unit: 'cup' },
          macros: { calories: 250, protein_g: 0.3, carbs_g: 8, fat_g: 0, fiber_g: 0 } }] },
      { title: 'Reduce and glaze',
        description: 'Lift out the chicken, reduce the sauce to a gloss and mount with beurre manie; return the chicken and serve.',
        temperature_f: null,
        ingredients: [{ name: 'cremini mushrooms, halved', grams: 250, volume: { amount: 3, unit: 'cup' },
          macros: { calories: 55, protein_g: 8, carbs_g: 4, fat_g: 0.7, fiber_g: 1.5 } }] },
    ],
  },
  {
    id: 910011,
    username: 'staging-demo-izakaya',
    title: 'Staging Demo Miso Ginger Salmon',
    description: 'Broiled salmon fillets lacquered with white miso, sake and ginger glaze.',
    servings: 2,
    prep: '10 min',
    cook: '15 min',
    tags: ['japanese', 'dinner', 'fish'],
    steps: [
      { title: 'Mix the glaze',
        description: 'Whisk miso, sake, mirin, sugar and grated ginger into a thick paste.',
        temperature_f: null,
        ingredients: [{ name: 'white miso paste', grams: 55, volume: { amount: 3, unit: 'tbsp' },
          macros: { calories: 90, protein_g: 6, carbs_g: 14, fat_g: 1, fiber_g: 2 } }] },
      { title: 'Marinate',
        description: 'Coat the salmon and rest 30 minutes (or overnight for a deeper cure).',
        temperature_f: null,
        ingredients: [{ name: 'salmon fillets', grams: 300, volume: { amount: 2, unit: 'fillet' },
          macros: { calories: 590, protein_g: 62, carbs_g: 0, fat_g: 36, fiber_g: 0 } }] },
      { title: 'Broil to lacquer',
        description: 'Broil skin-side down until the glaze blisters and the center is just translucent at 130 F internal.',
        temperature_f: 500,
        ingredients: [{ name: 'scallion, thinly sliced', grams: 15, volume: { amount: 2, unit: 'tbsp' },
          macros: { calories: 5, protein_g: 0.3, carbs_g: 1, fat_g: 0, fiber_g: 0.4 } }] },
    ],
  },
];

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

  // Issue #63: the wider world-tour batch. Each recipe lives in its own
  // demo conversation (shared_recipes requires one per owner+conversation)
  // and is published to the community feed from a distinct fake identity.
  const CUISINE_CONV_BASE = 910100;
  for (let i = 0; i < DEMO_CUISINE_RECIPES.length; i++) {
    const entry = DEMO_CUISINE_RECIPES[i];
    const convId = CUISINE_CONV_BASE + i;
    const sharedId = entry.id;
    await pool.query(
      `INSERT INTO conversations (id, user_id, title, preferences, created_at)
       VALUES ($1, $2, $3, $4, NOW() - $5::interval)
       ON CONFLICT (id) DO NOTHING`,
      [convId, DEMO_USER_ID, `Staging demo — ${entry.title}`,
       JSON.stringify({ complexity: 'normal', serving: 'normal' }), `${3 + i} days`]
    );
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, recipe_data, created_at) VALUES
       ($1, 'user', $2, NULL, NOW() - $5::interval - interval '3 min'),
       ($1, 'assistant', $3, $4, NOW() - $5::interval)`,
      [convId, `Staging demo: cook me ${entry.title.replace(/^Staging Demo /, '')}`,
       `[Recipe: ${entry.title}]`, JSON.stringify(entry), `${3 + i} days`]
    );
    await pool.query(
      `INSERT INTO shared_recipes (id, user_id, username, conversation_id, recipe_data, tags, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], NOW() - $7::interval, NOW() - $7::interval)
       ON CONFLICT (id) DO NOTHING`,
      [sharedId, DEMO_USER_ID, entry.username, convId, JSON.stringify(entry),
       entry.tags, `${3 + i} days`]
    );
    // v1 so version history reads correctly (the schema backfill only runs
    // when the shared row has NO versions yet, so only truly fresh rows need this).
    await pool.query(
      `INSERT INTO shared_recipe_versions (shared_recipe_id, version, recipe_data, user_id, username)
       SELECT $1, 1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM shared_recipe_versions WHERE shared_recipe_id = $1)
       ON CONFLICT (shared_recipe_id, version) DO NOTHING`,
      [sharedId, JSON.stringify(entry), DEMO_USER_ID, entry.username]
    );
  }
  log.info('db', 'Seeded staging world-tour recipe batch');

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
