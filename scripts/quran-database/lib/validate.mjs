import { footnoteMismatch } from "./markers.mjs";

export const EXPECTED_COUNTS = Object.freeze({
  surahs: 114,
  verses: 6236,
  contiguousSurahs: true,
});

/** Only for fixture runs: a partial Quran with any ascending surah ids. */
export function testExpectedCounts(surahs, verses) {
  return Object.freeze({ surahs, verses, contiguousSurahs: false });
}

function describeMismatch(ref, mismatch) {
  const parts = [];
  if (mismatch.missingFootnotes.length)
    parts.push(`marker ${mismatch.missingFootnotes.join(",")} has no footnote`);
  if (mismatch.missingMarkers.length)
    parts.push(`footnote ${mismatch.missingMarkers.join(",")} has no marker`);
  return `${ref}: ${parts.join("; ")}`;
}

/**
 * Checks one source. Empty translations and marker/footnote mismatches are errors unless the
 * matching allow flag is set; they are always returned so the release can record them.
 */
export function validateSource(
  sourceId,
  surahs,
  {
    expected = EXPECTED_COUNTS,
    allowEmpty = false,
    allowFootnoteMismatch = false,
  } = {},
) {
  const errors = [];
  const emptyTranslations = [];
  const footnoteMismatches = [];
  const label = `source ${sourceId}`;
  if (surahs.length !== expected.surahs)
    errors.push(
      `${label}: ${surahs.length} surahs, expected ${expected.surahs}`,
    );
  let verseCount = 0;
  let previousSurah = 0;
  for (const surah of surahs) {
    if (!(surah.id > previousSurah))
      errors.push(`${label}: surah ${surah.id} is out of order`);
    if (expected.contiguousSurahs && surah.id !== previousSurah + 1)
      errors.push(`${label}: surah ${previousSurah + 1} is missing`);
    previousSurah = surah.id;
    if (surah.verses.length !== surah.versesCount) {
      errors.push(
        `${label}: surah ${surah.id} has ${surah.verses.length} verses, verses_count says ${surah.versesCount}`,
      );
    }
    surah.verses.forEach((verse, index) => {
      verseCount++;
      const ref = `${surah.id}:${verse.aya}`;
      if (verse.sura !== surah.id || verse.aya !== index + 1) {
        errors.push(
          `${label}: surah ${surah.id} verse ${index + 1} is numbered ${verse.aya} (not contiguous)`,
        );
      }
      if (typeof verse.translation !== "string") {
        errors.push(`${label}: ${ref} has no translation string`);
        return;
      }
      if (typeof verse.arabic !== "string" || verse.arabic.trim() === "")
        errors.push(`${label}: ${ref} has no Arabic text`);
      if (verse.translation.trim() === "") emptyTranslations.push(ref);
      const numbers = verse.footnotes.map((note) => note.number);
      if (new Set(numbers).size !== numbers.length)
        errors.push(`${label}: ${ref} repeats a footnote number`);
      for (const note of verse.footnotes) {
        if (
          !Number.isInteger(note.number) ||
          note.number < 1 ||
          note.number > 99
        ) {
          errors.push(
            `${label}: ${ref} footnote number ${note.number} is outside 1..99`,
          );
        }
        if (typeof note.text !== "string" || note.text.trim() === "")
          errors.push(`${label}: ${ref} footnote ${note.number} is empty`);
      }
      const mismatch = footnoteMismatch(verse);
      if (mismatch) footnoteMismatches.push(describeMismatch(ref, mismatch));
    });
  }
  if (verseCount !== expected.verses)
    errors.push(`${label}: ${verseCount} verses, expected ${expected.verses}`);
  if (emptyTranslations.length && !allowEmpty) {
    errors.push(
      `${label}: ${emptyTranslations.length} empty translations (pass --allow-empty to publish them): ${emptyTranslations.join(", ")}`,
    );
  }
  if (footnoteMismatches.length && !allowFootnoteMismatch) {
    errors.push(
      `${label}: ${footnoteMismatches.length} verses whose footnote markers and footnotes disagree (pass --allow-footnote-mismatch to publish them):\n  ${footnoteMismatches.join("\n  ")}`,
    );
  }
  return { errors, emptyTranslations, footnoteMismatches };
}
