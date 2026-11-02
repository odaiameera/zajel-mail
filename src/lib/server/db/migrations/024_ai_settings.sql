-- Which AI the server uses, chosen in Settings → Agent. One row for the
-- whole server. API keys stay in the environment; a NULL column means "use
-- the environment's value, or the built-in default".
CREATE TABLE IF NOT EXISTS ai_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  provider      TEXT,   -- anthropic | openai | ollama
  agent_model   TEXT,   -- Claude: the agent that uses tools
  writer_model  TEXT,   -- Claude: summaries, drafts, extraction
  agent_effort  TEXT,   -- Claude: low | medium | high
  openai_model  TEXT,
  ollama_model  TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
