// Reports one release step to the release index; used for the manual steps (tag, githubRelease).
import { putStep } from "./lib/releaseIndex.mjs";

const STEPS = [
  "dbApply",
  "export",
  "verify",
  "tag",
  "githubRelease",
  "audioRegen",
];
const STATUSES = ["pending", "running", "done", "failed", "skipped"];
const USAGE = `usage: node scripts/quran-database/report-step.mjs <version> <step> <status> [detail]
  step: ${STEPS.join(" | ")}
  status: ${STATUSES.join(" | ")}`;

const [version, step, status, ...detail] = process.argv.slice(2);
if (!version || !STEPS.includes(step) || !STATUSES.includes(status)) {
  console.error(USAGE);
  process.exit(1);
}
try {
  await putStep(version, step, status, detail.join(" "));
  console.log(`reported ${step} ${status} for ${version}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
