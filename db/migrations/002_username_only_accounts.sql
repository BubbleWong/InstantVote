DROP INDEX IF EXISTS users_email_lower_unique;

ALTER TABLE users
  DROP COLUMN IF EXISTS email;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_username_format_check;

ALTER TABLE users
  ADD CONSTRAINT users_username_format_check
  CHECK (username ~ '^[A-Za-z0-9_-]{3,40}$');
