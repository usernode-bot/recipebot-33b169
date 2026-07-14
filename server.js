const express = require('express');
const path = require('path');
const { load: loadConfig } = require('./src/config');
const { migrate } = require('./src/db/migrate');
const { authMiddleware } = require('./src/middleware/auth');
const { authRoutes } = require('./src/routes/auth');
const { conversationRoutes } = require('./src/routes/conversations');
const { recipeRoutes } = require('./src/routes/recipes');
const { chatRoutes } = require('./src/routes/chat');
const { feedbackRoutes } = require('./src/routes/feedback');
const log = require('./src/services/logger');

const config = loadConfig();
log.setLevel(config.logLevel);

const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use(authMiddleware(config));
app.use(authRoutes(config));
app.use(conversationRoutes(config));
app.use(recipeRoutes(config));
app.use(chatRoutes(config));
app.use(feedbackRoutes(config));

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case gets the "open in Usernode" landing page instead of a
// redirect, so the platform shell is never loaded INSIDE its own app
// iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    if (req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, 'https://social-vibecoding.usernodelabs.org/#app/recipebot-33b169/full');
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org/#app/recipebot-33b169/full" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Usernode</a>
  </div>
</body>`);
  }
  if (req.accepts('html')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

async function start() {
  await migrate(config);

  app.listen(config.port, () => {
    log.info('server', `Listening on :${config.port}`);
  });
}

start().catch((err) => {
  log.error('server', 'Failed to start', { message: err.message });
  process.exit(1);
});
