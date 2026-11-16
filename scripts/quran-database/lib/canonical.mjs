import { formatCsv, parseCsvObjects } from "./csv.mjs";

export const CANONICAL_HEADER = ["surah", "ayah", "footnote", "text"];

/** Row key "surah:ayah" for a verse row, "surah:ayah:n" for its footnote n. */
export const rowKey = (row) =>
  row.footnote === ""
    ? `${row.surah}:${row.ayah}`
    : `${row.surah}:${row.ayah}:${row.footnote}`;

export function compareRows(a, b) {
  const footnote = (row) => (row.footnote === "" ? 0 : Number(row.footnote));
  return (
    Number(a.surah) - Number(b.surah) ||
    Number(a.ayah) - Number(b.ayah) ||
    footnote(a) - footnote(b)
  );
}

/** `verses` in mushaf order; each verse row is followed by its footnote rows, ascending by number. */
export function toCanonicalRows(verses) {
  return verses.flatMap((verse) => [
    {
      surah: String(verse.surah),
      ayah: String(verse.ayah),
      footnote: "",
      text: verse.translation,
    },
    ...[...verse.footnotes]
      .sort((a, b) => a.number - b.number)
      .map((note) => ({
        surah: String(verse.surah),
        ayah: String(verse.ayah),
        footnote: String(note.number),
        text: note.text,
      })),
  ]);
}

export function formatCanonicalRows(rows) {
  return formatCsv([
    CANONICAL_HEADER,
    ...rows.map((row) => [row.surah, row.ayah, row.footnote, row.text]),
  ]);
}

export const formatCanonical = (verses) =>
  formatCanonicalRows(toCanonicalRows(verses));

const toInt = (value, what, line) => {
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(
      `row ${line}: ${what} "${value}" is not a positive integer`,
    );
  return Number(value);
};

export function parseCanonicalRows(text) {
  return parseCsvObjects(text, CANONICAL_HEADER);
}

/**
 * Strict reader: rows must be in mushaf order, every footnote row must follow its own verse row,
 * and footnote numbers must ascend within a verse. Ayah contiguity is the verifier's job.
 * @returns {{ surah: number, ayah: number, translation: string, footnotes: { number: number, text: string }[] }[]}
 */
export function rowsToVerses(rows) {
  const verses = [];
  rows.forEach((row, index) => {
    const line = index + 2;
    const surah = toInt(row.surah, "surah", line);
    const ayah = toInt(row.ayah, "ayah", line);
    const last = verses.at(-1);
    if (row.footnote === "") {
      if (
        last &&
        (surah < last.surah || (surah === last.surah && ayah <= last.ayah))
      ) {
        throw new Error(
          `row ${line}: verse ${surah}:${ayah} breaks mushaf order after ${last.surah}:${last.ayah}`,
        );
      }
      verses.push({ surah, ayah, translation: row.text, footnotes: [] });
      return;
    }
    const number = toInt(row.footnote, "footnote", line);
    if (!last || last.surah !== surah || last.ayah !== ayah)
      throw new Error(
        `row ${line}: footnote ${surah}:${ayah}:${number} does not follow its verse row`,
      );
    const previous = last.footnotes.at(-1);
    if (previous && number <= previous.number)
      throw new Error(
        `row ${line}: footnote ${surah}:${ayah}:${number} is not ascending`,
      );
    last.footnotes.push({ number, text: row.text });
  });
  return verses;
}

export const parseCanonical = (text) => rowsToVerses(parseCanonicalRows(text));

/** Row keys whose text contains a CR or LF, so they can be fixed in the source database. */
export function embeddedLineBreaks(verses) {
  return toCanonicalRows(verses)
    .filter((row) => /[\r\n]/.test(row.text))
    .map(rowKey);
}
