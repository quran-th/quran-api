import { parseCsvObjects } from "./csv.mjs";

export const CLASSES = [
  "spelling",
  "punctuation",
  "marker",
  "wordChanged",
  "wordsAdded",
  "wordsRemoved",
  "rowAdded",
  "rowRemoved",
];
export const CLASS_LABELS = {
  spelling: "แก้คำสะกด (spelling)",
  punctuation: "วรรคตอน (punctuation)",
  marker: "เชิงอรรถเครื่องหมาย (marker)",
  wordChanged: "เปลี่ยนคำ (word changed)",
  wordsAdded: "เพิ่มคำ (words added)",
  wordsRemoved: "ลบคำ (words removed)",
  rowAdded: "แถวใหม่ (row added)",
  rowRemoved: "แถวที่ลบ (row removed)",
};
// Everything except these must be listed verse by verse in the release notes.
const UNDECLARED = new Set(["spelling", "punctuation"]);
export const isDeclared = (cls) => !UNDECLARED.has(cls);

export const OVERRIDES_HEADER = [
  "source",
  "surah",
  "ayah",
  "footnote",
  "class",
  "note",
];

const MARKER_SPLIT = /(\(\*\d+\*\))/;
const MARKER_TOKEN = /^\(\*\d+\*\)$/;
// A segment with any letter, mark or digit is a word even when ICU calls it non-word-like
// (e.g. ๆ or ฯ), so a change to it is never filed as punctuation.
const WORDISH = /[\p{L}\p{M}\p{N}]/u;
const CONTEXT_WORDS = 3;
const SHORT_ROW_WORDS = 12;
const MAX_LCS_CELLS = 25_000_000;

let segmenter;
/** Word tokens via ICU's Thai segmenter; `(*n*)` markers are atomic; whitespace/punctuation are their own tokens. */
export function tokenize(text) {
  segmenter ??= new Intl.Segmenter("th", { granularity: "word" });
  const tokens = [];
  for (const part of text.split(MARKER_SPLIT)) {
    if (part === "") continue;
    if (MARKER_TOKEN.test(part)) {
      tokens.push({ text: part, kind: "marker" });
      continue;
    }
    for (const { segment, isWordLike } of segmenter.segment(part)) {
      tokens.push({
        text: segment,
        kind: isWordLike || WORDISH.test(segment) ? "word" : "punct",
      });
    }
  }
  return tokens;
}

/** Levenshtein distance on code points. */
export function editDistance(a, b) {
  const left = [...a];
  const right = [...b];
  let previous = Array.from({ length: right.length + 1 }, (_, j) => j);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

/** LCS over token texts; returns the changed ranges as hunks of [oldStart, oldEnd) and [newStart, newEnd). */
export function diffTokens(oldTokens, newTokens) {
  const a = oldTokens.map((token) => token.text);
  const b = newTokens.map((token) => token.text);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) {
    return [
      {
        oldStart: prefix,
        oldEnd: prefix + n,
        newStart: prefix,
        newEnd: prefix + m,
      },
    ];
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[prefix + i] === b[prefix + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const hunks = [];
  let open = null;
  let i = 0;
  let j = 0;
  const close = () => {
    if (open) hunks.push({ ...open, oldEnd: prefix + i, newEnd: prefix + j });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] === b[prefix + j]) {
      close();
      i++;
      j++;
      continue;
    }
    open ??= { oldStart: prefix + i, newStart: prefix + j };
    if (
      j >= m ||
      (i < n && table[(i + 1) * width + j] >= table[i * width + j + 1])
    )
      i++;
    else j++;
  }
  close();
  return hunks;
}

const isSpellingPair = (before, after) => {
  const distance = editDistance(before, after);
  return (
    distance <= 2 &&
    distance * 3 <= Math.max([...before].length, [...after].length)
  );
};

/**
 * For a hunk of word tokens only, the one-word pair that differs. A misspelt word is often not in
 * ICU's dictionary, so it can segment differently from the corrected text (ล่า|มด้วยโช่ vs
 * ล่าม|ด้วย|โซ่). The pair is therefore taken at character level: the change must fall inside
 * one word of the new (corrected) side, and the old word is the same span of the old side.
 * Returns null when the change spans more than one word.
 */
export function changedWordPair(oldTokens, newTokens) {
  if (![...oldTokens, ...newTokens].every((token) => token.kind === "word"))
    return null;
  const a = [...oldTokens.map((token) => token.text).join("")];
  const b = [...newTokens.map((token) => token.text).join("")];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const coreEnd = b.length - suffix;
  let start = 0;
  for (const token of newTokens) {
    const end = start + [...token.text].length;
    if (start <= prefix && coreEnd <= end) {
      const oldWord = a.slice(start, end + a.length - b.length).join("");
      return oldWord === "" ? null : [oldWord, token.text];
    }
    start = end;
  }
  return null;
}

export function classifyHunk(oldTokens, newTokens) {
  const all = [...oldTokens, ...newTokens];
  const oldWords = oldTokens.filter((token) => token.kind === "word");
  const newWords = newTokens.filter((token) => token.kind === "word");
  if (oldWords.length === 0 && newWords.length === 0)
    return all.some((token) => token.kind === "marker")
      ? "marker"
      : "punctuation";
  if (oldWords.length === 0) return "wordsAdded";
  if (newWords.length === 0) return "wordsRemoved";
  const pair = changedWordPair(oldTokens, newTokens);
  return pair && isSpellingPair(...pair) ? "spelling" : "wordChanged";
}

const display = (text) =>
  text
    .replace(/\r\n|\r|\n/g, " ⏎ ")
    .replace(/\t/g, " ")
    .replace(/[\\*_`]/g, "\\$&");

function bold(text) {
  const [, lead, core, trail] = /^(\s*)(.*?)(\s*)$/s.exec(text);
  return core === "" ? text : `${lead}**${core}**${trail}`;
}

const joinTokens = (tokens, from, to) =>
  tokens
    .slice(from, to)
    .map((token) => token.text)
    .join("");

/** The changed tokens in bold with ~3 words of context each side, or the whole row when it is short. */
export function excerpt(tokens, start, end, full = false) {
  let from = 0;
  let to = tokens.length;
  if (!full) {
    from = start;
    for (let count = 0; from > 0 && count < CONTEXT_WORDS; )
      if (tokens[--from].kind !== "punct") count++;
    to = end;
    for (let count = 0; to < tokens.length && count < CONTEXT_WORDS; )
      if (tokens[to++].kind !== "punct") count++;
  }
  const text =
    display(joinTokens(tokens, from, start)) +
    bold(display(joinTokens(tokens, start, end))) +
    display(joinTokens(tokens, end, to));
  return `${from > 0 ? "…" : ""}${text.trim()}${to < tokens.length ? "…" : ""}`;
}

export const changeRef = (change) =>
  change.footnote === ""
    ? `${change.surah}:${change.ayah}`
    : `${change.surah}:${change.ayah} เชิงอรรถ ${change.footnote}`;

/** Splits one changed canonical row into classified hunks. */
export function analyzeChange(change) {
  const base = {
    surah: change.surah,
    ayah: change.ayah,
    footnote: change.footnote,
    ref: changeRef(change),
    note: null,
    overridden: false,
  };
  if (change.old === "" || change.new === "") {
    const cls = change.old === "" ? "rowAdded" : "rowRemoved";
    return {
      ...base,
      rowClass: cls,
      hunks: [
        {
          class: cls,
          old: change.old,
          new: change.new,
          oldExcerpt: display(change.old).trim(),
          newExcerpt: display(change.new).trim(),
        },
      ],
    };
  }
  const oldTokens = tokenize(change.old);
  const newTokens = tokenize(change.new);
  // A hunk whose text is unchanged only reflects different segmentation of the same characters.
  const changed = diffTokens(oldTokens, newTokens).filter(
    (hunk) =>
      joinTokens(oldTokens, hunk.oldStart, hunk.oldEnd) !==
      joinTokens(newTokens, hunk.newStart, hunk.newEnd),
  );
  // Both sides of a short row are shown in full, even when the typo changes the token count.
  const wordCount = (tokens) =>
    tokens.filter((token) => token.kind !== "punct").length;
  const full =
    Math.max(wordCount(oldTokens), wordCount(newTokens)) <= SHORT_ROW_WORDS;
  const hunks = changed.map((hunk) => {
    const before = oldTokens.slice(hunk.oldStart, hunk.oldEnd);
    const after = newTokens.slice(hunk.newStart, hunk.newEnd);
    const cls = classifyHunk(before, after);
    return {
      class: cls,
      pair: cls === "spelling" ? changedWordPair(before, after) : null,
      old: joinTokens(oldTokens, hunk.oldStart, hunk.oldEnd),
      new: joinTokens(newTokens, hunk.newStart, hunk.newEnd),
      oldExcerpt: excerpt(oldTokens, hunk.oldStart, hunk.oldEnd, full),
      newExcerpt: excerpt(newTokens, hunk.newStart, hunk.newEnd, full),
    };
  });
  return { ...base, rowClass: null, hunks };
}

export const isSpellingOnly = (analysis) =>
  analysis.hunks.every((hunk) => !isDeclared(hunk.class));

export function parseOverrides(text) {
  const records = parseCsvObjects(text, OVERRIDES_HEADER);
  const errors = [];
  const seen = new Set();
  records.forEach((record, index) => {
    const line = index + 2;
    if (
      !/^[1-9]\d*$/.test(record.surah) ||
      !/^[1-9]\d*$/.test(record.ayah) ||
      !/^([1-9]\d*)?$/.test(record.footnote)
    ) {
      errors.push(
        `overrides.csv row ${line}: surah, ayah and footnote must be positive integers (footnote may be empty)`,
      );
    }
    if (record.class !== "" && !CLASSES.includes(record.class))
      errors.push(
        `overrides.csv row ${line}: unknown class "${record.class}" (use one of ${CLASSES.join(", ")})`,
      );
    if (record.class === "" && record.note.trim() === "")
      errors.push(
        `overrides.csv row ${line}: gives neither a class nor a note`,
      );
    const key = overrideKey(record);
    if (seen.has(key))
      errors.push(`overrides.csv row ${line}: ${key} is listed twice`);
    seen.add(key);
  });
  return { records, errors };
}

const overrideKey = (record) =>
  `${record.source} ${record.surah}:${record.ayah}${record.footnote === "" ? "" : `:${record.footnote}`}`;

/**
 * Applies overrides to the analyses of this release, keyed by slug. Returns one error per override
 * that does not name a changed row of this release or would turn a row change into something else.
 */
export function applyOverrides(analysesBySlug, records) {
  const errors = [];
  for (const record of records) {
    const key = overrideKey(record);
    const analysis = analysesBySlug[record.source]?.find(
      (entry) =>
        entry.surah === record.surah &&
        entry.ayah === record.ayah &&
        entry.footnote === record.footnote,
    );
    if (!analysis) {
      errors.push(`overrides.csv: ${key} did not change in this release`);
      continue;
    }
    if (record.class !== "") {
      const rowClasses = ["rowAdded", "rowRemoved"];
      if (
        (analysis.rowClass || rowClasses.includes(record.class)) &&
        record.class !== analysis.rowClass
      ) {
        errors.push(
          `overrides.csv: ${key} is a ${analysis.rowClass ?? "changed"} row and cannot be reclassified as ${record.class}`,
        );
        continue;
      }
      const targets = analysis.hunks.some(
        (hunk) => hunk.class !== "punctuation",
      )
        ? analysis.hunks.filter((hunk) => hunk.class !== "punctuation")
        : analysis.hunks;
      for (const hunk of targets) hunk.class = record.class;
      analysis.overridden = true;
    }
    if (record.note.trim() !== "") analysis.note = record.note.trim();
  }
  return errors;
}

export function countClasses(analyses) {
  const counts = Object.fromEntries(
    CLASSES.map((cls) => [cls, { hunks: 0, verses: new Set() }]),
  );
  for (const analysis of analyses) {
    for (const hunk of analysis.hunks) {
      counts[hunk.class].hunks++;
      counts[hunk.class].verses.add(`${analysis.surah}:${analysis.ayah}`);
    }
  }
  return Object.fromEntries(
    CLASSES.map((cls) => [
      cls,
      { hunks: counts[cls].hunks, verses: counts[cls].verses.size },
    ]),
  );
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function annotation(analysis) {
  const parts = [];
  if (analysis.overridden) parts.push("จัดประเภทเอง (manual class)");
  if (analysis.note) parts.push(`หมายเหตุ (note): ${display(analysis.note)}`);
  return parts.length ? ` — ${parts.join("; ")}` : "";
}

function renderSource({ sourceId, diff, analyses }) {
  const lines = [`## ${diff.slug} (source ${sourceId})`, ""];
  if (diff.initial)
    return [
      ...lines,
      "เผยแพร่ครั้งแรก ไม่มีการเปลี่ยนแปลง (initial release, no changes)",
      "",
    ];
  if (diff.changes.length === 0)
    return [...lines, "ไม่มีการเปลี่ยนแปลง (no changes)", ""];
  lines.push(
    `แก้ไข ${diff.refs.length} อายะฮฺ, เชิงอรรถ ${diff.footnotesChanged} รายการ (${plural(diff.refs.length, "verse")} changed, ${plural(diff.footnotesChanged, "footnote")} changed)`,
    "",
    "| ประเภท (class) | จุดแก้ (hunks) | อายะฮฺ (verses) |",
    "|---|---:|---:|",
  );
  const counts = countClasses(analyses);
  for (const cls of CLASSES)
    lines.push(
      `| ${CLASS_LABELS[cls]} | ${counts[cls].hunks} | ${counts[cls].verses} |`,
    );
  lines.push("", "### การแก้ไขที่ไม่ใช่คำสะกด (Changes beyond spelling)", "");
  let declared = 0;
  for (const analysis of analyses) {
    for (const hunk of analysis.hunks) {
      if (!isDeclared(hunk.class)) continue;
      declared++;
      lines.push(
        `- **${analysis.ref}** — ${CLASS_LABELS[hunk.class]}${annotation(analysis)}`,
      );
      lines.push(`  - เดิม (old): ${hunk.oldExcerpt || "—"}`);
      lines.push(`  - ใหม่ (new): ${hunk.newExcerpt || "—"}`);
    }
  }
  if (declared === 0) lines.push("ไม่มี (none)");
  lines.push("", "### แก้คำสะกด (Spelling fixes)", "");
  let spelling = 0;
  for (const analysis of analyses) {
    for (const hunk of analysis.hunks) {
      if (hunk.class !== "spelling") continue;
      spelling++;
      const [before, after] = hunk.pair ?? [hunk.old, hunk.new];
      lines.push(
        `- ${analysis.ref}: ${display(before).trim()} -> ${display(after).trim()}${annotation(analysis)}`,
      );
    }
  }
  if (spelling === 0) lines.push("ไม่มี (none)");
  lines.push("");
  return lines;
}

const RESOLUTION_LABELS = {
  accept: "รับตามข้อเสนอ (accepted)",
  propose: "ใช้ถ้อยคำของผู้ตรวจ (reviewer wording)",
  reject: "คงข้อความเดิม (kept)",
};

function renderTagGroups(tagGroups) {
  const lines = ["## การตัดสินใจที่ระบุไว้ (Tagged decisions)", ""];
  for (const tag of tagGroups) {
    lines.push(`### ${display(tag.name)}`, "");
    if (tag.description) lines.push(display(tag.description), "");
    for (const item of tag.items) {
      const footnote = item.footnoteNo ? ` (เชิงอรรถ ${item.footnoteNo})` : "";
      lines.push(
        `- **${item.surah}:${item.verse}**${footnote} [source ${item.sourceId}] — ${RESOLUTION_LABELS[item.resolution] ?? item.resolution}`,
        `  - เดิม (old): ${display(item.oldText).trim() || "—"}`,
      );
      if (item.newText !== null && item.newText !== undefined)
        lines.push(`  - ใหม่ (new): ${display(item.newText).trim() || "—"}`);
      if (item.note) lines.push(`  - หมายเหตุ (note): ${display(item.note)}`);
    }
    lines.push("");
  }
  return lines;
}

/** releases/<version>.md; `runtime` is process.versions, recorded because token boundaries depend on ICU. */
export function renderReleaseNotes(version, entries, runtime, tagGroups = []) {
  const lines = [`# ${version}`, ""];
  for (const entry of entries) lines.push(...renderSource(entry));
  if (tagGroups.length) lines.push(...renderTagGroups(tagGroups));
  lines.push(
    "---",
    "",
    `สร้างด้วย (generated with) Node ${runtime.node}, ICU ${runtime.icu}`,
    "",
  );
  return lines.join("\n");
}
