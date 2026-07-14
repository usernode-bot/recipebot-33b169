const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const log = require('./logger');

const MAX_CONTENT_LENGTH = 8000;
const FETCH_TIMEOUT = 10000;

async function fetchWebpage(url) {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return { error: 'Invalid URL. Only HTTP/HTTPS URLs are supported.' };
  }

  log.info('web', 'Fetching URL', { url });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RecipeBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log.warn('web', 'Fetch failed', { url, status: response.status });
      return { error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const html = await response.text();
    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article) {
      const fallback = document.body?.textContent?.slice(0, MAX_CONTENT_LENGTH) || '';
      log.warn('web', 'Readability failed, using fallback', { url });
      return { title: document.title || url, content: fallback.trim() };
    }

    const content = article.textContent.slice(0, MAX_CONTENT_LENGTH).trim();

    log.info('web', 'Fetch complete', {
      url,
      title: article.title,
      contentLength: content.length,
    });

    return { title: article.title || url, content };
  } catch (err) {
    if (err.name === 'AbortError') {
      log.warn('web', 'Fetch timed out', { url });
      return { error: `Request timed out after ${FETCH_TIMEOUT / 1000}s` };
    }
    log.error('web', 'Fetch error', { url, message: err.message });
    return { error: `Failed to fetch: ${err.message}` };
  }
}

module.exports = { fetchWebpage };
