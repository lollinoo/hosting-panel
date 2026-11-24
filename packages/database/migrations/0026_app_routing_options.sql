-- Routing options of an application address (ADR-0037): redirect to another address of the same application, password
-- protection, compression and path rules. Additive: every new column is nullable or has a default, so an address
-- without options is the row it was, and the previous release keeps running after an automatic rollback (it never
-- names these columns; an address it adds has no options). Safe to run again.
ALTER TABLE app_stack_domains ADD COLUMN IF NOT EXISTS redirect_to_domain_id TEXT;
ALTER TABLE app_stack_domains ADD COLUMN IF NOT EXISTS compression BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app_stack_domains ADD COLUMN IF NOT EXISTS access_username TEXT;
-- An "$apr1$" verifier of the password, never the password. It leaves this table only on the signed route request.
ALTER TABLE app_stack_domains ADD COLUMN IF NOT EXISTS access_password_hash TEXT;
-- [{ "pathPrefix": "/api", "componentKey": "api", "port": 3000, "stripPrefix": true }], at most four.
ALTER TABLE app_stack_domains ADD COLUMN IF NOT EXISTS path_routes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The redirect target is an address of the same application: the reference carries the stack. Removing the target
-- clears the redirect only, so the other address serves the application again.
ALTER TABLE app_stack_domains DROP CONSTRAINT IF EXISTS fk_app_stack_domains_redirect;
ALTER TABLE app_stack_domains DROP CONSTRAINT IF EXISTS uq_app_stack_domains_stack_id;
ALTER TABLE app_stack_domains ADD CONSTRAINT uq_app_stack_domains_stack_id UNIQUE (stack_id, id);
ALTER TABLE app_stack_domains ADD CONSTRAINT fk_app_stack_domains_redirect FOREIGN KEY (stack_id, redirect_to_domain_id)
  REFERENCES app_stack_domains (stack_id, id) ON UPDATE NO ACTION ON DELETE SET NULL (redirect_to_domain_id);

ALTER TABLE app_stack_domains DROP CONSTRAINT IF EXISTS ck_app_stack_domains_redirect_not_self;
ALTER TABLE app_stack_domains ADD CONSTRAINT ck_app_stack_domains_redirect_not_self
  CHECK (redirect_to_domain_id IS NULL OR redirect_to_domain_id <> id);

ALTER TABLE app_stack_domains DROP CONSTRAINT IF EXISTS ck_app_stack_domains_access_pair;
ALTER TABLE app_stack_domains ADD CONSTRAINT ck_app_stack_domains_access_pair
  CHECK ((access_username IS NULL) = (access_password_hash IS NULL));

-- The same shapes the contracts check (APP_ROUTE_USERNAME_PATTERN, APP_ROUTE_PASSWORD_HASH_PATTERN): a plain password
-- cannot be stored here by mistake.
ALTER TABLE app_stack_domains DROP CONSTRAINT IF EXISTS ck_app_stack_domains_access_shape;
ALTER TABLE app_stack_domains ADD CONSTRAINT ck_app_stack_domains_access_shape
  CHECK (access_username IS NULL OR (
    access_username ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'
    AND access_password_hash ~ '^[$]apr1[$][./0-9A-Za-z]{8}[$][./0-9A-Za-z]{22}$'
  ));

ALTER TABLE app_stack_domains DROP CONSTRAINT IF EXISTS ck_app_stack_domains_path_routes;
ALTER TABLE app_stack_domains ADD CONSTRAINT ck_app_stack_domains_path_routes
  CHECK (CASE WHEN jsonb_typeof(path_routes) = 'array' THEN jsonb_array_length(path_routes) <= 4 ELSE FALSE END);

-- A redirecting address serves nothing itself: it takes no protection and no path rule.
ALTER TABLE app_stack_domains DROP CONSTRAINT IF EXISTS ck_app_stack_domains_redirect_alone;
ALTER TABLE app_stack_domains ADD CONSTRAINT ck_app_stack_domains_redirect_alone
  CHECK (redirect_to_domain_id IS NULL OR (access_username IS NULL AND path_routes = '[]'::jsonb));

-- A fingerprint of the addresses and options the last successful route publication of the application was made from,
-- whatever the health of its targets, bound to the applied_routes_hash written with it: the saved ones differ from it
-- while a change is not published yet. NULL = not known (published by the previous release) or nothing published; a
-- release that does not know this column and writes applied_routes_hash leaves a value that no longer matches.
ALTER TABLE app_stacks ADD COLUMN IF NOT EXISTS applied_addresses_hash TEXT;
