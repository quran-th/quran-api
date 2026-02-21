CREATE TABLE `contributors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'contributor',
	`password_hash` text,
	`oauth_provider` text,
	`oauth_id` text,
	`is_active` integer DEFAULT true,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contributors_email_unique` ON `contributors` (`email`);
--> statement-breakpoint
CREATE INDEX `idx_contributors_email` ON `contributors` (`email`);
--> statement-breakpoint
CREATE INDEX `idx_contributors_oauth` ON `contributors` (`oauth_provider`, `oauth_id`);
--> statement-breakpoint
CREATE TABLE `word_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`surah_number` integer NOT NULL,
	`verse_number` integer NOT NULL,
	`word_position` integer NOT NULL,
	`arabic_text` text NOT NULL,
	`thai_meaning` text NOT NULL,
	`contributor_id` integer,
	`status` text DEFAULT 'pending',
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`contributor_id`) REFERENCES `contributors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_word_translations_verse` ON `word_translations` (`surah_number`, `verse_number`);
--> statement-breakpoint
CREATE INDEX `idx_word_translations_unique` ON `word_translations` (`surah_number`, `verse_number`, `word_position`, `contributor_id`);
--> statement-breakpoint
ALTER TABLE `contributions` ADD COLUMN `contributor_id` integer REFERENCES `contributors`(`id`);
