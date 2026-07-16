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

-- Per-user daily LLM spend, accumulated per API turn from response.usage.
-- date is always the UTC day (see chat.js / auth.js queries) so "today"
-- matches the platform's midnight-UTC budget reset. estimated_microcents
-- is 1/1,000,000 of a cent — integer-exact accumulation; converted to
-- cents only at the API boundary.
CREATE TABLE IF NOT EXISTS llm_usage (
  user_id              INTEGER NOT NULL,
  date                 DATE NOT NULL,
  input_tokens         BIGINT NOT NULL DEFAULT 0,
  output_tokens        BIGINT NOT NULL DEFAULT 0,
  estimated_microcents BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id     INTEGER PRIMARY KEY,
  username    VARCHAR(255),
  preferences JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Social features: published recipe snapshots, ratings, favorites.
-- All three are PUBLIC tables (shared content, visible across users).
-- conversation_id columns are bare integers on purpose: conversations is
-- staging:private and public tables must not FK into private tables.
CREATE TABLE IF NOT EXISTS shared_recipes (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL,
  username        VARCHAR(255) NOT NULL,
  conversation_id INTEGER NOT NULL,
  recipe_data     JSONB NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS shared_recipes_owner_conv
  ON shared_recipes (user_id, conversation_id);

-- Version history for shared recipes: one row per publish (v1 = first
-- share). shared_recipes.recipe_data stays the denormalized "current"
-- copy; the current version number is computed as MAX(version).
CREATE TABLE IF NOT EXISTS shared_recipe_versions (
  id               SERIAL PRIMARY KEY,
  shared_recipe_id INTEGER NOT NULL REFERENCES shared_recipes(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL,
  recipe_data      JSONB NOT NULL,
  note             TEXT,
  user_id          INTEGER NOT NULL,
  username         VARCHAR(255) NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (shared_recipe_id, version)
);

-- Backfill: shares published before versioning existed become v1.
INSERT INTO shared_recipe_versions (shared_recipe_id, version, recipe_data, user_id, username, created_at)
SELECT s.id, 1, s.recipe_data, s.user_id, s.username, s.updated_at
FROM shared_recipes s
WHERE NOT EXISTS (SELECT 1 FROM shared_recipe_versions v WHERE v.shared_recipe_id = s.id);

CREATE TABLE IF NOT EXISTS recipe_ratings (
  shared_recipe_id INTEGER NOT NULL REFERENCES shared_recipes(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL,
  rating           INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (shared_recipe_id, user_id)
);

-- Dual-target favorites: others' shared recipes (shared_recipe_id) or
-- your own conversations (conversation_id) — exactly one is set.
CREATE TABLE IF NOT EXISTS recipe_favorites (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL,
  shared_recipe_id INTEGER REFERENCES shared_recipes(id) ON DELETE CASCADE,
  conversation_id  INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  CHECK ((shared_recipe_id IS NULL) <> (conversation_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS recipe_favorites_shared
  ON recipe_favorites (user_id, shared_recipe_id) WHERE shared_recipe_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recipe_favorites_conv
  ON recipe_favorites (user_id, conversation_id) WHERE conversation_id IS NOT NULL;

-- The in-app feedback widget was removed (platform-level feedback covers
-- it now); drop its table, which nothing else used.
DROP TABLE IF EXISTS feedback;

-- Owner-only content: 1:1 chats with the bot, diet preferences.
-- Copied schema-only into staging; seeded there by migrate.js.
COMMENT ON TABLE conversations   IS 'staging:private';
COMMENT ON TABLE llm_usage       IS 'staging:private';
COMMENT ON TABLE messages        IS 'staging:private';
COMMENT ON TABLE pending_replies IS 'staging:private';
COMMENT ON TABLE user_settings   IS 'staging:private';
