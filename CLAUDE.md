# RecipeBot — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About RecipeBot

RecipeBot is an LLM-powered recipe assistant, ported from a standalone
Express/Postgres app. You chat about what you want to cook; the model
answers with a structured recipe (versioned JSON) rendered in a
dedicated panel — servings scaler, per-ingredient grams/volume/macros,
collapsible ingredient summary, diff view with Accept/Reject when a
recipe is modified, full-screen cooking mode with inline timers, print
view, and recipe forking. The assistant has `display_recipe`,
`web_search`, and `fetch_webpage` tools.

Key architecture notes:

- **Recipes live in `messages.recipe_data`** (JSONB); the homepage's
  "Your recipes" list is derived from the latest recipe message per
  conversation. There is no separate recipes table. There is no
  sidebar — search, new recipe, and the recipe/conversation lists all
  live on the homepage.
- **Replies are resumable**: chat POST returns 202 with a `replyId`;
  the LLM turn loop runs in the background, appending events to
  `pending_replies.events`, and the client follows via SSE at
  `/api/chat/:replyId/stream` (token passed as `?token=` since
  EventSource can't set headers). Non-streaming Messages API calls per
  turn; streaming is simulated from the event log.
- **LLM access**: platform LLM proxy in production; optional
  `ANTHROPIC_API_KEY` secret as fallback (staging/standalone);
  otherwise chat is disabled with a clear message. See
  `src/services/llm.js`.
- The recipe JSON contract is documented in the `display_recipe` tool
  schema in `src/services/llm.js` — step descriptions must NOT contain
  ingredient amounts (they'd go stale when servings scale).

## App-specific conventions

- **Private tables** (`staging:private`): `conversations`, `messages`,
  `pending_replies`, `user_settings` — all owner-only
  content. Staging is seeded by `src/db/migrate.js` with a demo
  conversation under sentinel `user_id = 0`; in staging, list/read
  endpoints also include that user's rows.
- Per-user daily message limit is global (`DEFAULT_DAILY_MSG_LIMIT`,
  default 50), enforced via the `rate_limits` table.
- Plain JS, no build step; frontend is vanilla JS + Tailwind CDN.
- `temperature_f` on steps is canonical Fahrenheit; the UI converts to
  °C per the user's preference. `grams` is the canonical ingredient
  weight used for scaling math.
