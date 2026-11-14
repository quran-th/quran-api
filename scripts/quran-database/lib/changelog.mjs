import { CLASSES, CLASS_LABELS } from "./notes.mjs";

const TITLE = "# Changelog";

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** `entries`: { sourceId, diff, counts } where counts come from notes.countClasses. */
export function renderSection(version, entries) {
  const lines = [
    `## ${version}`,
    "",
    `Release notes: [releases/${version}.md](releases/${version}.md)`,
    "",
  ];
  for (const { sourceId, diff, counts } of entries) {
    lines.push(`### ${diff.slug} (source ${sourceId})`, "");
    if (diff.initial) {
      lines.push("initial release", "");
      continue;
    }
    if (diff.refs.length === 0) {
      lines.push("no changes", "");
      continue;
    }
    let summary = `${plural(diff.refs.length, "verse")} changed, ${plural(diff.footnotesChanged, "footnote")} changed`;
    if (diff.added || diff.removed)
      summary += ` (${diff.added} added, ${diff.removed} removed)`;
    const classes = CLASSES.filter((cls) => counts[cls].hunks > 0).map(
      (cls) => `${CLASS_LABELS[cls]}: ${counts[cls].hunks}`,
    );
    lines.push(summary, "", classes.join(", "), "", diff.refs.join(", "), "");
  }
  return lines.join("\n");
}

/** Newest first; a section with the same version is replaced in place, never duplicated. */
export function upsertSection(existing, version, section) {
  const body = existing?.startsWith(TITLE)
    ? existing.slice(TITLE.length).replace(/^\n+/, "")
    : "";
  const sections = body
    ? body.split(/\n(?=## )/).map((part) => part.replace(/\n+$/, "\n"))
    : [];
  const index = sections.findIndex(
    (part) => part.split("\n", 1)[0] === `## ${version}`,
  );
  const normalized = section.replace(/\n+$/, "\n");
  if (index === -1) sections.unshift(normalized);
  else sections[index] = normalized;
  return `${TITLE}\n\n${sections.join("\n")}`;
}
