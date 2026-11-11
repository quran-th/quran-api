-- Al-Mukhtasar 67:12: "ของพวก" is missing "เขา" in two places ("ของพวกเขา" = "their").
-- Locked so the source sync keeps the correction.
INSERT INTO changelog(translation_id, old_text, new_text, version_tag)
SELECT NULL, translation_text,
  replace(replace(translation_text, 'ผลตอบแทนของพวกแล้ว', 'ผลตอบแทนของพวกเขาแล้ว'), 'ผลตอบแทนของพวกด้วย', 'ผลตอบแทนของพวกเขาด้วย'),
  'v2026-11-10-typo-67-12-src4'
FROM verse_translations
WHERE surah_number = 67 AND verse_number = 12
  AND source_id IN (SELECT id FROM translation_sources WHERE external_type = 'mokhtasr')
  AND instr(translation_text, 'ผลตอบแทนของพวกแล้ว') > 0
  AND instr(translation_text, 'ผลตอบแทนของพวกด้วย') > 0;

UPDATE verse_translations
SET translation_text = replace(replace(translation_text, 'ผลตอบแทนของพวกแล้ว', 'ผลตอบแทนของพวกเขาแล้ว'), 'ผลตอบแทนของพวกด้วย', 'ผลตอบแทนของพวกเขาด้วย'),
  last_updated = strftime('%s', 'now'),
  is_locked = 1
WHERE surah_number = 67 AND verse_number = 12
  AND source_id IN (SELECT id FROM translation_sources WHERE external_type = 'mokhtasr')
  AND instr(translation_text, 'ผลตอบแทนของพวกแล้ว') > 0
  AND instr(translation_text, 'ผลตอบแทนของพวกด้วย') > 0;
