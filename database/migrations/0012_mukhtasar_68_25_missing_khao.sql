-- 68:25 (source 4): "พวก" is missing "เขา" (Arabic وَغَدَوْا, third person).
INSERT INTO changelog(translation_id, old_text, new_text, version_tag)
SELECT NULL, translation_text, replace(translation_text, 'ของพวกแต่เช้าตรู่', 'ของพวกเขาแต่เช้าตรู่'), 'v2026-11-10-typo-68-25-src4'
FROM verse_translations
WHERE surah_number = 68 AND verse_number = 25 AND source_id = 4 AND instr(translation_text, 'ของพวกแต่เช้าตรู่') > 0;

UPDATE verse_translations
SET translation_text = replace(translation_text, 'ของพวกแต่เช้าตรู่', 'ของพวกเขาแต่เช้าตรู่'), last_updated = strftime('%s', 'now')
WHERE surah_number = 68 AND verse_number = 25 AND source_id = 4 AND instr(translation_text, 'ของพวกแต่เช้าตรู่') > 0;
