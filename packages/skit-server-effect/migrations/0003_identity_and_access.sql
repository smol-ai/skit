CREATE TABLE user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  expiresAt INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  authorizationGeneration INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_session_user ON session(userId);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope TEXT,
  password TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX idx_account_user ON account(userId);
CREATE UNIQUE INDEX idx_account_issuer_account ON account(issuer, accountId);

CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX idx_verification_identifier ON verification(identifier);

CREATE TABLE rateLimit (
  id TEXT PRIMARY KEY,
  key TEXT,
  count INTEGER,
  lastRequest INTEGER
);

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  better_auth_user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'tombstoned')),
  authorization_generation INTEGER NOT NULL DEFAULT 1 CHECK (authorization_generation > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE server_operators (
  principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE server_bootstrap (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  claimed_at TEXT NOT NULL,
  claimed_by TEXT NOT NULL REFERENCES server_operators(principal_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE personal_access_tokens (
  token_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  authorization_generation INTEGER NOT NULL CHECK (authorization_generation > 0),
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pat_principal ON personal_access_tokens(principal_id, created_at DESC);

CREATE TABLE teams (
  team_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug = lower(slug)),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE team_memberships (
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, principal_id)
) WITHOUT ROWID;

CREATE TABLE namespaces (
  namespace_slug TEXT PRIMARY KEY CHECK (namespace_slug = lower(namespace_slug)),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('principal', 'team')),
  subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE resource_grants (
  grant_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('principal', 'team')),
  subject_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('namespace', 'skit', 'library', 'release')),
  resource_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'change', 'advance', 'publish', 'admin')),
  created_at TEXT NOT NULL,
  UNIQUE(subject_kind, subject_id, resource_kind, resource_id, permission)
);
CREATE INDEX idx_resource_grants_lookup
  ON resource_grants(resource_kind, resource_id, permission, subject_kind, subject_id);

CREATE TABLE libraries (
  library_id TEXT PRIMARY KEY,
  owner_subject_kind TEXT NOT NULL CHECK (owner_subject_kind IN ('principal', 'team')),
  owner_subject_id TEXT NOT NULL,
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_subject_kind, owner_subject_id)
);

CREATE TABLE library_revisions (
  revision_id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(library_id) ON DELETE CASCADE,
  parent_revision_id TEXT,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_library_revisions_library ON library_revisions(library_id, created_at DESC);

ALTER TABLE releases ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'unlisted', 'private'));
