-- OAuth 2.1 authorization server for the remote MCP endpoint (/mcp).
-- Clients come from Dynamic Client Registration (RFC 7591) or Client ID Metadata Documents.
-- Every secret (client secret, authorization code, access/refresh token) is stored as a SHA-256 hash.
-- All timestamps are UTC ISO-8601 strings produced by Date#toISOString (lexicographically comparable).

CREATE TABLE IF NOT EXISTS oauth_clients (
  -- Opaque id for registered clients; the HTTPS document URL for metadata-document clients.
  client_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('dcr', 'cimd')),
  client_secret_hash TEXT,
  token_endpoint_auth_method TEXT NOT NULL CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  client_name TEXT NOT NULL,
  client_uri TEXT,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  created_ip_hash TEXT,
  created_at TEXT NOT NULL,
  -- Last successful metadata-document fetch (cimd only).
  fetched_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_ip ON oauth_clients (created_ip_hash, created_at);

-- Authorization requests waiting for sign-in and consent. Keeps long PKCE/state parameters out of
-- the login `next` URL; a request is bound to the first member who views its consent screen.
CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
  redirect_uri TEXT NOT NULL,
  state TEXT,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  user_id TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
  user_id TEXT NOT NULL REFERENCES users (id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Single use: set atomically on exchange; a second exchange revokes the tokens it produced.
  used_at TEXT
);

-- One row per issued access/refresh pair. `family_id` links every rotation of one grant so reuse
-- of a rotated refresh token (or of the authorization code) revokes the whole family.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
  user_id TEXT NOT NULL REFERENCES users (id),
  access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT UNIQUE,
  scopes TEXT NOT NULL,
  audience TEXT NOT NULL,
  created_at TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT,
  rotated_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_client ON oauth_tokens (user_id, client_id);

CREATE TABLE IF NOT EXISTS oauth_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
  scopes TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  UNIQUE (user_id, client_id)
);
