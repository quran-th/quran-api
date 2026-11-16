# quran-database release tooling

Generates the releases of [quran-th/quran-database](https://github.com/quran-th/quran-database)
(the public data repository) from the production API. The tooling lives here; the data, its
README and the format converter live in the data repository. Node >= 22, no dependencies.

```
export.mjs        fetches the API, validates, writes data/, changes/, releases/<version>.md, CHANGELOG.md
verify.mjs        checks a data checkout, including the output of its own converter
release.mjs       prints the release commands; runs nothing
overrides.csv     manual notes/classes for the release being cut (header only between releases)
lib/              exporter, canonical CSV reader/writer, diff, release notes, validation
test/             node:test suite and an offline API fixture
```

Every command works on a **data checkout**: `--db <path>`, by default `../quran-database` next to
the quran-api repository. It must be the top of a git checkout whose origin is
`github.com/quran-th/quran-database`, otherwise the command stops. Only fixture runs
(`--from-fixture`, `--test-expected-counts`) accept any folder.

```sh
git clone https://github.com/quran-th/quran-database.git ../quran-database   # once
```

## Cutting a release

Export only **after** the corpus and database fixes are in the production database. The API at
`https://api.quran.in.th` is edge-cached for up to an hour; the exporter adds a unique `_cb=<token>`
query parameter to every request, so there is no need to wait.

Versions are `YYYY.MM.DD`; a second release on the same day is `YYYY.MM.DD.2`, then `.3`, and so on.

```sh
npm run db:release -- [version] [--db DIR] [export flags]   # prints the commands below
npm run db:export -- --version 2026.11.14 --allow-footnote-mismatch
npm run db:verify
git -C ../quran-database status --short    # review data/, changes/, releases/<version>.md, CHANGELOG.md
git -C ../quran-database add data changes releases CHANGELOG.md
git -C ../quran-database commit -m "Release 2026.11.14"
git -C ../quran-database tag v2026.11.14
mkdir -p ../quran-database/out && git -C ../quran-database archive --format=zip -9 \
  --prefix=quran-database-2026.11.14/ -o ../quran-database/out/quran-database-2026.11.14.zip v2026.11.14 data/
gh release upload v2026.11.14 ../quran-database/out/quran-database-2026.11.14.zip --repo quran-th/quran-database
```

1. Read `releases/<version>.md` before committing: every change beyond spelling is listed there.
   Use `overrides.csv` to annotate or reclassify a change, then export again.
2. Pushing the commit and tag, and creating the GitHub release, are separate, manual steps. Nothing
   here pushes. Upload the zip after the GitHub release exists. It is the release asset: `data/` as
   tagged (each `<slug>.csv` with its `.meta.json`) under `quran-database-<version>/`, written to the
   git-ignored `out/` of the data checkout.
3. If `overrides.csv` had rows, empty it (keep the header) and commit that in quran-api.

### What the export does

1. Fetches `GET /translation-sources` and, per source and surah,
   `GET /surahs/:id?sourceId=N&offset=..&limit=50`. Pages are 50 verses because the API answers
   500 for `limit=100` on long surahs. It waits about 150 ms before each request, tries up to 3
   times with backoff, and runs 4 requests in parallel (`--concurrency N`).
2. Validates each source. Any failure prints every problem, writes **nothing** and exits 1:
   - 114 surahs and 6236 verses, ayat contiguous and matching `verses_count`;
   - Arabic text present in the response;
   - no empty translation (`--allow-empty` publishes them and lists them in `meta.json`);
   - every `(*n*)` marker has footnote `n` and every footnote has a marker
     (`--allow-footnote-mismatch` publishes them and lists them in `meta.json`);
   - footnote numbers unique and in 1..99, no empty footnote.
3. Builds every file in memory, then writes them: `data/<slug>.csv` + `.meta.json`, the diff
   against the previous release as `changes/<version>.csv` and `releases/<version>.md` (after
   `overrides.csv` is applied), and the `CHANGELOG.md` section.

Options: `--sources 3,4` (an unknown id gets the slug `source-<id>`), `--api URL`,
`--from-fixture DIR` (API-shaped JSON from disk), `--overrides FILE`, and
`--test-expected-counts S,V` (only with `--from-fixture`) to relax 114/6236:

```sh
node scripts/quran-database/export.mjs --version 2026.11.14 --db /tmp/qd \
  --from-fixture scripts/quran-database/test/fixtures/api --test-expected-counts 3,14
cp -R ../quran-database/scripts /tmp/qd/   # verify runs the checkout's own converter
node scripts/quran-database/verify.mjs --db /tmp/qd --test-expected-counts 3,14
```

### Re-running a release

Exporting again with the same version and input gives byte-identical files, so `git status` stays
clean.

- If the input changed, the diff is still against the **previous** release: the exporter rebuilds
  that baseline by reverting the existing `changes/<version>.csv`.
- The `## <version>` section of `CHANGELOG.md` and `releases/<version>.md` are replaced, never
  duplicated.
- A re-run must use the same `--sources`. A version older than the one in `data/` is refused.

## Release notes

`releases/<version>.md` is written from the same row diff as `changes/<version>.csv`. Every change
that is not a plain spelling fix is declared there verse by verse.

### Classification

1. Each changed row (verse or footnote) is split into word tokens with
   `new Intl.Segmenter('th', { granularity: 'word' })` (Node's ICU). Whitespace and punctuation
   are their own tokens, a `(*n*)` marker is one token, and a segment holding any letter, mark or
   digit counts as a word (so `ๆ` and `ฯ` are words).
2. Old and new tokens are diffed with an LCS; each run of changed tokens is a **hunk**.
3. Each hunk gets one class:

| Class          | Label               | When                                                                                                 |
| -------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `spelling`     | แก้คำสะกด           | one word into one word, edit distance (code points) at most 2 **and** at most 1/3 of the longer word |
| `punctuation`  | วรรคตอน             | only whitespace or punctuation changed                                                               |
| `marker`       | เชิงอรรถเครื่องหมาย | only `(*n*)` markers changed, possibly with whitespace                                               |
| `wordChanged`  | เปลี่ยนคำ           | any other replacement of words                                                                       |
| `wordsAdded`   | เพิ่มคำ             | words only on the new side                                                                           |
| `wordsRemoved` | ลบคำ                | words only on the old side                                                                           |
| `rowAdded`     | แถวใหม่             | a new verse or footnote row                                                                          |
| `rowRemoved`   | แถวที่ลบ            | a removed verse or footnote row                                                                      |

- A row whose hunks are all `spelling` or `punctuation` is a plain spelling fix; any other class
  is **declared**. When a hunk does not clearly fit `spelling`, it is declared.
- ICU often splits a misspelt word differently from its fix (`ถูก|ล่า|มด้วยโช่|ตรวน` vs
  `ถูก|ล่าม|ด้วย|โซ่|ตรวน`). For a word-only hunk the classifier therefore compares characters:
  the change must fall inside one word of the corrected text, and that word and the same span of
  the old text must pass the spelling rule. A hunk that only splits differently is ignored.
- The tests pin real fixes as `spelling`: โช่ → โซ่, สรวงสรรค์ → สรวงสวรรค์, เซาวาล → เชาวาล.
  A one-letter change in a short word also passes, e.g. `เขา` → `เรา`; record such a change with
  an override.

The notes give, per source, a table of hunks and affected verses per class; the section
**การแก้ไขที่ไม่ใช่คำสะกด (Changes beyond spelling)** with every declared hunk (reference such as
`2:197` or `2:197 เชิงอรรถ 1`, class, and `เดิม (old)` / `ใหม่ (new)` excerpts with the changed
words in bold and about 3 words of context); and **แก้คำสะกด (Spelling fixes)** with one
`ref: old -> new` line per spelling hunk. The last line records `process.versions.node` and
`process.versions.icu`: word boundaries depend on ICU, so notes are generated once per release and
committed. Re-running on the same machine reproduces them byte for byte.

### Overrides: `overrides.csv`

```
source,surah,ayah,footnote,class,note
king-fahd,2,197,,,แก้ให้ตรงกับต้นฉบับภาษาอาหรับ
king-fahd,14,49,1,spelling,
```

- One line per changed row; `source` is the slug and an empty `footnote` means the verse row.
- `class` (optional) reclassifies the row's hunks; punctuation hunks are left alone unless the
  row has nothing else. `note` is shown next to the reference, with "จัดประเภทเอง (manual class)"
  when the class was overridden.
- It applies to the release being exported. The export **fails, writing nothing**, when an
  override names a row that did not change in that release, a class is unknown, a row is listed
  twice, or a row addition/removal would be reclassified as anything else (or the reverse).
- The file has no version column, so empty it after the release is committed; otherwise the
  next release fails on rows it does not change.

## `npm run db:verify`

Exits non-zero on any problem:

- `data/` holds only `<slug>.csv` + `<slug>.meta.json` pairs.
- Canonical CSV: strict RFC 4180 parse (no bare quotes, unterminated fields, unequal field counts,
  BOM or missing final newline); mushaf order with each verse row before its ascending footnotes;
  contiguous ayat and 114/6236; byte-identical to the canonical writer's output; counts, `sha256`,
  `footnoteMismatches`, `emptyTranslations` and `embeddedLineBreaks` match `meta.json`.
- Converter: runs the checkout's own `node scripts/convert.mjs --to all --out <tmp>`, requires
  exactly the expected output files, re-parses each format against the CSV, and checks that
  canonical → JSON → canonical gives the same bytes. The converter's source of truth is the data
  repository; no copy of it lives here.
- Release files: every `changes/*.csv` parses, each version in `data/` has a `CHANGELOG.md`
  section and a `releases/<version>.md`, there is no `releases/overrides.csv` in the checkout,
  and `overrides.csv` here is well-formed.

## Known data issues

These belong to the production database and should be fixed there; the next export picks them up.

- **Footnote marker mismatches:** in 313 King Fahd verses the `(*n*)` markers and footnote numbers
  disagree. The export refuses this unless `--allow-footnote-mismatch` is given (2026.11.14 was
  cut with it). `data/king-fahd.meta.json` → `footnoteMismatches` lists them. A verse repeating a
  marker for the same footnote is not a mismatch.
- **Embedded line breaks:** 9 King Fahd verses (5:76, 6:6, 33:47, 33:62, 36:2–5, 49:9) and 2
  footnotes (5:76:1, 57:25:2) contain CRLF; they are kept, quoted, and listed in
  `embeddedLineBreaks`.
- **Edge whitespace:** 48 King Fahd translations, 50 King Fahd footnotes and 24 Al-Mukhtasar
  translations begin or end with whitespace, often a tab.
- **Basmala in the Arabic:** the API puts the basmala inside the first verse of each surah. Arabic
  is not exported, but API consumers should know.

## Tests

```sh
npm run test:quran-database
```

Offline, using `test/fixtures/api`: real API output for surahs 1, 108 and 112 of sources 3 and 4,
with a few verses edited to add edge cases (a comma and quotes, CRLF, a trailing tab, a leading
space, a multi-line footnote). The format tests import the converter from the data checkout at
`../quran-database`, so it must be cloned there.
