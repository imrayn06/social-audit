CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT DEFAULT '',
  brand_description TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'instagram',
  ig_user_id TEXT,
  page_id TEXT,
  username TEXT DEFAULT '',
  page_name TEXT DEFAULT '',
  page_url TEXT DEFAULT '',
  profile_pic TEXT DEFAULT '',
  followers_count INTEGER DEFAULT 0,
  access_token TEXT DEFAULT '',
  connected_at INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  connection_id TEXT,
  ig_user_id TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  metrics TEXT NOT NULL DEFAULT '{}',
  scores TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_connections_client ON connections(client_id);
CREATE INDEX IF NOT EXISTS idx_audits_client ON audits(client_id, created_at DESC);
