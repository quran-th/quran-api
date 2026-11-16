import { compareRows, rowKey } from "./canonical.mjs";
import { formatCsv, parseCsvObjects } from "./csv.mjs";

export const CHANGES_HEADER = [
  "source",
  "sura",
  "aya",
  "footnote",
  "old",
  "new",
];

const compareRefs = (a, b) => {
  const [suraA, ayaA] = a.split(":").map(Number);
  const [suraB, ayaB] = b.split(":").map(Number);
  return suraA - suraB || ayaA - ayaB;
};

/**
 * Diffs canonical rows by (sura, aya, footnote). A row missing on one side counts as empty text,
 * which is how changes/<version>.csv encodes added (old empty) and removed (new empty) rows.
 * @param {Array|null} previous canonical rows of the previous release, or null when there is none
 */
export function diffSource(slug, previous, current) {
  if (previous === null)
    return {
      slug,
      initial: true,
      changes: [],
      rows: [],
      refs: [],
      footnotesChanged: 0,
      added: 0,
      removed: 0,
    };
  const before = new Map(previous.map((row) => [rowKey(row), row]));
  const after = new Map(current.map((row) => [rowKey(row), row]));
  const keys = new Map([...before, ...after].map(([key, row]) => [key, row]));
  const changes = [];
  for (const row of [...keys.values()].sort(compareRows)) {
    const key = rowKey(row);
    const oldText = before.get(key)?.text ?? "";
    const newText = after.get(key)?.text ?? "";
    if (oldText === newText) continue;
    changes.push({
      sura: row.sura,
      aya: row.aya,
      footnote: row.footnote,
      old: oldText,
      new: newText,
    });
  }
  const refs = [
    ...new Set(changes.map((change) => `${change.sura}:${change.aya}`)),
  ].sort(compareRefs);
  const verseChanges = changes.filter((change) => change.footnote === "");
  return {
    slug,
    initial: false,
    changes,
    rows: changes.map((change) => [
      slug,
      change.sura,
      change.aya,
      change.footnote,
      change.old,
      change.new,
    ]),
    refs,
    footnotesChanged: changes.length - verseChanges.length,
    added: verseChanges.filter((change) => change.old === "").length,
    removed: verseChanges.filter((change) => change.new === "").length,
  };
}

export function formatChanges(diffs) {
  return formatCsv([CHANGES_HEADER, ...diffs.flatMap((diff) => diff.rows)]);
}

export function parseChanges(text) {
  return parseCsvObjects(text, CHANGES_HEADER);
}

/** Rebuilds the canonical rows before a release by applying the `old` side of its change rows. */
export function revertChanges(current, changeRecords, slug) {
  const rows = new Map(current.map((row) => [rowKey(row), { ...row }]));
  for (const record of changeRecords) {
    if (record.source !== slug) continue;
    const row = {
      sura: record.sura,
      aya: record.aya,
      footnote: record.footnote,
      text: record.old,
    };
    if (record.old === "") rows.delete(rowKey(row));
    else rows.set(rowKey(row), row);
  }
  return [...rows.values()].sort(compareRows);
}
