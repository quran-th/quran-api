import { formatCsv, parseCsvObjects } from "./csv.mjs";

export const CANONICAL_HEADER = ["sura", "aya", "footnote", "text"];

/** Row key "sura:aya" for a verse row, "sura:aya:n" for its footnote n. */
export const rowKey = (row) =>
  row.footnote === ""
    ? `${row.sura}:${row.aya}`
    : `${row.sura}:${row.aya}:${row.footnote}`;

export function compareRows(a, b) {
  const footnote = (row) => (row.footnote === "" ? 0 : Number(row.footnote));
  return (
    Number(a.sura) - Number(b.sura) ||
    Number(a.aya) - Number(b.aya) ||
    footnote(a) - footnote(b)
  );
}

/** `verses` in mushaf order; each verse row is followed by its footnote rows, ascending by number. */
export function toCanonicalRows(verses) {
  return verses.flatMap((verse) => [
    {
      sura: String(verse.sura),
      aya: String(verse.aya),
      footnote: "",
      text: verse.translation,
    },
    ...[...verse.footnotes]
      .sort((a, b) => a.number - b.number)
      .map((note) => ({
        sura: String(verse.sura),
        aya: String(verse.aya),
        footnote: String(note.number),
        text: note.text,
      })),
  ]);
}

export function formatCanonicalRows(rows) {
  return formatCsv([
    CANONICAL_HEADER,
    ...rows.map((row) => [row.sura, row.aya, row.footnote, row.text]),
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
 * and footnote numbers must ascend within a verse. Aya contiguity is the verifier's job.
 * @returns {{ sura: number, aya: number, translation: string, footnotes: { number: number, text: string }[] }[]}
 */
export function rowsToVerses(rows) {
  const verses = [];
  rows.forEach((row, index) => {
    const line = index + 2;
    const sura = toInt(row.sura, "sura", line);
    const aya = toInt(row.aya, "aya", line);
    const last = verses.at(-1);
    if (row.footnote === "") {
      if (
        last &&
        (sura < last.sura || (sura === last.sura && aya <= last.aya))
      ) {
        throw new Error(
          `row ${line}: verse ${sura}:${aya} breaks mushaf order after ${last.sura}:${last.aya}`,
        );
      }
      verses.push({ sura, aya, translation: row.text, footnotes: [] });
      return;
    }
    const number = toInt(row.footnote, "footnote", line);
    if (!last || last.sura !== sura || last.aya !== aya)
      throw new Error(
        `row ${line}: footnote ${sura}:${aya}:${number} does not follow its verse row`,
      );
    const previous = last.footnotes.at(-1);
    if (previous && number <= previous.number)
      throw new Error(
        `row ${line}: footnote ${sura}:${aya}:${number} is not ascending`,
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
