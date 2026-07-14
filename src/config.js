const REQUIRED = ['DATABASE_URL'];

function mask(val) {
  if (!val) return '(not set)';
  if (val.length <= 8) return '****';
  return val.slice(0, 4) + '...' + val.slice(-4);
}

function load() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[config] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (!process.env.JWT_SECRET) {
    console.warn('[config] JWT_SECRET not set — all authenticated routes will reject');
  }

  const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET || '',
    isStaging: process.env.USERNODE_ENV === 'staging',
    // Platform LLM proxy (production only; staging/standalone get neither)
    llmProxyUrl: process.env.USERNODE_LLM_PROXY_URL || '',
    llmProxyToken: process.env.USERNODE_LLM_PROXY_TOKEN || '',
    // Optional direct-API fallback (owner-provided secret)
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    thinkingEnabled: process.env.THINKING_ENABLED !== 'false',
    thinkingBudget: parseInt(process.env.THINKING_BUDGET || '4096', 10),
    defaultDailyMsgLimit: parseInt(process.env.DEFAULT_DAILY_MSG_LIMIT || '50', 10),
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
    logLevel: process.env.LOG_LEVEL || 'INFO',
  };

  console.log('[config] Loaded:');
  console.log(`  USERNODE_ENV=${process.env.USERNODE_ENV || '(not set)'}`);
  console.log(`  LLM_PROXY=${config.llmProxyToken ? 'available' : 'absent'}`);
  console.log(`  ANTHROPIC_API_KEY=${mask(config.anthropicApiKey)}`);
  console.log(`  ANTHROPIC_MODEL=${config.anthropicModel}`);
  console.log(`  THINKING_ENABLED=${config.thinkingEnabled}`);
  console.log(`  THINKING_BUDGET=${config.thinkingBudget}`);
  console.log(`  BRAVE_SEARCH_API_KEY=${mask(config.braveSearchApiKey)}`);
  console.log(`  DATABASE_URL=${mask(config.databaseUrl)}`);
  console.log(`  DEFAULT_DAILY_MSG_LIMIT=${config.defaultDailyMsgLimit}`);
  console.log(`  LOG_LEVEL=${config.logLevel}`);

  return config;
}

module.exports = { load };
