const { parseHTML } = require('linkedom');
const log = require('./logger');

const SEARCH_TIMEOUT = 8000;
const MAX_RESULTS = 8;

let _config = null;

function init(config) {
  _config = config;
  if (!config.braveSearchApiKey) {
    log.warn('search', 'BRAVE_SEARCH_API_KEY not set — falling back to DuckDuckGo HTML scraping (unreliable from servers)');
  }
}

async function webSearch(query) {
  if (!query?.trim()) {
    return { error: 'Empty search query' };
  }

  if (_config?.braveSearchApiKey) {
    return braveSearch(query);
  }
  return duckduckgoSearch(query);
}

async function braveSearch(query) {
  log.info('search', 'Searching Brave', { query });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': _config.braveSearchApiKey,
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log.warn('search', 'Brave returned error', { status: response.status });
      return { error: `Search failed (HTTP ${response.status})` };
    }

    const data = await response.json();
    const results = (data.web?.results || []).slice(0, MAX_RESULTS).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
    }));

    log.info('search', 'Search complete', { query, resultCount: results.length });
    return { results };
  } catch (err) {
    if (err.name === 'AbortError') {
      log.warn('search', 'Search timed out', { query });
      return { error: `Search timed out after ${SEARCH_TIMEOUT / 1000}s` };
    }
    log.error('search', 'Search error', { query, message: err.message });
    return { error: `Search failed: ${err.message}` };
  }
}

async function duckduckgoSearch(query) {
  log.info('search', 'Searching DuckDuckGo (fallback)', { query });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);

    const response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: `q=${encodeURIComponent(query)}`,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log.warn('search', 'DuckDuckGo returned error', { status: response.status });
      return { error: `Search failed (HTTP ${response.status})` };
    }

    const html = await response.text();
    const { document } = parseHTML(html);

    const results = [];
    const links = document.querySelectorAll('.result__a');
    const snippets = document.querySelectorAll('.result__snippet');

    for (let i = 0; i < Math.min(links.length, MAX_RESULTS); i++) {
      const link = links[i];
      let href = link.getAttribute('href') || '';

      if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
        const decoded = decodeURIComponent(href.split('uddg=')[1]?.split('&')[0] || '');
        if (decoded) href = decoded;
      }

      if (!href.startsWith('http')) continue;

      results.push({
        title: link.textContent?.trim() || '',
        url: href,
        snippet: snippets[i]?.textContent?.trim() || '',
      });
    }

    log.info('search', 'Search complete', { query, resultCount: results.length });
    return { results };
  } catch (err) {
    if (err.name === 'AbortError') {
      log.warn('search', 'Search timed out', { query });
      return { error: `Search timed out after ${SEARCH_TIMEOUT / 1000}s` };
    }
    log.error('search', 'Search error', { query, message: err.message });
    return { error: `Search failed: ${err.message}` };
  }
}

module.exports = { webSearch, init };
