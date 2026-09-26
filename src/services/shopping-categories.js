// Grocery-category mapping for the shopping list. One shared helper so the
// server routes (and any future client-side preview) use the SAME mapping.
//
// Match is a substring test over the lowercased ingredient name. Lists are
// evaluated in order: the first matching category wins, so "bell pepper"
// (produce) beats the bare "pepper" keyword in pantry, "soy sauce" (pantry)
// beats the bare "sauce" keyword, and "eggplant" beats the egg/egg-word
// rules in dairy. "tofu" deliberately lands in Pantry (shelf-stable protein).
const PRODUCE = [
  'bell pepper', 'chili', 'jalape', 'broccoli', 'onion', 'garlic', 'tomato',
  'carrot', 'spinach', 'lettuce', 'potato', 'lemon', 'lime', 'apple', 'banana',
  'berry', 'cucumber', 'celery', 'mushroom', 'avocado', 'kale', 'ginger',
  'scallion', 'parsley', 'cilantro', 'basil', 'zucchini', 'corn', 'squash',
  'cabbage',
];
const DAIRY = [
  'milk', 'cheese', 'butter', 'yogurt', 'yoghurt', 'cream', 'mozzarella',
  'parmesan',
];
const MEAT = [
  'chicken', 'beef', 'pork', 'turkey', 'bacon', 'sausage', 'lamb', 'fish',
  'shrimp', 'salmon', 'tuna', 'steak', 'ground',
];
const PANTRY = [
  'salt', 'pepper', 'oil', 'flour', 'sugar', 'rice', 'pasta', 'noodle',
  'soy sauce', 'vinegar', 'baking', 'spice', 'seasoning', 'stock', 'broth',
  'sauce', 'tofu', 'honey', 'mustard', 'oats', 'bread',
];

// Fixed display order used by the list API and the screen.
const ORDER = ['produce', 'dairy', 'meat', 'pantry', 'other'];

function categorizeIngredient(name) {
  const hay = String(name || '').toLowerCase();
  if (!hay) return 'other';
  if (PRODUCE.some((k) => hay.includes(k))) return 'produce';
  if (/\beggplant\b/.test(hay)) return 'produce';
  if (DAIRY.some((k) => hay.includes(k.trim())) || /\beggs?\b/.test(hay)) return 'dairy';
  if (MEAT.some((k) => hay.includes(k.trim())) || /\bham\b/.test(hay)) return 'meat';
  if (PANTRY.some((k) => hay.includes(k))) return 'pantry';
  return 'other';
}

module.exports = { categorizeIngredient, ORDER };
