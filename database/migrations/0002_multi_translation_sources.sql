-- translation_sources: metadata per translation book/author
CREATE TABLE `translation_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`short_name` text,
	`author` text,
	`language` text NOT NULL DEFAULT 'th',
	`description` text,
	`is_default` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint

-- Seed the default source from existing data
INSERT INTO `translation_sources` (`id`, `name`, `short_name`, `author`, `language`, `is_default`)
VALUES (1, 'ฉบับดั้งเดิม', 'ดั้งเดิม', NULL, 'th', 1);
--> statement-breakpoint

-- verse_translations: one row per (source, surah, verse)
CREATE TABLE `verse_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`surah_number` integer NOT NULL,
	`verse_number` integer NOT NULL,
	`translation_text` text NOT NULL,
	`is_verified` integer NOT NULL DEFAULT 0,
	`last_updated` integer NOT NULL DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`source_id`) REFERENCES `translation_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vt_unique` ON `verse_translations` (`source_id`, `surah_number`, `verse_number`);
--> statement-breakpoint
CREATE INDEX `idx_vt_surah` ON `verse_translations` (`source_id`, `surah_number`);
--> statement-breakpoint

-- Migrate existing translations from quran_translations into source 1
INSERT INTO `verse_translations` (`source_id`, `surah_number`, `verse_number`, `translation_text`, `is_verified`, `last_updated`)
SELECT 1, `surah_number`, `verse_number`, `translation`, `is_verified`, `last_updated`
FROM `quran_translations`;
--> statement-breakpoint

-- translation_footnotes: footnotes linked to a verse_translation row
-- footnote_number is relative to the verse (resets per verse), matching (*N*) markers in translation_text
CREATE TABLE `translation_footnotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`verse_translation_id` integer NOT NULL,
	`footnote_number` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`verse_translation_id`) REFERENCES `verse_translations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fn_unique` ON `translation_footnotes` (`verse_translation_id`, `footnote_number`);
--> statement-breakpoint

-- Add source linkage columns to contributions
ALTER TABLE `contributions` ADD COLUMN `source_id` integer REFERENCES `translation_sources`(`id`);
--> statement-breakpoint
ALTER TABLE `contributions` ADD COLUMN `verse_translation_id` integer REFERENCES `verse_translations`(`id`);
--> statement-breakpoint

-- Backfill source_id = 1 for all existing contributions
UPDATE `contributions` SET `source_id` = 1;
--> statement-breakpoint

-- Backfill verse_translation_id for existing contributions
UPDATE `contributions`
SET `verse_translation_id` = (
	SELECT vt.`id`
	FROM `verse_translations` vt
	WHERE vt.`source_id` = 1
	  AND vt.`surah_number` = (SELECT `surah_number` FROM `quran_translations` WHERE `id` = `contributions`.`translation_id`)
	  AND vt.`verse_number` = (SELECT `verse_number` FROM `quran_translations` WHERE `id` = `contributions`.`translation_id`)
)
WHERE `translation_id` IS NOT NULL;
