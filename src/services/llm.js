const log = require('./logger');

// User-selectable chat models. Alias IDs only (no date suffixes) — this list
// is the single source of truth for the settings picker, the preferences
// PATCH validator, and the per-message model resolution in the chat route.
const MODELS = [
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    description: 'Best all-around quality. Recommended.',
    default: true,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    description: 'Fastest and cheapest — good for simple recipes.',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    description: 'Most capable, slower and uses more of your daily AI budget.',
  },
];

const DEFAULT_MODEL = MODELS.find((m) => m.default).id;

// Standard list prices in dollars per million tokens, used to estimate the
// user's daily spend ("AI usage today" in the user menu). The platform proxy
// does its own billing, so this is an estimate — standard (non-introductory)
// prices are used deliberately as a conservative over-estimate.
const MODEL_PRICING = {
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-4-8': { input: 5, output: 25 },
};

// Estimate the cost of one Messages API response in microcents (1e-6 cents),
// from its `usage` block. P $/MTok works out to exactly P*100 microcents per
// token, so accumulation stays integer-exact.
// Cache reads bill at 0.1x input rate, cache writes at 1.25x (unused today,
// but the fields cost nothing to handle). Unknown models fall back to
// Sonnet 5 pricing.
function estimateMicrocents(model, usage) {
  if (!usage) return 0;
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-5'];
  const inputMicrocentsPerTok = pricing.input * 100;
  const outputMicrocentsPerTok = pricing.output * 100;
  const cost =
    (usage.input_tokens || 0) * inputMicrocentsPerTok +
    (usage.output_tokens || 0) * outputMicrocentsPerTok +
    (usage.cache_read_input_tokens || 0) * inputMicrocentsPerTok * 0.1 +
    (usage.cache_creation_input_tokens || 0) * inputMicrocentsPerTok * 1.25;
  return Math.round(cost);
}

function isValidModel(id) {
  return typeof id === 'string' && MODELS.some((m) => m.id === id);
}

// Supported UI languages (code → English name for the prompt directive).
// Mirrors the client-side list in public/js/i18n.js — keep the two in sync
// when adding a language.
const SUPPORTED_LANGUAGES = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  id: 'Indonesian',
};

// Map the platform's BCP-47 locale tag (the JWT `locale` claim — "id",
// "pt-BR", or null when unset) onto a shipped language code by
// language-subtag prefix. Returns null when nothing matches or no
// preference is set.
function resolveLocale(tag) {
  if (typeof tag !== 'string' || !tag) return null;
  const sub = tag.split('-')[0].toLowerCase();
  return Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, sub) ? sub : null;
}

// Haiku 4.5 (and older dated snapshots) still take the pre-4.6 thinking shape
// `{type: 'enabled', budget_tokens}`. Sonnet 5 / Opus 4.8 reject budget_tokens
// and non-default sampling params with a 400 — they use adaptive thinking.
function usesLegacyThinking(model) {
  return /haiku|-4-5-|sonnet-4-5|opus-4-5/.test(model);
}

// LLM access resolution order:
//   1. Platform LLM proxy (production; billed to the user's AI budget)
//   2. Direct Anthropic API via optional ANTHROPIC_API_KEY secret
//      (lets the owner enable chat on staging or standalone deploys)
//   3. Disabled — chat returns a clear "unavailable" message.
function isEnabled(config) {
  return !!(config.llmProxyToken || config.anthropicApiKey);
}

function llmMode(config) {
  if (config.llmProxyToken && config.llmProxyUrl) return 'proxy';
  if (config.anthropicApiKey) return 'direct';
  return 'disabled';
}

// Hard ceiling on a single Messages API call. The proxy/upstream can stall
// indefinitely on rare occasions; without a bound the background reply loop
// hangs forever and the client spinner never resolves. Callers can pass a
// tighter `timeoutMs` (e.g. the recipe fix-up retry).
const LLM_TIMEOUT_MS = 120_000;

// Non-streaming Messages API call. `userToken` is the requester's platform
// JWT, forwarded so the proxy can bill/authorize the right user.
async function createMessage(config, params, userToken, { timeoutMs = LLM_TIMEOUT_MS } = {}) {
  const mode = llmMode(config);

  if (mode === 'disabled') {
    const err = new Error('LLM disabled');
    err.code = 'llm_unavailable';
    err.userMessage = 'AI features are unavailable in this environment.';
    throw err;
  }

  const url = mode === 'proxy'
    ? `${config.llmProxyUrl}/v1/messages`
    : 'https://api.anthropic.com/v1/messages';
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (mode === 'proxy') {
    headers['x-usernode-app-token'] = config.llmProxyToken;
    headers['x-usernode-user-token'] = userToken || '';
  } else {
    headers['x-api-key'] = config.anthropicApiKey;
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    log.error('llm', timedOut ? 'Messages API call timed out' : 'Messages API request failed', {
      mode,
      timeout_ms: timeoutMs,
      error: e.message,
    });
    const err = new Error(timedOut
      ? `LLM request timed out after ${timeoutMs}ms`
      : `LLM request failed: ${e.message}`);
    err.code = timedOut ? 'timeout' : 'network_error';
    err.userMessage = timedOut
      ? 'The AI request timed out. Please try again.'
      : 'The AI request failed. Please try again.';
    throw err;
  }

  if (!resp.ok) {
    let body = null;
    try { body = await resp.json(); } catch {}
    const code = body?.code || body?.error?.type || '';
    log.error('llm', 'Messages API error', { status: resp.status, code, mode });

    // Always carry a machine-readable code so the client can render the
    // error in the user's language; 'llm_failed' is the generic fallback.
    const err = new Error(`LLM request failed (${resp.status})`);
    err.code = code || 'llm_failed';
    if (code === 'grant_required') {
      err.userMessage = 'RecipeBot needs your permission to use AI. Approve access when prompted, then send your message again.';
    } else if (code === 'app_cap_exceeded') {
      err.userMessage = 'Your daily AI cap for RecipeBot is spent — it resets at midnight UTC.';
    } else if (code === 'budget_exceeded') {
      err.userMessage = 'Your overall daily AI budget is exhausted — it resets at midnight UTC.';
    } else {
      err.userMessage = 'The AI request failed. Please try again.';
    }
    throw err;
  }

  return resp.json();
}

const SYSTEM_PROMPT = `You are a friendly, knowledgeable cooking assistant. Your role is to help users discover, create, and refine recipes.

## CRITICAL: How to present recipes

You MUST ALWAYS call the display_recipe tool to show recipes. NEVER write out a recipe in your text response — the user cannot see recipes unless you call the tool. Writing a recipe in text instead of calling the tool is a failure.

When calling display_recipe, every step must include:
- title: 1-3 word step title (e.g. "Sear chicken", "Make sauce", "Rest & serve")
- description: Full step instructions
- temperature_f: oven/cooking temperature in Fahrenheit (or null)
- ingredients: array with name, grams, volume {amount, unit}, and macros {calories, protein_g, carbs_g, fat_g, fiber_g} for each

Also include at the top level: version (always 1), title, description, default_servings, prep_time, cook_time, and notes if relevant.

Also propose 2-6 tags for the recipe in the top-level "tags" array (lowercase). Pick from these suggested vocabularies where they fit, plus free-form tags when needed:
- cuisine: italian, mexican, indian, chinese, japanese, thai, french, middle eastern, ethiopian, american
- diet: vegetarian, vegan, gluten-free, dairy-free, high-protein, low-carb
- course: breakfast, lunch, dinner, dessert, snack, side, drink
- method: one-pot, no-oven, grill, slow-cook, air-fryer, no-cook, baking
The user confirms tags when they publish, so propose your best guess.

If the recipe produces naturally countable items (tacos, cookies, mozzarella sticks, pancakes, etc.), include serving_item with count (items per serving) and name (plural item name). Omit serving_item for recipes like soups, stews, bowls, or anything not naturally counted.

Use common US volume units (tsp, tbsp, cup, etc.). Provide accurate macro estimates for every ingredient.

IMPORTANT: In step descriptions, NEVER include specific amounts or measurements for ingredients. Write "the water" not "60ml of water", "the flour" not "2 cups of flour", "the garlic" not "3 cloves of garlic". The ingredient list next to each step already shows the exact amounts, and those amounts update when the user changes servings — hardcoded amounts in descriptions would become wrong.

When a step uses the output of a previous step as an ingredient (e.g. "prepared dough", "sauce from step 2"), set from_step: true and set ALL macros to 0. The macros are already counted from the original raw ingredients — do not double-count them.

## Research tools

- web_search: Search the web for recipes, techniques, or ingredient info. Use proactively when you'd benefit from checking real sources — comparing approaches, verifying amounts, or finding inspiration.
- fetch_webpage: Read a specific URL. Use when the user pastes a link, or to follow up on a promising search result.

A good pattern: search first, read 1-2 of the best results, then synthesize into your recipe. You don't need to search for simple/common recipes, but do search when the user asks for something specific, unusual, or when accuracy matters (e.g. baking ratios, fermentation times, regional dishes).

## Guidelines

- Be conversational but concise in your text responses. Keep your message short — the recipe itself goes in the tool call, not your message.
- When modifying an existing recipe, make MINIMAL changes — only change the parts the user asked about. Keep all other steps, ingredients, amounts, and macros identical. Call display_recipe again with the full updated recipe (including unchanged parts).`;

const TOOLS = [
  {
    name: 'display_recipe',
    description:
      'The ONLY way to show a recipe to the user. You MUST call this tool for any recipe — never write recipes in text. Call this for new recipes and when modifying an existing recipe (include the full updated recipe).',
    input_schema: {
      type: 'object',
      properties: {
        version: { type: 'integer', description: 'Schema version, always 1' },
        title: { type: 'string' },
        description: { type: 'string' },
        default_servings: { type: 'integer' },
        prep_time: { type: 'string' },
        cook_time: { type: 'string' },
        notes: { type: 'string' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. 2-6 lowercase tags across cuisine / diet / course / method (e.g. "indian", "vegetarian", "dinner", "one-pot") plus free-form. The creator confirms them at publish time.',
        },
        serving_item: {
          type: 'object',
          description: 'Optional. For recipes where servings are naturally countable items (e.g. 4 mozzarella sticks, 3 tacos, 2 pancakes). Omit for recipes like soups, stews, bowls, etc.',
          properties: {
            count: { type: 'number', description: 'Number of items per serving' },
            name: { type: 'string', description: 'Plural name of the item, e.g. "mozzarella sticks", "tacos", "cookies"' },
          },
          required: ['count', 'name'],
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '1-3 word step title, e.g. "Sear chicken", "Make sauce"' },
              description: { type: 'string' },
              temperature_f: { type: 'number', nullable: true },
              ingredients: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    from_step: { type: 'boolean', description: 'Set to true if this ingredient is the output of a previous step (e.g. "prepared dough", "marinade from step 1"). Macros must be all zeros to avoid double-counting.' },
                    grams: { type: 'number' },
                    volume: {
                      type: 'object',
                      properties: {
                        amount: { type: 'number' },
                        unit: { type: 'string' },
                      },
                      required: ['amount', 'unit'],
                    },
                    macros: {
                      type: 'object',
                      properties: {
                        calories: { type: 'number' },
                        protein_g: { type: 'number' },
                        carbs_g: { type: 'number' },
                        fat_g: { type: 'number' },
                        fiber_g: { type: 'number' },
                      },
                      required: ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'],
                    },
                  },
                  required: ['name', 'grams', 'volume', 'macros'],
                },
              },
            },
            required: ['title', 'description', 'ingredients'],
          },
        },
      },
      required: ['version', 'title', 'default_servings', 'steps'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web using DuckDuckGo. Returns titles, URLs, and snippets. Use to find recipes, compare approaches, verify ingredient amounts, or research techniques. Follow up with fetch_webpage on the most relevant results.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query. Be specific — e.g. "serious eats best chili recipe" or "bread flour hydration ratio for pizza dough"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_webpage',
    description:
      'Fetch and read the content of a webpage. Use when the user pastes a URL or to read a page found via web_search.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },
];

function buildSystemPrompt(preferences, currentRecipe) {
  let prompt = SYSTEM_PROMPT;

  if (currentRecipe) {
    prompt += `\n\nThe conversation's current recipe (use as the baseline for any modifications — only change what the user asks for):\n${JSON.stringify(currentRecipe)}`;
  }

  const parts = [];
  if (preferences.diet) {
    parts.push(`- Diet: ${preferences.diet}${preferences.diet === 'vegan' ? ' (no animal products at all)' : ' (no meat or fish)'}`);
  }
  if (preferences.complexity) {
    const labels = {
      quick: 'Quick (≤10 minutes total, minimal ingredients, pantry staples, one-pot/pan)',
      normal: 'Normal meal (standard home cooking, 30-60 min total)',
      serious: 'Serious Eats-style (multi-step, technique-heavy, restaurant quality, worth the effort)',
      foodscience: 'Food Science mode — pull out all the stops. Use any technique, specialty ingredient, or equipment to achieve the absolute best version of this dish. Modernist techniques (sous vide, transglutaminase, hydrocolloids, etc.), fermentation, dry-aging, specialized equipment — all fair game. Explain the science behind key decisions.',
    };
    parts.push(`- Complexity: ${labels[preferences.complexity] || preferences.complexity}`);
  }
  if (preferences.serving) {
    const labels = {
      snack: 'Snack-sized (~300-500 calories per serving, lighter portions)',
      normal: 'Normal meal (~600-900 calories per serving)',
      large: 'Large meal (~1000-1200 calories per serving, generous portions)',
    };
    parts.push(`- Serving size: ${labels[preferences.serving] || preferences.serving}`);
  }

  const tempUnit = preferences.tempUnit === 'F' ? 'Fahrenheit' : 'Celsius';
  parts.push(`- Temperature: Write temperatures in ${tempUnit} in step descriptions (the temperature_f field is always Fahrenheit regardless)`);

  // Language directive: `preferences.language` is resolved server-side from
  // the platform's JWT locale claim (see chat.js) — only a resolvable
  // non-English locale appends anything. For 'en'/unset nothing is appended,
  // preserving default behavior — including the model naturally mirroring a
  // user who writes in another language. Tags stay canonical English:
  // they're shared filter tokens.
  const lang = preferences.language;
  if (lang && lang !== 'en' && SUPPORTED_LANGUAGES[lang]) {
    parts.push(`- Language: Write your conversational replies and ALL human-readable recipe text (title, description, notes, prep_time, cook_time, step titles, step descriptions, ingredient names, serving_item name) in ${SUPPORTED_LANGUAGES[lang]}, unless the user explicitly asks for another language. EXCEPTION: the "tags" array must remain in the lowercase English tag vocabulary described above — tags are shared filter tokens across the community and must never be translated.`);
  }

  if (parts.length > 0) {
    prompt += `\n\nThe user's current preferences:\n${parts.join('\n')}\nAlways respect these constraints when suggesting or generating recipes.`;
  }

  return prompt;
}

function buildMessages(history) {
  return history.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

function getCreateParams(config, messages, systemPrompt, { model } = {}) {
  const resolvedModel = model || config.anthropicModel;
  const params = {
    model: resolvedModel,
    max_tokens: 8192,
    system: systemPrompt,
    tools: TOOLS,
    messages,
  };

  if (config.thinkingEnabled) {
    if (usesLegacyThinking(resolvedModel)) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: config.thinkingBudget,
      };
      params.temperature = 1;
    } else {
      params.thinking = { type: 'adaptive' };
    }
  }

  return params;
}

module.exports = {
  isEnabled,
  llmMode,
  createMessage,
  TOOLS,
  MODELS,
  DEFAULT_MODEL,
  isValidModel,
  SUPPORTED_LANGUAGES,
  resolveLocale,
  estimateMicrocents,
  buildSystemPrompt,
  buildMessages,
  getCreateParams,
};
