CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL CONSTRAINT users_username_format_check
    CHECK (username ~ '^[A-Za-z0-9_-]{3,40}$'),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS admin_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_sessions_user_id_idx ON admin_sessions(user_id);
CREATE INDEX IF NOT EXISTS admin_sessions_active_token_idx ON admin_sessions(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS vote_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  question TEXT NOT NULL CHECK (LENGTH(TRIM(question)) > 0),
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS vote_sessions_user_id_idx ON vote_sessions(user_id);
CREATE INDEX IF NOT EXISTS vote_sessions_active_user_idx ON vote_sessions(user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS answers (
  id UUID PRIMARY KEY,
  vote_session_id UUID NOT NULL REFERENCES vote_sessions(id) ON DELETE CASCADE,
  answer_text TEXT NOT NULL CHECK (LENGTH(TRIM(answer_text)) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, vote_session_id),
  UNIQUE (vote_session_id, sort_order)
);

CREATE INDEX IF NOT EXISTS answers_vote_session_id_idx ON answers(vote_session_id);

CREATE TABLE IF NOT EXISTS votes (
  id UUID PRIMARY KEY,
  vote_session_id UUID NOT NULL REFERENCES vote_sessions(id) ON DELETE CASCADE,
  answer_id UUID NOT NULL,
  guest_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guest_id, vote_session_id),
  FOREIGN KEY (answer_id, vote_session_id)
    REFERENCES answers(id, vote_session_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS votes_vote_session_id_idx ON votes(vote_session_id);
CREATE INDEX IF NOT EXISTS votes_guest_id_idx ON votes(guest_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS votes_answer_id_idx ON votes(answer_id);
