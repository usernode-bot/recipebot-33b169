// Creator tags: suggested vocabulary across four axes (cuisine, diet,
// course, method) plus free-form. The AI proposes tags during generation
// (see llm.js); the creator confirms them at publish time; the confirmed
// set is mirrored into shared_recipes.tags for feed filtering.
const SUGGESTED_TAGS = {
  cuisine: ['italian', 'mexican', 'indian', 'chinese', 'japanese', 'thai', 'french', 'middle eastern', 'ethiopian', 'american'],
  diet: ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'high-protein', 'low-carb'],
  course: ['breakfast', 'lunch', 'dinner', 'dessert', 'snack', 'side', 'drink'],
  method: ['one-pot', 'no-oven', 'grill', 'slow-cook', 'air-fryer', 'no-cook', 'baking'],
};

const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 32;

// Normalize a client- or model-supplied tag list: strings only, trimmed,
// lowercased, deduped, length-capped. Returns [] for anything unusable.
function sanitizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

module.exports = { SUGGESTED_TAGS, sanitizeTags, MAX_TAGS, MAX_TAG_LENGTH };
