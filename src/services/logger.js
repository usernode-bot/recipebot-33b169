const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

let currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.INFO;

const SENSITIVE_PATTERNS = [/sk-ant-\S+/g, /password["']?\s*[:=]\s*["']?\S+/gi];

function redact(obj) {
  if (!obj) return obj;
  let str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  for (const pattern of SENSITIVE_PATTERNS) {
    str = str.replace(pattern, '****');
  }
  return str;
}

function formatData(data) {
  if (data === undefined) return '';
  if (typeof data === 'string') return ' ' + data;
  return ' ' + redact(JSON.stringify(data));
}

function log(level, category, message, data) {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const padded = level.padEnd(5);
  const line = `[${ts}] ${padded} [${category}] ${message}${formatData(data)}`;

  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

function setLevel(level) {
  if (LEVELS[level] !== undefined) currentLevel = LEVELS[level];
}

module.exports = {
  debug: (cat, msg, data) => log('DEBUG', cat, msg, data),
  info: (cat, msg, data) => log('INFO', cat, msg, data),
  warn: (cat, msg, data) => log('WARN', cat, msg, data),
  error: (cat, msg, data) => log('ERROR', cat, msg, data),
  setLevel,
  redact,
};
