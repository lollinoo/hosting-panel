ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS dns_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (dns_status IN ('unchecked','ok','not_found','points_elsewhere','ipv6_conflict','lookup_failed')),
  ADD COLUMN IF NOT EXISTS dns_observed JSONB NOT NULL DEFAULT '{"a":[],"aaaa":[]}'::jsonb,
  ADD COLUMN IF NOT EXISTS dns_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dns_next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS dns_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cert_status TEXT NOT NULL DEFAULT 'none'
    CHECK (cert_status IN ('none','requested','active','failed')),
  ADD COLUMN IF NOT EXISTS cert_problem TEXT
    CHECK (cert_problem IS NULL OR cert_problem IN ('rate_limited','port_80_blocked','not_pointing','caa_blocked','other')),
  ADD COLUMN IF NOT EXISTS cert_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cert_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cert_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cert_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cert_trusted BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS applied_routes_hash TEXT,
  ADD COLUMN IF NOT EXISTS applied_routes JSONB,
  ADD COLUMN IF NOT EXISTS wordpress_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_domains_one_primary_per_site ON domains (site_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_domains_dns_due ON domains (dns_next_check_at);
