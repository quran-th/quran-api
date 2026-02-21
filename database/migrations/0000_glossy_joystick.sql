CREATE TABLE `changelog` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`translation_id` integer,
	`old_text` text NOT NULL,
	`new_text` text NOT NULL,
	`version_tag` text NOT NULL,
	`changed_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`translation_id`) REFERENCES `quran_translations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `contributions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`translation_id` integer,
	`suggested_translation` text NOT NULL,
	`contributor_name` text NOT NULL,
	`status` text DEFAULT 'pending',
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`translation_id`) REFERENCES `quran_translations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `issue_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`translation_id` integer,
	`fingerprint` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`translation_id`) REFERENCES `quran_translations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quran_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`surah_number` integer NOT NULL,
	`verse_number` integer NOT NULL,
	`content` text NOT NULL,
	`translation` text NOT NULL,
	`is_verified` integer DEFAULT false,
	`last_updated` integer DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE INDEX `idx_reports_translation_id` ON `issue_reports` (`translation_id`);--> statement-breakpoint
CREATE INDEX `surah_idx` ON `quran_translations` (`surah_number`);--> statement-breakpoint
CREATE INDEX `verse_idx` ON `quran_translations` (`verse_number`);