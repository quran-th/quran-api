// RFC 4180 writer and strict reader. Records end with LF; CR/LF inside a field is kept verbatim.

const NEEDS_QUOTES = /[",\r\n]/;
const EDGE_WHITESPACE = /^\s|\s$/;

// Fields with leading/trailing whitespace are quoted too, so no line ends in raw whitespace
// while the stored text stays byte-identical.
export function formatField(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (NEEDS_QUOTES.test(text) || EDGE_WHITESPACE.test(text))
    return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function formatCsv(rows) {
  return rows.map((row) => row.map(formatField).join(",")).join("\n") + "\n";
}

/**
 * Strict parser: every record must have the same field count, quotes may only open a field,
 * a quoted field must be followed by a separator or record end, and the text must end with LF.
 * @returns {string[][]}
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) throw new Error("CSV starts with a BOM");
  if (text.length > 0 && !text.endsWith("\n"))
    throw new Error("CSV does not end with a newline");
  const rows = [];
  let row = [];
  let i = 0;
  const length = text.length;
  while (i < length) {
    let field = "";
    if (text[i] === '"') {
      i++;
      for (;;) {
        if (i >= length)
          throw new Error(
            `unterminated quoted field in record ${rows.length + 1}`,
          );
        const ch = text[i];
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += ch;
        i++;
      }
      if (i < length && text[i] !== "," && text[i] !== "\n") {
        throw new Error(
          `unexpected character after closing quote in record ${rows.length + 1}`,
        );
      }
    } else {
      while (i < length && text[i] !== "," && text[i] !== "\n") {
        if (text[i] === '"')
          throw new Error(
            `bare quote in unquoted field in record ${rows.length + 1}`,
          );
        if (text[i] === "\r")
          throw new Error(
            `bare CR in unquoted field in record ${rows.length + 1}`,
          );
        field += text[i];
        i++;
      }
    }
    row.push(field);
    if (text[i] === ",") {
      i++;
      if (i >= length) throw new Error("CSV ends after a separator");
      continue;
    }
    rows.push(row);
    row = [];
    i++;
  }
  const width = rows[0]?.length;
  rows.forEach((record, index) => {
    if (record.length !== width) {
      throw new Error(
        `record ${index + 1} has ${record.length} fields, expected ${width}`,
      );
    }
  });
  return rows;
}

/** Parses a CSV whose first record must equal `header`, returning the data records as objects. */
export function parseCsvObjects(text, header) {
  const [first, ...records] = parseCsv(text);
  if (!first || first.join(",") !== header.join(",")) {
    throw new Error(
      `unexpected CSV header: ${first?.join(",")} (expected ${header.join(",")})`,
    );
  }
  return records.map((record) =>
    Object.fromEntries(header.map((name, index) => [name, record[index]])),
  );
}
