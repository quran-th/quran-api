# Thai translation audio pipeline

Per-ayah clips (source of truth) -> one mp3 per surah, or one per ayah for a long surah,

- manifest per surah -> R2.
  Nothing generated is committed: `scripts/data/translation-audio/` and
  `scripts/data/mukhtasar-th-snapshot.json` are git-ignored.

Run from `quran-api/`. Commands in order:

```bash
# 1. Text snapshot (read-only against production, 50 ayahs per request, sequential)
node scripts/translation-audio/snapshot.mjs

# 2. Normalization report (what gets sent to TTS)
node scripts/translation-audio/normalize.mjs

# 3. Dry run: characters, clips to (re)generate, cost at $0.08 and $0.04 per 1K chars
node scripts/translation-audio/generate.mjs --provider elevenlabs --set v1 --surahs 1,78-114 --dry-run

# 4. Generate clips
node scripts/translation-audio/generate.mjs --provider say --set placeholder-kanya --surahs 1,112     # [--rate 180]
# Voice, model, settings and format default to config.mjs; flags override them
node --env-file=.dev.vars scripts/translation-audio/generate.mjs --provider elevenlabs \
  --set v1 --surahs 1,78-114 [--ayahs 2:255 --voice <id> --model <model_id> --stability 0.5 --similarity 0.96 \
  --format mp3_44100_128 --seed 1 --concurrency 3 --max-chars 50000 --force]

# 5. Stitch into surah mp3 (or per-ayah parts) + manifest + index
node scripts/translation-audio/build.mjs --set placeholder-kanya --surahs 1,112 [--lead-ms 250 --gap-ms 0 --allow-missing]
#    [--split-above-mb 20 --resplit --no-whole]

# 6. Upload to LOCAL R2 (bucket quran-assets)
node scripts/translation-audio/upload.mjs --set placeholder-kanya [--surahs 1,112] [--make-current] [--all]
# Production: only with both flags, after approval
node scripts/translation-audio/upload.mjs --set v1 --remote --i-have-approval [--make-current] [--api <url> --skip-api-check]

# 7. Verify what readers get: streams each part, and the whole file when served, like the player
#    (API URLs + range requests) and checks its length and that every ayah starts on its lead-in
#    silence. With the set built locally it also checks the timings: no clip newer than its
#    surah's build, the API's parts and offsets equal to the build's, and a built whole file served.
#    Run after every production upload.
node scripts/translation-audio/verify.mjs [--surahs 78,101]

# Voices and models (needs the key)
node --env-file=.dev.vars scripts/translation-audio/providers.mjs voices
```

## Text rules

`normalize.mjs` exports the pure function `normalizeForSpeech` and the ordered rule list `RULES`
(`node normalize.mjs --rules` prints it; `--show 2:37,1:1` prints before/after). The snapshot
text is never modified; only the text sent to TTS changes. Zero-width/control characters are
stripped first, then:

1. **arabic**: Remove Arabic-script runs and the brackets or quotes left empty around them (Thai transliterations stay).
2. **cross-reference**: Square-bracket references "[name:N]" are read out as ", ซูเราะฮฺname อายะฮฺที่ N, " with a pause on each side.
3. **numbers**: Ranges "55-56" become "55 ถึง 56"; a list numeral "1-(" or "1-word" becomes "1 " before the text. Other numbers stay as digits.
4. **parentheses**: Parentheses are dropped and their words read as part of the sentence, with no pause: "กล่าวเท็จ (ต่อเจ้า) และ" becomes "กล่าวเท็จต่อเจ้า และ". A number before "(" keeps a space.
5. **aside-dashes**: En dash or hyphen asides next to Thai letters (" –text- ") become ", ". Hyphens inside names and between digits are kept.
6. **quotes**: Quote characters (" “ ” ‘ ’ ') and the bullet • are dropped.
7. **stray-latin**: Latin letters stuck to Thai letters (source typos) are removed. Standalone Latin words are kept.
8. **pronunciation**: Words the voice mispronounces are swapped from the `PRONUNCIATIONS` list in `normalize.mjs`: "ญะฮันนัม" is sent as "Jahannam" (the Thai spelling came out as ญะ-หัน-นัม) and "สุญูด" as "สุหญูด" (low tone on the second syllable). Add a `[written, spoken]` pair for new cases, and test one clip before regenerating.
9. **cleanup**: Collapse whitespace and repeated commas, remove space before and stray leading or trailing commas, trim.

## Hash and resume

Each clip is `clips/<surah>/<ayah>.mp3` plus `.json` metadata. `textHash` is the sha256 of
normalizedText, provider, model, voiceId, JSON of settings and seed (newline separated).
A clip whose json already has the same hash is skipped, so runs are resumable and idempotent;
changing text, voice, model, settings or seed regenerates it. `--force` regenerates everything.
`--max-chars` stops before the budget would be exceeded. Failed clips are listed and exit code is 1;
rerun to continue.

## Build

Clips are decoded to mono 44.1 kHz PCM, each preceded by an exact-sample lead-in silence
(`--lead-ms`, default 250; `startMs` points at the lead so a late seek or a play() that drops
its first buffers still reaches the first syllable), optionally separated by `--gap-ms`, and
encoded once at mp3 64 kbps. Offsets come from decoded sample counts, and the final file is
ffprobed and compared with the computed length (drift is printed).
Missing clips fail the build unless `--allow-missing`.

## Parts

A surah whose whole file would pass `--split-above-mb` (default 20, decimal MB, estimated from
the clips' length at 64 kbps = 8000 bytes/s) is also split into one part per ayah. Once a set has
a complete manifest with `parts` for a surah, the split decision sticks, so a surah near the line
does not flip on every text fix; `--resplit` decides by size again. Manifests from before parts
and `--allow-missing` builds record no decision.

All audio is named by its content (first 8 hex of the sha256 of the mp3 bytes):

- whole file: `surahs/<surah>.<hash8>.mp3`, R2 key `translation-audio/mukhtasar-th/<set>/<surah>.<hash8>.mp3`
- part: `surahs/<surah>/<ayah>.<hash8>.mp3`, R2 key `translation-audio/mukhtasar-th/<set>/<surah>/<ayah>.<hash8>.mp3`

Changed audio gets a new key and no upload overwrites audio, so a reader with a cached older
manifest, or an upload interrupted at any step, still gets audio that matches its offsets.
Manifests from before this still point at `<surah>.mp3`; the API keeps serving them.

Each part is that ayah's lead-in + clip, encoded on its own with the same settings and ID3 tags
(the ayah is in the title). The manifest `surahs/<surah>.json` keeps one absolute timeline:

- `parts: [{ index, audioPath, startMs, durationMs, firstAyah, lastAyah, pcmHash, encodeHash }]`,
  always at least one. `startMs` is where the part starts on the surah timeline, `durationMs`
  the part file's measured length, `pcmHash` the sha256 of its PCM, `encodeHash` the sha256 of
  the encode settings and ID3 tags. An unsplit surah has one part whose `audioPath` is the whole
  file.
- each ayah has `part` (index into `parts`); its `startMs`/`endMs` stay absolute, so the offset
  inside the part file is `ayah.startMs - part.startMs`.
- `durationMs` is the surah's total length. `audioPath` is the whole file, with its
  `audioPcmHash` and `audioEncodeHash`.

A file whose `pcmHash` and `encodeHash` match the previous manifest and that still exists is not
re-encoded (a tag or bitrate change re-encodes it), so fixing one clip makes one new part and one
new whole file. The year in the tags is not part of `encodeHash`: unchanged files keep their name
across a new year, and only re-encoded files carry the new year.

A surah is built atomically: new files are encoded into `<set>/.build-<surah>/`, every part and
the whole file get a drift check (the largest is printed), and only when every |drift| is within
30 ms are the files moved into place and the manifest written. Otherwise the build exits 1 and
that surah's previous files and manifest stay as they were. Audio the new manifest no longer
references is deleted locally after the manifest is written.

**Whole file:** a split surah still gets a whole file (and `audioPath`) by default, because web
clients from before parts only play the whole-surah `audioUrl`. Only build with `--no-whole`
once those clients are gone and cached API responses have expired.

`upload.mjs` puts the parts (6 at a time), then the whole file, then the manifest, then
`index.json`/`current.json`. After the first failed put it starts no new put, does not upload the
manifest and exits 1. Audio keys already put to the same bucket are skipped: they are recorded in
`<set>/.uploaded-<local|remote>-<account id>-<bucket>.json` (remote account from
`CLOUDFLARE_ACCOUNT_ID`, else `wrangler whoami`). If the bucket lost objects anyway (wiped local
state, deleted elsewhere), `--all` puts everything again. Manifests are always put. Nothing is
deleted from R2; recorded keys the manifest no longer references are counted, for a separately
approved cleanup.

Before a `--remote` upload, the live API (`--api`, default https://api.quran.in.th) must serve
`parts` for a published surah; a Worker from before parts reads `<set>/<surah>.mp3` and would
pair an old whole file with the new offsets. `--skip-api-check` overrides.

`GET /translation-audio/:chapter` returns `parts` (each `audioUrl` with `?v=<etag>`) and the
deprecated `audioUrl` while the whole file exists. Manifests from before parts are served as a
single part, and so is a split surah whose part objects are missing but whose whole file exists.
`verify.mjs` checks every part and, when the API serves `audioUrl`, the whole file as well.
Without `--surahs` it checks every surah in the set's `index.json` and fails a surah the API
does not serve.

## API key

`ELEVENLABS_API_KEY` lives in the git-ignored `.dev.vars`; scripts only read
`process.env.ELEVENLABS_API_KEY`, so run them with `node --env-file=.dev.vars`. The key is never
printed or written. `--dry-run` and the `say` provider do not need it; a real elevenlabs run
without it exits with a clear error before any request.
