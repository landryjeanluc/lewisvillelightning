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

-- ---------------------------------------------------------------- auth v2 --

-- Bumped whenever a password changes, and carried in the session cookie, so a
-- reset instantly invalidates every cookie that user already had out there.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch INT NOT NULL DEFAULT 1;

-- Every attempt, good or bad. Brute-force limits read it; it is also the
-- audit trail for "who tried to get in".
CREATE TABLE IF NOT EXISTS login_attempts (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  email   TEXT,
  ip      TEXT,
  success BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_email_idx ON login_attempts (lower(email), at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_ip_idx    ON login_attempts (ip, at DESC);

-- Only the hash is stored: a leaked database must not hand someone a working
-- reset link.
CREATE TABLE IF NOT EXISTS password_resets (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  requested_ip TEXT
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at DESC);

-- ------------------------------------------------- admin-authored content --
-- Spordle owns the roster and schedule (data/*.json). Everything below is
-- written by team admins in the browser and does not survive in Spordle, so it
-- lives here and is keyed to the contract ids rather than to database rows.

CREATE TABLE IF NOT EXISTS news_posts (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT,
  body         TEXT NOT NULL DEFAULT '',        -- markdown
  image        TEXT,                            -- /uploads/… path
  lang         TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en','fr')),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at TIMESTAMPTZ,
  author_id    BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_published_idx ON news_posts (status, published_at DESC);

-- Detail Spordle does not carry: it gives only Forward/Defence/Goalie, no
-- captaincy, no shot hand, and nothing about the kid.
CREATE TABLE IF NOT EXISTS player_profiles (
  player_id   TEXT PRIMARY KEY,                 -- contract id, e.g. pl-02
  bio         TEXT,
  position    TEXT CHECK (position IN ('C','LW','RW','F','D','G')),
  shoots      TEXT CHECK (shoots IN ('L','R')),
  captain     TEXT CHECK (captain IN ('C','A')),
  nickname    TEXT,
  favourite_player TEXT,
  card_art    TEXT,
  photo       TEXT,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One preview and one recap per game, written by whoever runs the bench.
CREATE TABLE IF NOT EXISTS game_notes (
  game_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('preview','recap')),
  body       TEXT NOT NULL DEFAULT '',
  author_id  BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, kind)
);

CREATE TABLE IF NOT EXISTS uploads (
  id           BIGSERIAL PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,            -- /uploads/<name>
  kind         TEXT NOT NULL,                   -- card_art | team_photo | news_image
  bytes        INT NOT NULL,
  content_type TEXT NOT NULL,
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------- families and game jobs --
-- A login can belong to a player's family. Several per player is normal and
-- expected: two parents, a step-parent, a grandparent who does the driving.

ALTER TABLE users ADD COLUMN IF NOT EXISTS player_id    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS relationship TEXT;   -- Mom, Dad, Guardian…
CREATE INDEX IF NOT EXISTS users_player_idx ON users (player_id);

-- role gains 'parent'; the old two-value constraint has to go first
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'parent', 'player', 'viewer'));

-- The reusable list of jobs. Seeded with the three a night really needs
-- (50/50, scoresheet, timekeeper); the rest is whatever the admin adds —
-- jerseys, snacks, or a gate for one tournament weekend.
CREATE TABLE IF NOT EXISTS job_types (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  sort        INT NOT NULL DEFAULT 100,
  active      BOOLEAN NOT NULL DEFAULT true
);

-- A job for one game, assigned to a FAMILY rather than a person: whoever is
-- actually free that night sorts it out between themselves, then claims it so
-- the rest of the team can see who turned up.
CREATE TABLE IF NOT EXISTS game_jobs (
  id          BIGSERIAL PRIMARY KEY,
  game_id     TEXT NOT NULL,
  job_type_id BIGINT NOT NULL REFERENCES job_types(id) ON DELETE CASCADE,
  player_id   TEXT,                                  -- the family on the hook
  claimed_by  BIGINT REFERENCES users(id),           -- which of them took it
  note        TEXT,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, job_type_id)
);
CREATE INDEX IF NOT EXISTS game_jobs_game_idx ON game_jobs (game_id);

-- ------------------------------------------------------------- team chat --
CREATE TABLE IF NOT EXISTS chat_conversations (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('team', 'direct')),
  user_low BIGINT REFERENCES users(id) ON DELETE CASCADE,
  user_high BIGINT REFERENCES users(id) ON DELETE CASCADE,
  CHECK ((kind = 'team' AND user_low IS NULL AND user_high IS NULL)
      OR (kind = 'direct' AND user_low IS NOT NULL AND user_high IS NOT NULL AND user_low < user_high)),
  UNIQUE (user_low, user_high)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_one_team_idx ON chat_conversations (kind) WHERE kind = 'team';
INSERT INTO chat_conversations (kind) VALUES ('team') ON CONFLICT DO NOTHING;

-- A revision stream includes removals, so connected clients see moderation too.
CREATE SEQUENCE IF NOT EXISTS chat_revision_seq;
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  client_id UUID NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT nextval('chat_revision_seq'),
  CHECK ((deleted_at IS NULL AND char_length(trim(body)) BETWEEN 1 AND 2000)
      OR (deleted_at IS NOT NULL AND body = '')),
  UNIQUE (sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS chat_history_idx ON chat_messages (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS chat_changes_idx ON chat_messages (conversation_id, revision);
CREATE INDEX IF NOT EXISTS chat_rate_idx ON chat_messages (sender_id, created_at DESC);
CREATE TABLE IF NOT EXISTS chat_reads (
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

-- Players get their own login too (JL 2026-10-13): they see everything the
-- parents do — the point is to give the kids a small community of their own.
-- Kept a distinct role from 'parent' so adult-only things (claiming game jobs)
-- stay adult-only, and so anything built for the kids can target them.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'parent', 'player', 'viewer'));

-- -------------------------------------------------------- plays of the week --
-- The coach's whiteboard. `diagram` holds one versioned document describing
-- the whole play: where the pieces start, the paths they run, and which
-- numbered step each movement belongs to. It is stored whole and replaced
-- whole — a diagram is edited as one drawing, never field by field, and
-- shredding it into rows would buy nothing but joins.
CREATE TABLE IF NOT EXISTS plays (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  subtitle     TEXT,
  category     TEXT NOT NULL DEFAULT 'other'
               CHECK (category IN ('breakout','forecheck','powerplay','penaltykill',
                                   'faceoff','neutralzone','dzone','drill','other')),
  surface      TEXT NOT NULL DEFAULT 'full'
               CHECK (surface IN ('full','ozone','nzone','dzone')),
  diagram      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  -- The Monday of the week this is the play for. Null means "evergreen": a
  -- systems page the coach wants up all season rather than a weekly feature.
  week_of      DATE,
  game_id      TEXT,                            -- optional contract id, if it's for one fixture
  published_at TIMESTAMPTZ,
  author_id    BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plays_board_idx
  ON plays (status, week_of DESC NULLS LAST, published_at DESC NULLS LAST);

-- ------------------------------------------------------------ moderation --
-- Anything a parent or a player writes is scanned before it lands. High
-- severity is held back from the site until an admin clears it; everything
-- else publishes and is queued for a look.
CREATE TABLE IF NOT EXISTS flagged_content (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  author_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  surface     TEXT NOT NULL,          -- 'job_note', 'comment', ...
  ref_id      TEXT,                   -- game id, comment id, whatever it hangs off
  body        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('high','medium','low')),
  findings    JSONB NOT NULL,
  held        BOOLEAN NOT NULL DEFAULT false,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','removed')),
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS flagged_pending_idx ON flagged_content (status, at DESC);

-- Training goals are independent from scoresheet goals. Team targets pool
-- contributions; player targets belong to exactly one roster player.
CREATE TABLE IF NOT EXISTS training_goals (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 100),
  scope TEXT NOT NULL CHECK (scope IN ('team', 'player')),
  player_id TEXT,
  unit TEXT NOT NULL CHECK (unit IN ('shots', 'reps', 'minutes', 'seconds')),
  target INT NOT NULL CHECK (target BETWEEN 1 AND 1000000),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL CHECK (ends_on >= starts_on),
  archived BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope = 'team' AND player_id IS NULL)
      OR (scope = 'player' AND player_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS goal_entries (
  id BIGSERIAL PRIMARY KEY,
  goal_id BIGINT NOT NULL REFERENCES training_goals(id),
  player_id TEXT NOT NULL,
  amount INT NOT NULL CHECK (amount BETWEEN 1 AND 1000000),
  performed_on DATE NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  removed_by BIGINT REFERENCES users(id),
  UNIQUE (created_by, client_id)
);
CREATE INDEX IF NOT EXISTS goal_entries_goal_idx ON goal_entries (goal_id, id DESC);

-- Shared authentication throttles, independent from account existence.
CREATE TABLE IF NOT EXISTS auth_limits (
  key TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS auth_limits_started_idx ON auth_limits (started_at);

-- Login comparison is case-insensitive; uniqueness must be too. Existing
-- duplicates fail this migration explicitly instead of choosing an account.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_idx ON users (lower(email));

-- Erase an account without deleting team records or breaking foreign keys.
ALTER TABLE goal_entries ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE game_results DROP CONSTRAINT IF EXISTS game_results_updated_by_fkey;
ALTER TABLE game_results ADD CONSTRAINT game_results_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE game_stats DROP CONSTRAINT IF EXISTS game_stats_updated_by_fkey;
ALTER TABLE game_stats ADD CONSTRAINT game_stats_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE news_posts DROP CONSTRAINT IF EXISTS news_posts_author_id_fkey;
ALTER TABLE news_posts ADD CONSTRAINT news_posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE player_profiles DROP CONSTRAINT IF EXISTS player_profiles_updated_by_fkey;
ALTER TABLE player_profiles ADD CONSTRAINT player_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE game_notes DROP CONSTRAINT IF EXISTS game_notes_author_id_fkey;
ALTER TABLE game_notes ADD CONSTRAINT game_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE uploads DROP CONSTRAINT IF EXISTS uploads_uploaded_by_fkey;
ALTER TABLE uploads ADD CONSTRAINT uploads_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE game_jobs DROP CONSTRAINT IF EXISTS game_jobs_claimed_by_fkey;
ALTER TABLE game_jobs ADD CONSTRAINT game_jobs_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE game_jobs DROP CONSTRAINT IF EXISTS game_jobs_updated_by_fkey;
ALTER TABLE game_jobs ADD CONSTRAINT game_jobs_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE plays DROP CONSTRAINT IF EXISTS plays_author_id_fkey;
ALTER TABLE plays ADD CONSTRAINT plays_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE flagged_content DROP CONSTRAINT IF EXISTS flagged_content_reviewed_by_fkey;
ALTER TABLE flagged_content ADD CONSTRAINT flagged_content_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE training_goals DROP CONSTRAINT IF EXISTS training_goals_created_by_fkey;
ALTER TABLE training_goals ADD CONSTRAINT training_goals_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE goal_entries DROP CONSTRAINT IF EXISTS goal_entries_created_by_fkey;
ALTER TABLE goal_entries ADD CONSTRAINT goal_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE goal_entries DROP CONSTRAINT IF EXISTS goal_entries_removed_by_fkey;
ALTER TABLE goal_entries ADD CONSTRAINT goal_entries_removed_by_fkey FOREIGN KEY (removed_by) REFERENCES users(id) ON DELETE SET NULL;
