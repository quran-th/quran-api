import { KNOWN_SLUGS } from "./metadata.mjs";
import { analyzeChange } from "./notes.mjs";

const SOURCE_IDS = Object.fromEntries(
  Object.entries(KNOWN_SLUGS).map(([id, slug]) => [slug, Number(id)]),
);

// The most significant class of a row's hunks wins.
const CLASS_PRIORITY = [
  "rowAdded",
  "rowRemoved",
  "wordsRemoved",
  "wordsAdded",
  "wordChanged",
  "marker",
  "spelling",
  "punctuation",
];

export function sourceIdForSlug(slug) {
  const id = SOURCE_IDS[slug];
  if (!id) throw new Error(`no source id known for slug "${slug}"`);
  return id;
}

export function rowClass(analysis) {
  if (analysis.rowClass) return analysis.rowClass;
  const classes = new Set(analysis.hunks.map((hunk) => hunk.class));
  return CLASS_PRIORITY.find((cls) => classes.has(cls)) ?? null;
}

/**
 * Release-index verse list from analysed changes, keyed by slug. A verse row has footnote 0; a
 * footnote row keeps its number.
 */
export function releaseVerses(analysesBySlug) {
  return Object.entries(analysesBySlug).flatMap(([slug, analyses]) =>
    analyses.map((analysis) => ({
      sourceId: sourceIdForSlug(slug),
      surah: Number(analysis.surah),
      ayah: Number(analysis.ayah),
      footnote: analysis.footnote === "" ? 0 : Number(analysis.footnote),
      class: rowClass(analysis),
    })),
  );
}

/** Verse list from the rows of a changes/<version>.csv, classified as in the release notes (no overrides). */
export function releaseVersesFromChanges(records) {
  const analysesBySlug = {};
  for (const record of records)
    (analysesBySlug[record.source] ??= []).push(analyzeChange(record));
  return releaseVerses(analysesBySlug);
}
