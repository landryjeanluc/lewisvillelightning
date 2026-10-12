-- lvlnb stats. Roster and schedule stay owned by data/*.json (Spordle);
-- this database holds only what team admins type in.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- game_id / player_id are CONTRACT ids ("g-2026-10-13-shediac", "pl-22"),
-- deliberately not FKs: the roster can change without orphaning what happened.
CREATE TABLE IF NOT EXISTS game_results (
  game_id      TEXT PRIMARY KEY,
  our_score    INT  CHECK (our_score  >= 0),
  their_score  INT  CHECK (their_score >= 0),
  status       TEXT NOT NULL DEFAULT 'final'
               CHECK (status IN ('scheduled','in_progress','final','postponed','cancelled')),
  updated_by   BIGINT REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_stats (
  game_id     TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  g           INT NOT NULL DEFAULT 0 CHECK (g   >= 0),
  a           INT NOT NULL DEFAULT 0 CHECK (a   >= 0),
  pim         INT NOT NULL DEFAULT 0 CHECK (pim >= 0),
  plus_minus  INT NOT NULL DEFAULT 0,          -- may be negative, by nature
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX IF NOT EXISTS game_stats_player_idx ON game_stats (player_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id       BIGSERIAL PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id  BIGINT REFERENCES users(id),
  action   TEXT NOT NULL,
  game_id  TEXT,
  payload  JSONB
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
