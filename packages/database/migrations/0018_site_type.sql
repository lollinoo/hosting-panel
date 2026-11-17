ALTER TABLE sites ADD COLUMN IF NOT EXISTS site_type TEXT;
UPDATE sites SET site_type = 'wordpress' WHERE php_version IS NOT NULL AND site_type IS NULL;
