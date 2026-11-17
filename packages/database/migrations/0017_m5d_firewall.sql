CREATE TABLE IF NOT EXISTS firewall_open_ports (
  name TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS firewall_blocks (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('ipv4','ipv6')),
  cidr TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
