ALTER TABLE `quran_translations` DROP COLUMN `translation`;
--> statement-breakpoint
DROP INDEX IF EXISTS `verse_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_qt_unique` ON `quran_translations` (`surah_number`,`verse_number`);