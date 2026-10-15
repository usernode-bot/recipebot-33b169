const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const log = require('./logger');

// Prose fallback cap. Deliberately unchanged (issue #43): tool results
// accumulate in the turn loop's message array, so raising this grows EVERY
// subsequent turn's prompt. The win comes from better signal (structured
// recipe data) rather than more text.
const MAX_CONTENT_LENGTH = 8000;
// Structured schema.org Recipe data is dense signal, so it earns a wider cap
// than prose — but still bounded, since some sites embed enormous graphs.
const MAX_STRUCTURED_LENGTH = 12000;
const FETCH_TIMEOUT = 10000;
// Recipe pages are routinely 500KB–1MB of HTML. Reading an unbounded body and
// then parsing it synchronously blocks the single Node event loop, stalling
// SSE writes for every connected user — so cap the bytes we're willing to
// take before parsing ever starts.
const MAX_HTML_BYTES = 1_500_000;

// Short-TTL page cache. Makes "Try again" after a timeout cheap (it reuses
// what the failed attempt read instead of re-fetching), and dedupes the same
// URL across turns of one reply.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 32;
const cache = new Map();

function cacheGet(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  return hit.result;
}

function cacheSet(url, result) {
  cache.set(url, { result, at: Date.now() });
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

// Read the response body with a hard byte ceiling, keeping the caller's abort
// signal live for the whole download (the old code cleared its timeout before
// reading the body, leaving that phase unbounded).
async function readBounded(response) {
  if (!response.body) {
    const text = await response.text();
    const buf = Buffer.from(text, 'utf8');
    if (buf.length > MAX_HTML_BYTES) {
      return { html: buf.subarray(0, MAX_HTML_BYTES).toString('utf8'), truncated: true };
    }
    return { html: text, truncated: false };
  }

  const decoder = new TextDecoder('utf-8');
  let bytes = 0;
  let html = '';
  let truncated = false;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes >= MAX_HTML_BYTES) {
      const keep = chunk.length - (bytes - MAX_HTML_BYTES);
      html += decoder.decode(chunk.subarray(0, Math.max(0, keep)), { stream: true });
      truncated = true;
      break;
    }
    html += decoder.decode(chunk, { stream: true });
  }
  html += decoder.decode();
  return { html, truncated };
}

// ── schema.org Recipe extraction ────────────────────────────────────────────
// Every branch here is defensive: a malformed or exotic JSON-LD block must
// fall through to the prose path, never throw.

function collectLdNodes(parsed, out) {
  if (!parsed || out.length > 200) return;
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectLdNodes(item, out);
    return;
  }
  if (typeof parsed !== 'object') return;
  out.push(parsed);
  if (parsed['@graph']) collectLdNodes(parsed['@graph'], out);
}

function isRecipeNode(node) {
  const t = node && node['@type'];
  if (!t) return false;
  if (typeof t === 'string') return t.toLowerCase() === 'recipe';
  if (Array.isArray(t)) return t.some((v) => typeof v === 'string' && v.toLowerCase() === 'recipe');
  return false;
}

function findRecipeNode(document) {
  let scripts;
  try {
    scripts = document.querySelectorAll('script[type="application/ld+json"]');
  } catch {
    return null;
  }
  for (const script of scripts) {
    const raw = script.textContent;
    if (!raw || raw.length > 400_000) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // some sites emit invalid JSON-LD — just skip it
    }
    const nodes = [];
    try {
      collectLdNodes(parsed, nodes);
    } catch {
      continue;
    }
    const recipe = nodes.find(isRecipeNode);
    if (recipe) return recipe;
  }
  return null;
}

// Finished-dish photo URLs from a recipe node. schema.org recipe images are
// editorial shots of the completed dish, so resolve to absolute URLs and
// keep the first few usable ones.
function extractRecipeImages(node, pageUrl) {
  const raw = node && node.image;
  const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];
  for (const item of items.slice(0, 6)) {
    let u = plainText(item && item.url ? item.url : item);
    if (!u) continue;
    try {
      u = new URL(u, pageUrl).href;
    } catch { continue; }
    if (!/^https?:/i.test(u)) continue;
    if (out.includes(u)) continue;
    out.push(u);
  }
  return out;
}

function plainText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return plainText(value.text || value.name || value['@value'] || '');
  }
  return '';
}

// recipeInstructions comes in every shape imaginable: a string, an array of
// strings, HowToStep objects, or HowToSection objects wrapping itemListElement.
function flattenInstructions(value, out, depth = 0) {
  if (!value || depth > 4 || out.length > 120) return;
  if (typeof value === 'string') {
    const text = plainText(value);
    if (text) out.push({ text });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenInstructions(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const type = typeof value['@type'] === 'string' ? value['@type'].toLowerCase() : '';
  if (type === 'howtosection' || value.itemListElement) {
    const section = plainText(value.name);
    const nested = [];
    flattenInstructions(value.itemListElement, nested, depth + 1);
    for (const step of nested) {
      out.push(section ? { section, text: step.text } : step);
    }
    return;
  }
  const text = plainText(value.text || value.name);
  if (text) out.push({ text });
}

function formatNutrition(nutrition) {
  if (!nutrition || typeof nutrition !== 'object') return '';
  const fields = [
    ['calories', 'calories'],
    ['proteinContent', 'protein'],
    ['carbohydrateContent', 'carbs'],
    ['fatContent', 'fat'],
    ['fiberContent', 'fiber'],
    ['servingSize', 'serving size'],
  ];
  const parts = [];
  for (const [key, label] of fields) {
    const v = plainText(nutrition[key]);
    if (v) parts.push(`${label}: ${v}`);
  }
  return parts.join(', ');
}

// Render the recipe node as a compact plain-text block. ~1–3KB of exact
// amounts beats 8KB of truncated headnotes, which is what drove the model to
// go fetch more pages (and blow the time budget) in the first place.
function renderStructuredRecipe(node, pageUrl) {
  const lines = [];
  const name = plainText(node.name);
  if (name) lines.push(`Recipe: ${name}`);

  // Surface the finished-dish photo URL explicitly so the model can copy
  // it into display_recipe's image field verbatim.
  const image = extractRecipeImages(node, pageUrl);
  if (image.length) lines.push(`Image: ${image[0]}`);

  const description = plainText(node.description);
  if (description) lines.push(`Description: ${description}`);

  const meta = [];
  const yieldText = plainText(node.recipeYield);
  if (yieldText) meta.push(`Yield: ${yieldText}`);
  for (const [key, label] of [['prepTime', 'Prep'], ['cookTime', 'Cook'], ['totalTime', 'Total']]) {
    const v = plainText(node[key]);
    if (v) meta.push(`${label}: ${v}`);
  }
  const cuisine = plainText(node.recipeCuisine);
  if (cuisine) meta.push(`Cuisine: ${cuisine}`);
  const category = plainText(node.recipeCategory);
  if (category) meta.push(`Category: ${category}`);
  if (meta.length) lines.push(meta.join(' · '));

  const ingredients = Array.isArray(node.recipeIngredient)
    ? node.recipeIngredient.map(plainText).filter(Boolean)
    : (plainText(node.recipeIngredient) ? [plainText(node.recipeIngredient)] : []);
  if (ingredients.length) {
    lines.push('', 'Ingredients:');
    for (const ing of ingredients.slice(0, 100)) lines.push(`- ${ing}`);
  }

  const steps = [];
  flattenInstructions(node.recipeInstructions, steps);
  if (steps.length) {
    lines.push('', 'Instructions:');
    let lastSection = null;
    let n = 0;
    for (const step of steps) {
      if (step.section && step.section !== lastSection) {
        lines.push(`[${step.section}]`);
        lastSection = step.section;
      }
      n += 1;
      lines.push(`${n}. ${step.text}`);
    }
  }

  const nutrition = formatNutrition(node.nutrition);
  if (nutrition) lines.push('', `Nutrition (per serving, as published): ${nutrition}`);

  const notes = plainText(node.recipeNotes || node.tips);
  if (notes) lines.push('', `Notes: ${notes}`);

  // Only worth using if it actually carries the amounts or the method.
  if (!ingredients.length && !steps.length) return null;

  const text = lines.join('\n').trim();
  return {
    name,
    text: text.length > MAX_STRUCTURED_LENGTH
      ? `${text.slice(0, MAX_STRUCTURED_LENGTH)}\n[Structured recipe data truncated.]`
      : text,
  };
}

async function fetchWebpage(url) {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return { error: 'Invalid URL. Only HTTP/HTTPS URLs are supported.' };
  }

  const cached = cacheGet(url);
  if (cached) {
    log.info('web', 'Fetch served from cache', { url });
    return { ...cached, cached: true };
  }

  log.info('web', 'Fetching URL', { url });
  const startedAt = Date.now();

  const controller = new AbortController();
  // NOTE: the timeout stays armed across the body read on purpose — the old
  // code cleared it right after headers arrived, leaving the download itself
  // with no bound at all.
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RecipeBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      log.warn('web', 'Fetch failed', { url, status: response.status });
      return { error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !/html|xml|text\/plain/.test(contentType)) {
      log.warn('web', 'Non-HTML content type', { url, contentType });
      return { error: `That URL is not a web page (content type: ${contentType.split(';')[0]}).` };
    }

    const { html, truncated: htmlTruncated } = await readBounded(response);
    clearTimeout(timeout);

    if (!html.trim()) {
      return { error: 'The page returned no content.' };
    }

    // parseHTML and Readability are synchronous and CPU-heavy on a large page.
    // Yield first so the event loop can flush pending SSE writes for other
    // users before we block it.
    await new Promise((resolve) => setImmediate(resolve));

    let document;
    try {
      ({ document } = parseHTML(html));
    } catch (err) {
      log.warn('web', 'HTML parse failed', { url, message: err.message });
      return { error: 'That page could not be parsed.' };
    }

    const pageTitle = document.title || url;

    // Finished-dish photo from the page's own metadata (recipe image /
    // OG). The model passes it to display_recipe so published recipes
    // carry a real photo instead of a keyword-guessed placeholder.
    let photo = null;
    try {
      photo = extractRecipeImage(document, url);
    } catch (err) {
      log.warn('web', 'Recipe image extraction failed', { url, message: err.message });
    }

    // Structured data first — and when it hits, skip Readability entirely,
    // which is where most of the event-loop blocking came from.
    const recipeNode = findRecipeNode(document);
    if (recipeNode) {
      let structured = null;
      try {
        structured = renderStructuredRecipe(recipeNode, url);
      } catch (err) {
        log.warn('web', 'Structured recipe render failed', { url, message: err.message });
      }
      if (structured) {
        const result = {
          title: structured.name || pageTitle,
          content: structured.text,
          structured: true,
          truncated: false,
          image: photo || undefined,
        };
        log.info('web', 'Fetch complete (structured)', {
          url,
          title: result.title,
          contentLength: result.content.length,
          elapsed_ms: Date.now() - startedAt,
        });
        cacheSet(url, result);
        return result;
      }
    }

    let article = null;
    try {
      article = new Readability(document).parse();
    } catch (err) {
      log.warn('web', 'Readability threw', { url, message: err.message });
    }

    const source = article?.textContent || document.body?.textContent || '';
    const trimmed = source.trim();
    if (!trimmed) {
      return { error: 'That page had no readable text.' };
    }

    const content = trimmed.slice(0, MAX_CONTENT_LENGTH).trim();
    const result = {
      title: article?.title || pageTitle,
      content,
      structured: false,
      image: photo || undefined,
      // Either the HTML itself was cut at the byte cap, or the extracted prose
      // exceeded the character cap — both mean the model is looking at a
      // partial page and must not fill the gap from imagination.
      truncated: htmlTruncated || trimmed.length > MAX_CONTENT_LENGTH,
    };

    if (!article) log.warn('web', 'Readability failed, using body text', { url });
    log.info('web', 'Fetch complete (prose)', {
      url,
      title: result.title,
      contentLength: result.content.length,
      truncated: result.truncated,
      elapsed_ms: Date.now() - startedAt,
    });

    cacheSet(url, result);
    return result;
  } catch (err) {
    if (err.name === 'AbortError') {
      log.warn('web', 'Fetch timed out', { url, elapsed_ms: Date.now() - startedAt });
      return { error: `Request timed out after ${FETCH_TIMEOUT / 1000}s` };
    }
    log.error('web', 'Fetch error', { url, message: err.message });
    return { error: `Failed to fetch: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

// Pull the best finished-dish photo out of a page's metadata. Priority:
// schema.org Recipe images (normally the plated dish), then Open Graph /
// Twitter card images. Absolute HTTP(S) URLs only.
function extractRecipeImage(document, pageUrl) {
  const recipeNode = findRecipeNode(document);
  if (recipeNode) {
    const images = extractRecipeImages(recipeNode, pageUrl);
    if (images.length) return images[0];
  }
  let metas = [];
  try {
    metas = [
      ...document.querySelectorAll('meta[property="og:image"]'),
      ...document.querySelectorAll('meta[name="twitter:image"], meta[name="twitter:image:src"]'),
    ];
  } catch { return null; }
  for (const meta of metas) {
    const raw = meta.getAttribute('content');
    if (!raw) continue;
    let u;
    try {
      u = new URL(raw, pageUrl).href;
    } catch { continue; }
    if (/^https:\/\//i.test(u)) return u;
  }
  return null;
}

// Deterministic last-resort image for a recipe with no photo from its
// source page: Unsplash's keyword redirect (stable HTTPS, food-themed).
// Only valid recipe titles reach it; anything odd falls back to null and
// the UI keeps its plain text-card look.
function fallbackImageForTitle(title) {
  if (typeof title !== 'string') return null;
  const q = title.toLowerCase().trim();
  if (!q || q.length > 120) return null;
  const keyword = q.replace(/[^a-z0-9 ]/g, ' ').trim().slice(0, 80);
  if (!keyword) return null;
  return `https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=900&q=60&auto=format&fit=crop&food=1&dish=${encodeURIComponent(keyword)}`;
}

module.exports = {
  fetchWebpage,
  MAX_CONTENT_LENGTH,
  fallbackImageForTitle,
};
