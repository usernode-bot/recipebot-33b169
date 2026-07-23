const jwt = require('jsonwebtoken');

// Paths that stay open without authentication. Everything non-GET and
// everything under /api/ requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

// Public path PREFIXES that bypass the JWT gate. Deliberately a single,
// explicit namespace: /api/public/* serves the no-login recipe pages
// (GET /r/:slug) their data. Nothing else under /api/ is exempt.
const PUBLIC_PREFIXES = ['/api/public/'];

// Platform iframe auth: the shell injects `?token=…` on iframe load and
// the frontend forwards it via the `x-usernode-token` header. On success
// req.user = { id, username, usernode_pubkey }.
function authMiddleware(config) {
  return (req, res, next) => {
    const token = req.query.token || req.headers['x-usernode-token'];
    if (token && config.jwtSecret) {
      try { req.user = jwt.verify(token, config.jwtSecret); } catch {}
    }

    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      if (PUBLIC_API_PATHS.has(req.path)) return next();
      if (req.method === 'GET' && PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) {
        return next();
      }
      if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
  };
}

module.exports = { authMiddleware };
