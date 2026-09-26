const express = require('express');
const fs = require('fs');
const path = require('path');
const { PLATFORM_ORIGIN } = require('./src/platform-origin');
const { load: loadConfig } = require('./src/config');
const { migrate } = require('./src/db/migrate');
const { authMiddleware } = require('./src/middleware/auth');
const { authRoutes } = require('./src/routes/auth');
const { conversationRoutes } = require('./src/routes/conversations');
const { recipeRoutes } = require('./src/routes/recipes');
const { chatRoutes } = require('./src/routes/chat');
const { collectionRoutes } = require('./src/routes/collections');
const { shoppingListRoutes } = require('./src/routes/shopping-list');
const { publicRoutes } = require('./src/routes/public');
const log = require('./src/services/logger');

const config = loadConfig();
log.setLevel(config.logLevel);

// The shell is a template, not a static file: its asset tags and the origin it
// publishes to client scripts carry __USERNODE_PLATFORM_ORIGIN__, substituted
// once at boot. Read once — the file cannot change under a running process.
function renderTemplate(file) {
  return fs.readFileSync(path.join(__dirname, 'public', file), 'utf8')
    .split('__USERNODE_PLATFORM_ORIGIN__').join(PLATFORM_ORIGIN);
}

const INDEX_HTML = renderTemplate('index.html');

const app = express();

app.use(express.json());

// 503 once shutdown starts so anything polling readiness sees the container
// leaving rotation rather than a connection reset (platform convention).
let shuttingDown = false;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  res.json({ status: 'ok' });
});

app.use(authMiddleware(config));
// Public recipe pages (/r/:slug + /api/public/…) are registered before the
// auth-gated catch-all; GETs outside /api pass the middleware untokened and
// /api/public/ is explicitly exempted in src/middleware/auth.js.
app.use(publicRoutes(config));
app.use(authRoutes(config));
app.use(conversationRoutes(config));
app.use(recipeRoutes(config));
app.use(chatRoutes(config));
app.use(collectionRoutes(config));
app.use(shoppingListRoutes(config));

// The static handler must never serve a file that renderTemplate owns, or it
// hands out the unrendered template — placeholder text where the platform
// origin should be, which is a broken page with broken asset tags. Two ways it
// would: as the directory index for / (hence index: false), and by name for an
// explicit /index.html. So it skips those paths and they fall through to
// the routes that render them.
const TEMPLATED_DOCS = new Set(['/index.html']);
const serveStatic = express.static(path.join(__dirname, 'public'), { index: false });

app.use((req, res, next) => (
  TEMPLATED_DOCS.has(req.path) ? next() : serveStatic(req, res, next)
));

// HTML shell: served to everyone. Signed-in users (platform iframe token)
// get the full app; unauthenticated top-level visits get the same shell in
// its logged-out anonymous mode — browse-only, fed exclusively by the
// GET-only /api/public/* endpoints, with sign-in prompts on every
// ownership/AI action (deliberate owner-confirmed deviation from the
// scaffold's auth-gated-shell default: only published content is
// reachable anonymously). Tokenless non-document stragglers still get the
// "open in Usernode" landing page.
app.get('*', (req, res) => {
  if (!req.user) {
    if (req.get('sec-fetch-dest') === 'document' && req.accepts('html')) {
      return res.type('html').send(INDEX_HTML);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/#app/recipebot-33b169/full" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Usernode</a>
  </div>
</body>`);
  }
  if (req.accepts('html')) {
    res.type('html').send(INDEX_HTML);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

async function start() {
  await migrate(config);

  // Capture the listener: the shutdown handler needs it to stop accepting
  // connections (platform graceful-shutdown convention).
  const server = app.listen(config.port, () => {
    log.info('server', `Listening on :${config.port}`);
  });

  // Stop accepting connections, drain in-flight requests under a hard
  // deadline, close the pool, exit. Idempotent: a repeat signal is a no-op.
  const DRAIN_MS = 3000;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('server', `${signal} received, draining`);
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
    try {
      const { getPool } = require('./src/db/pool');
      await getPool(config).end();
    } catch (e) {
      log.error('server', 'pool.end failed', { message: e.message });
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  log.error('server', 'Failed to start', { message: err.message });
  process.exit(1);
});
