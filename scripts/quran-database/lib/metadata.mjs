import { createHash } from "node:crypto";

export const KNOWN_SLUGS = { 3: "king-fahd", 4: "al-mukhtasar" };

export function slugFor(sourceId) {
  return KNOWN_SLUGS[sourceId] ?? `source-${sourceId}`;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export const surahDir = (slug) => `data/${slug}`;
/** The single-file layout used before per-surah files; read once as a baseline, then removed. */
export const legacyCsvPath = (slug) => `data/${slug}.csv`;
export const metaPath = (slug) => `data/${slug}.meta.json`;

export function buildMetadata({
  source,
  slug,
  version,
  previousVersion,
  verses,
  csv,
  footnoteMismatches,
  emptyTranslations,
  embeddedLineBreaks,
}) {
  return {
    source: {
      id: source.id,
      slug,
      name: source.name,
      shortName: source.shortName,
      author: source.author,
      language: source.language,
    },
    version,
    previousVersion,
    verseCount: verses.length,
    footnoteCount: verses.reduce(
      (count, verse) => count + verse.footnotes.length,
      0,
    ),
    sha256: sha256(csv),
    emptyTranslations,
    footnoteMismatches,
    embeddedLineBreaks,
  };
}

export function formatMetadata(metadata) {
  return JSON.stringify(metadata, null, 2) + "\n";
}
