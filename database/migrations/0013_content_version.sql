-- Public reader responses are cached at the edge under this version
-- (src/middleware/edgeCache.ts). Triggers bump it on any change to what
-- readers see, so raw SQL from the proofing and release runbooks
-- invalidates the cache without extra steps.
CREATE TABLE IF NOT EXISTS content_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
INSERT OR IGNORE INTO content_version (id, version) VALUES (1, 1);

CREATE TRIGGER IF NOT EXISTS content_version_vt_insert AFTER INSERT ON verse_translations
BEGIN
  UPDATE content_version SET version = version + 1 WHERE id = 1;
END;

-- The Mukhtasar sync rewrites rows on revalidation; only a real text or
-- verification change should invalidate the cache.
CREATE TRIGGER IF NOT EXISTS content_version_vt_update AFTER UPDATE OF translation_text, is_verified ON verse_translations
WHEN OLD.translation_text IS NOT NEW.translation_text OR OLD.is_verified IS NOT NEW.is_verified
BEGIN
  UPDATE content_version SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS content_version_vt_delete AFTER DELETE ON verse_translations
BEGIN
  UPDATE content_version SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS content_version_fn_insert AFTER INSERT ON translation_footnotes
BEGIN
  UPDATE content_version SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS content_version_fn_update AFTER UPDATE ON translation_footnotes
BEGIN
  UPDATE content_version SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS content_version_fn_delete AFTER DELETE ON translation_footnotes
BEGIN
  UPDATE content_version SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS content_version_qt_update AFTER UPDATE OF content ON quran_translations
WHEN OLD.content IS NOT NEW.content
BEGIN
  UPDATE content_version SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS content_version_src_insert AFTER INSERT ON translation_sources
BEGIN
  UPDATE content_version SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS content_version_src_update AFTER UPDATE ON translation_sources
BEGIN
  UPDATE content_version SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS content_version_src_delete AFTER DELETE ON translation_sources
BEGIN
  UPDATE content_version SET version = version + 1 WHERE id = 1;
END;
