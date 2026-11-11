-- 7:38 (sources 2, 3): stray space splits "พวกเขา" ("them"; Arabic أُخْرَاهُمْ).
-- 76:17 (source 3): "พวก" is missing "เขา" (Arabic وَيُسْقَوْنَ, third person).
INSERT INTO changelog(translation_id, old_text, new_text, version_tag)
SELECT NULL, translation_text, replace(translation_text, 'ของพวก เขาก็', 'ของพวกเขาก็'), 'v2026-11-10-typo-7-38-src' || source_id
FROM verse_translations
WHERE surah_number = 7 AND verse_number = 38 AND source_id IN (2, 3) AND instr(translation_text, 'ของพวก เขาก็') > 0;

UPDATE verse_translations
SET translation_text = replace(translation_text, 'ของพวก เขาก็', 'ของพวกเขาก็'), last_updated = strftime('%s', 'now')
WHERE surah_number = 7 AND verse_number = 38 AND source_id IN (2, 3) AND instr(translation_text, 'ของพวก เขาก็') > 0;

INSERT INTO changelog(translation_id, old_text, new_text, version_tag)
SELECT NULL, translation_text, replace(translation_text, 'นั้นพวกจะได้รับ', 'นั้นพวกเขาจะได้รับ'), 'v2026-11-10-typo-76-17-src3'
FROM verse_translations
WHERE surah_number = 76 AND verse_number = 17 AND source_id = 3 AND instr(translation_text, 'นั้นพวกจะได้รับ') > 0;

UPDATE verse_translations
SET translation_text = replace(translation_text, 'นั้นพวกจะได้รับ', 'นั้นพวกเขาจะได้รับ'), last_updated = strftime('%s', 'now')
WHERE surah_number = 76 AND verse_number = 17 AND source_id = 3 AND instr(translation_text, 'นั้นพวกจะได้รับ') > 0;
