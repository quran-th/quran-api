// Stored verse texts mark footnotes inline as "(*n*)", where n is the footnote number within the verse.
// The marker rewriting for the output formats lives in the data repository's converter.
const MARKER = /\(\*(\d+)\*\)/g;

export function markerNumbers(text) {
  return [...text.matchAll(MARKER)].map((match) => Number(match[1]));
}

/** Compares marker and footnote numbers as sets; a repeated marker for one footnote is allowed. */
export function footnoteMismatch(verse) {
  const markers = new Set(markerNumbers(verse.translation));
  const notes = new Set(verse.footnotes.map((note) => note.number));
  const missingFootnotes = [...markers]
    .filter((n) => !notes.has(n))
    .sort((a, b) => a - b);
  const missingMarkers = [...notes]
    .filter((n) => !markers.has(n))
    .sort((a, b) => a - b);
  if (missingFootnotes.length === 0 && missingMarkers.length === 0) return null;
  return { missingFootnotes, missingMarkers };
}
