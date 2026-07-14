const { getPool } = require('../db/pool');
const log = require('../services/logger');

function rateLimitMiddleware(config) {
  const pool = getPool(config);

  return async (req, res, next) => {
    if (!req.user) return next();

    try {
      const { rows } = await pool.query(
        `INSERT INTO rate_limits (user_id, date, count)
         VALUES ($1, CURRENT_DATE, 1)
         ON CONFLICT (user_id, date)
         DO UPDATE SET count = rate_limits.count + 1
         RETURNING count`,
        [req.user.id]
      );

      const count = rows[0].count;
      const limit = config.defaultDailyMsgLimit;

      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', String(Math.max(0, limit - count)));

      if (count > limit) {
        const tomorrow = new Date();
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(0, 0, 0, 0);

        log.warn('rate-limit', 'User exceeded daily limit', {
          userId: req.user.id,
          count,
          limit,
        });

        return res.status(429).json({
          error: 'Daily message limit reached',
          limit,
          count,
          resets_at: tomorrow.toISOString(),
        });
      }

      next();
    } catch (err) {
      log.error('rate-limit', 'Rate limit check failed', {
        message: err.message,
      });
      next();
    }
  };
}

module.exports = { rateLimitMiddleware };
