// Where the platform itself lives.
//
// The platform injects USERNODE_PLATFORM_ORIGIN into every app's environment,
// derived from the domain that deployment actually runs on. Reading it is the
// whole point: a platform hostname written into this repo is a hostname that
// goes stale the next time the platform moves — which is exactly what happened,
// and what left this app's asset tags and every "open in Usernode" link
// pointing at a host that no longer answers. The literal below is only the
// standalone-deploy fallback.
//
// Validated rather than trusted: the value is interpolated into markup, into
// hrefs and into a JS string, so anything that is not a plain http(s) origin is
// discarded instead of being written out.
const PLATFORM_ORIGIN_FALLBACK = 'https://my.onhomeroom.com';

const PLATFORM_ORIGIN = (() => {
  const raw = String(process.env.USERNODE_PLATFORM_ORIGIN || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    if ((u.protocol === 'https:' || u.protocol === 'http:') && u.origin === raw) return raw;
  } catch (_) { /* unset or unparseable — fall through */ }
  if (raw) console.warn('USERNODE_PLATFORM_ORIGIN is not a plain origin; ignoring it:', raw);
  return PLATFORM_ORIGIN_FALLBACK;
})();

module.exports = { PLATFORM_ORIGIN, PLATFORM_ORIGIN_FALLBACK };
