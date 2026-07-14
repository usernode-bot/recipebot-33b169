-- RecipeBot schema — applied idempotently on every boot.
-- Identity comes from the platform JWT (req.user.id / req.user.username);
-- there is no local users/sessions table.

CREATE TABLE IF NOT EXISTS conversations (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  title       VARCHAR(255) DEFAULT 'New conversation',
  preferences JSONB DEFAULT '{}',
  ui_state    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  role            VARCHAR(20) NOT NULL,
  content         TEXT NOT NULL,
  recipe_data     JSONB,
  response_log    JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pending_replies (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'processing',
  events          JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id    INTEGER NOT NULL,
  date       DATE NOT NULL DEFAULT CURRENT_DATE,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id     INTEGER PRIMARY KEY,
  username    VARCHAR(255),
  preferences JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  username    VARCHAR(255),
  description TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Owner-only content: 1:1 chats with the bot, diet preferences, free-text
-- feedback. Copied schema-only into staging; seeded there by migrate.js.
COMMENT ON TABLE conversations   IS 'staging:private';
COMMENT ON TABLE messages        IS 'staging:private';
COMMENT ON TABLE pending_replies IS 'staging:private';
COMMENT ON TABLE user_settings   IS 'staging:private';
COMMENT ON TABLE feedback        IS 'staging:private';
