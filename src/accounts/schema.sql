-- No foreign keys, so the schema works on PlanetScale/Vitess as well as MySQL. Integrity is enforced in code.
CREATE TABLE IF NOT EXISTS orgs (
    id                          VARCHAR(32)  NOT NULL PRIMARY KEY,
    name                        VARCHAR(200) NOT NULL,
    included_minutes            INT UNSIGNED NOT NULL,
    overage_cents_per_minute    INT UNSIGNED NOT NULL,
    created_at                  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS projects (
    id          VARCHAR(32)  NOT NULL PRIMARY KEY,
    org_id      VARCHAR(32)  NOT NULL,
    name        VARCHAR(200) NOT NULL,
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY projects_org_name (org_id, name)
);

-- Only a SHA-256 of each token is stored. A token belongs to an org and can be narrowed to one project.
CREATE TABLE IF NOT EXISTS api_tokens (
    id            VARCHAR(32)  NOT NULL PRIMARY KEY,
    token_hash    CHAR(64)     NOT NULL,
    org_id        VARCHAR(32)  NOT NULL,
    project_id    VARCHAR(32)  NULL,
    scopes        VARCHAR(200) NOT NULL,
    name          VARCHAR(200) NOT NULL,
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_used_at  DATETIME(3)  NULL,
    revoked_at    DATETIME(3)  NULL,
    UNIQUE KEY api_tokens_hash (token_hash),
    KEY api_tokens_org (org_id)
);
