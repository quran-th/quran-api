# Thai translation audio: progress

State on 2026-11-17. Runbook: `docs/TRANSLATION_AUDIO_REBUILD.md`. Set `v1`, source Al-Mukhtasar (source 4).

## Live in production (generated, built, uploaded, `verify.mjs` passed)

| Surahs | Juz                          |
| ------ | ---------------------------- |
| 1      | 1                            |
| 2–36   | 1–22 (and 36:1–27 of juz 22) |
| 78–114 | 30                           |

23 of 30 juz are complete: 1–22 and 30. Juz 23 is partial (36 is live, 37–39 are not).

## Not live

| Surahs | State                                                                 |
| ------ | --------------------------------------------------------------------- |
| 37     | 83 of 182 clips generated, first missing 37:83. Not built or uploaded |
| 38–41  | no clips                                                              |
| 42–77  | not started                                                           |

Left to generate for 37–77: 773 clips, 218,677 characters.

ElevenLabs credits ran out during the surah 37 run (HTTP 401 `quota_exceeded`). At about 0.22 credits per character (measured from the quota errors) the rest needs about 48,000 credits. The API key has no `user_read` permission, so the balance cannot be read from the scripts.

## Resuming

From `quran-api/`, once credits are back:

```bash
node scripts/translation-audio/generate.mjs --provider elevenlabs --set v1 --surahs 37-77 --dry-run
node --env-file=.dev.vars scripts/translation-audio/generate.mjs --provider elevenlabs --set v1 --surahs 37-45 --max-chars 150000
```

Generation resumes where it stopped. Work in batches of about 150–250K characters and rerun until the dry run shows 0 clips. A surah can only be built when all its clips exist, so build, upload and verify only the surahs that are complete:

```bash
node scripts/translation-audio/build.mjs --set v1 --surahs <complete surahs>
CLOUDFLARE_ACCOUNT_ID=385ad1b28e23a1ece214b76c9e13bb4f node scripts/translation-audio/upload.mjs --set v1 --surahs <complete surahs> --remote --i-have-approval --make-current
node scripts/translation-audio/verify.mjs --surahs <complete surahs>
```

Never run two of build, upload and verify on the same set at once. Generation for other surahs can run beside them.

Stop on HTTP 401, or a 429 whose message says quota exceeded. A 429 `concurrent_limit_exceeded` is normal and the script retries it.

## Things to know

- **Version tag.** `build.mjs` writes `quran_database_version` (the latest `v*` tag of the `quran-database` checkout, or `--db-version`) into every mp3 and its comment. It is left out of the encode hash, so a new release does not rename files. Files built before 2026-11-17 (surahs 1 and 78–114) do not carry it.
- **Pronunciation rule.** `ฮะรอม` and `หะรอม` are spoken as `หะหร่อม` (`PRONUNCIATIONS` in `normalize.mjs`). The clips for surahs 2, 4, 5, 8, 9, 11 and 14 were regenerated with it. Surahs 17, 22, 48 and 64 contain the word and already use it.
- **Voice details.** The API no longer returns the `voice` object (provider, model, voiceId). Manifests still hold them for future fixes.
- **Not reviewed by ear.** Surahs 2–36 were not listened to for new mispronunciations. Spot-check a few clips from each batch.
- **Old R2 files.** Rebuilt surahs leave their previous files in R2 (for example 291 for surah 2 and 113 for surah 18). Upload prints and records them. Cleanup is a separate approved step that does not exist yet.
