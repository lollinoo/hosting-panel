SET SESSION lock_wait_timeout = 30;
SELECT 'D', s.SCHEMA_NAME, COALESCE(t.sz, 0) FROM information_schema.SCHEMATA s LEFT JOIN (SELECT TABLE_SCHEMA, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS sz FROM information_schema.TABLES WHERE (TABLE_SCHEMA = 'wp_a9a7ce0f2a3a' OR TABLE_SCHEMA LIKE 'wp\_a9a7ce0f2a3a\_%') AND TABLE_SCHEMA NOT REGEXP '[\t\n\r]' GROUP BY TABLE_SCHEMA) t ON t.TABLE_SCHEMA = s.SCHEMA_NAME WHERE (s.SCHEMA_NAME = 'wp_a9a7ce0f2a3a' OR s.SCHEMA_NAME LIKE 'wp\_a9a7ce0f2a3a\_%') AND s.SCHEMA_NAME NOT REGEXP '[\t\n\r]';
SELECT 'U', User, '' FROM mysql.user WHERE Host = '%' AND (User = 'wp_a9a7ce0f2a3a' OR User LIKE 'wp\_a9a7ce0f2a3a\_%' OR User = 'pma_a9a7ce0f2a3a') AND User NOT REGEXP '[\t\n\r]';
SELECT 'G', User, Db FROM mysql.db WHERE Host = '%' AND (User = 'wp_a9a7ce0f2a3a' OR User LIKE 'wp\_a9a7ce0f2a3a\_%' OR User = 'pma_a9a7ce0f2a3a') AND User NOT REGEXP '[\t\n\r]' AND Db NOT REGEXP '[\t\n\r]';
-- buildSiteDatabasesBatch createDatabase wp_a9a7ce0f2a3a_shop
SET SESSION lock_wait_timeout = 30;
REVOKE ALL PRIVILEGES ON `wp\_a9a7ce0f2a3a\_shop`.* FROM 'wp_a9a7ce0f2a3a_app'@'%';
CREATE DATABASE `wp_a9a7ce0f2a3a_shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALTER, ALTER ROUTINE, CREATE, CREATE ROUTINE, CREATE TEMPORARY TABLES, CREATE VIEW, DELETE, DELETE HISTORY, DROP, EVENT, EXECUTE, INDEX, INSERT, LOCK TABLES, REFERENCES, SELECT, SHOW CREATE ROUTINE, SHOW VIEW, TRIGGER, UPDATE ON `wp\_a9a7ce0f2a3a\_shop`.* TO 'pma_a9a7ce0f2a3a'@'%';
