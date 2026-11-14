CREATE TABLE IF NOT EXISTS mail_relay_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port IN (25, 465, 587, 2525)),
  username TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  password_ciphertext_base64 TEXT NOT NULL,
  password_iv_base64 TEXT NOT NULL,
  password_auth_tag_base64 TEXT NOT NULL,
  password_key_version TEXT NOT NULL DEFAULT 'v1',
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
