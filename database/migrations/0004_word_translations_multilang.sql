-- Add multi-language support to word_translations
-- Adds: language, transliteration columns
-- Renames: thai_meaning → meaning

ALTER TABLE `word_translations` ADD COLUMN `language` text;
--> statement-breakpoint
ALTER TABLE `word_translations` ADD COLUMN `transliteration` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `word_translations` RENAME COLUMN `thai_meaning` TO `meaning`;
--> statement-breakpoint
-- Backfill any existing rows (should be none, but safety net)
UPDATE `word_translations` SET `language` = 'th' WHERE `language` IS NULL;
