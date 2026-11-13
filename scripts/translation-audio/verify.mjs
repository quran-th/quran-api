// Checks the translation audio as the player receives it: the part URLs and offsets from the API,
// the audio streamed with range requests (ffmpeg, like a browser's media element), so a stale
// edge cache shows up here exactly as it would for a reader.
//
//   node scripts/translation-audio/verify.mjs                  # every surah in the set's index.json
//   node scripts/translation-audio/verify.mjs --surahs 78,101  [--api https://api.quran.in.th]
//
// Per part (the whole surah, or one ayah of a split surah): the decoded length must match the
// part's durationMs, and every ayah's startMs - part.startMs must land on its lead-in silence
// (build.mjs --lead-ms), and each part must span the timeline up to the next part. When the API
// also serves the whole-surah audioUrl (what clients from before parts play), that file gets the
// same length and absolute lead-in checks. When the set is built locally, the timings are also
// checked against it: no clip may be newer than its surah's build, the API's durationMs, parts
// and every ayah's startMs/endMs/part must equal the local build's, and a locally built whole file
// must be served as audioUrl. Exit code 1 when any surah fails. Needs ffmpeg.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { parseArgs, parseSurahs, setDir, limit } from './common.mjs'

const run = promisify(execFile)
const args = parseArgs()
const api = (args.api && args.api !== true ? String(args.api) : 'https://api.quran.in.th').replace(/\/$/, '')
// Lead-in is digital silence; speech sits around -20 dBFS
const LEAD_MAX_DB = -50
const LENGTH_TOLERANCE_MS = 30
// One limit across all surahs: a split surah has a part per ayah
const decodeLimit = limit(6)

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null)

// The set's index (local build, else the published one) lists what must be served, so a surah
// the API does not serve is a failure instead of silently skipped
async function surahList() {
  if (args.surahs && args.surahs !== true) return parseSurahs(args.surahs)
  for (let s = 1; s <= 114; s++) {
    const res = await fetch(`${api}/translation-audio/${s}`).catch(() => null)
    if (!res?.ok) continue
    const { data } = await res.json()
    const local = await readJson(path.join(setDir(data.set), 'index.json'))
    if (local) return local.surahs
    const audio = data.parts?.[0]?.audioUrl ?? data.audioUrl
    const published = await fetch(`${audio.slice(0, audio.indexOf(`/${data.set}/`))}/${data.set}/index.json`).then((r) => (r.ok ? r.json() : null), () => null)
    if (published) return published.surahs
    throw new Error(`no index.json found for set ${data.set}; pass --surahs`)
  }
  throw new Error(`${api} serves no translation audio`)
}
// API responses and manifests from before parts describe one whole-surah file
const partsOf = (m) => m.parts ?? [{ index: 0, startMs: 0, durationMs: m.durationMs, firstAyah: m.ayahs[0].ayah, lastAyah: m.ayahs[m.ayahs.length - 1].ayah, audioUrl: m.audioUrl }]

// A regenerated clip shifts every later ayah, so the build must postdate every clip and the
// API must serve exactly the build's offsets; otherwise readers get the old timings
async function timingProblems(chapter, data) {
  const local = await readJson(path.join(setDir(data.set), 'surahs', `${chapter}.json`))
  if (!local) return { problems: [], note: 'no local build, timing compare skipped' }
  const problems = []
  const builtAt = Date.parse(local.generatedAt)
  const newer = []
  for (const a of local.ayahs) {
    const clip = await readJson(path.join(setDir(data.set), 'clips', String(chapter), `${a.ayah}.json`))
    if (clip && Date.parse(clip.createdAt) > builtAt) newer.push(a.ayah)
  }
  if (newer.length) problems.push(`clips newer than the build (rebuild): ${newer.join(',')}`)
  if (data.durationMs !== local.durationMs) problems.push(`API durationMs ${data.durationMs} != local build ${local.durationMs}`)
  if (local.audioPath && !data.audioUrl) problems.push('local build has a whole file but the API serves no audioUrl (clients from before parts get no audio)')
  const localParts = partsOf(local)
  const apiParts = partsOf(data)
  const partsDiffer = apiParts.filter((p, i) => { const l = localParts[i]; return !l || l.startMs !== p.startMs || l.durationMs !== p.durationMs || l.firstAyah !== p.firstAyah || l.lastAyah !== p.lastAyah }).map((p) => p.index)
  if (partsDiffer.length || apiParts.length !== localParts.length) {
    problems.push(data.parts ? `API parts differ from local build (upload?): parts ${partsDiffer.join(',') || 'count'}` : `API has no parts while the local build has ${localParts.length}: old Worker?`)
  }
  const byAyah = new Map(local.ayahs.map((a) => [a.ayah, a]))
  const differ = data.ayahs.filter((a) => { const l = byAyah.get(a.ayah); return !l || l.startMs !== a.startMs || l.endMs !== a.endMs || (data.parts && (l.part ?? 0) !== a.part) }).map((a) => a.ayah)
  if (differ.length || data.ayahs.length !== local.ayahs.length) problems.push(`API timings differ from local build (upload?): ayahs ${differ.join(',') || 'count'}`)
  return { problems }
}

async function verifyPart(part, ayahs) {
  const { stdout } = await decodeLimit(() => run('ffmpeg', ['-v', 'error', '-i', part.audioUrl, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1 << 30 }))
  const pcm = new Int16Array(stdout.buffer, stdout.byteOffset, stdout.byteLength >> 1)
  const db = (m0, m1) => {
    let sum = 0, n = 0
    for (let i = Math.floor(m0 * 16); i < Math.min(pcm.length, m1 * 16); i++) { const x = pcm[i] / 32768; sum += x * x; n++ }
    return n ? 20 * Math.log10(Math.sqrt(sum / n) + 1e-9) : -200
  }
  const decodedMs = Math.floor(pcm.length / 16)
  const off = ayahs.filter((a) => { const at = a.startMs - part.startMs; return db(at + 20, at + 200) > LEAD_MAX_DB }).map((a) => a.ayah)
  return { decodedMs, off, lengthOk: Math.abs(decodedMs - part.durationMs) <= LENGTH_TOLERANCE_MS }
}

async function verify(chapter) {
  const res = await fetch(`${api}/translation-audio/${chapter}?t=${Date.now()}`)
  if (!res.ok) return { ok: false, line: `${String(chapter).padStart(3)}: FAIL API ${res.status}, not served (manifest or audio missing from R2? if the upload record is stale, upload --all)` }
  const { data } = await res.json()
  const timing = await timingProblems(chapter, data)
  const parts = partsOf(data)
  // Clients from before parts play the whole file with absolute offsets
  const checkWhole = data.audioUrl && !(parts.length === 1 && parts[0].audioUrl === data.audioUrl)
  const [wholeResult, ...results] = await Promise.all([
    checkWhole ? verifyPart({ audioUrl: data.audioUrl, startMs: 0, durationMs: data.durationMs }, data.ayahs) : null,
    ...parts.map((p) => verifyPart(p, data.ayahs.filter((a) => (a.part ?? 0) === p.index))),
  ])
  const off = results.flatMap((r) => r.off)
  const badLength = parts.flatMap((p, i) => results[i].lengthOk ? [] : [`${p.index} (decoded ${results[i].decodedMs} ms, manifest ${p.durationMs} ms)`])
  // Each part must span its slice of the timeline up to the next part (a gap included)
  const offTimeline = parts.filter((p, i) => Math.abs(p.durationMs - ((parts[i + 1]?.startMs ?? data.durationMs) - p.startMs)) > LENGTH_TOLERANCE_MS).map((p) => p.index)
  const decodedMs = results.reduce((sum, r) => sum + r.decodedMs, 0)
  const problems = [
    ...(badLength.length && parts.length > 1 ? [`part lengths off: ${badLength.join(', ')}`] : []),
    ...(offTimeline.length ? [`part durations off the surah timeline: ${offTimeline.join(',')}`] : []),
    ...(off.length ? [`ayah starts off their lead-in: ${off.join(',')}`] : []),
    ...(wholeResult && !wholeResult.lengthOk ? [`whole file decoded ${wholeResult.decodedMs} ms != manifest ${data.durationMs} ms`] : []),
    ...(wholeResult?.off.length ? [`whole file: ayah starts off their lead-in: ${wholeResult.off.join(',')}`] : []),
    ...timing.problems,
  ]
  const ok = (parts.length > 1 || badLength.length === 0) && problems.length === 0
  const head = parts.length > 1 ? `${parts.length} parts, decoded ${decodedMs} ms in total${wholeResult ? `, whole decoded ${wholeResult.decodedMs} ms` : ''}` : `decoded ${decodedMs} ms`
  return { ok, line: `${String(chapter).padStart(3)}: ${ok ? 'ok' : 'FAIL'} ${head}, manifest ${data.durationMs} ms` + [...problems, ...(timing.note ? [timing.note] : [])].map((e) => `, ${e}`).join('') }
}

const surahs = await surahList()
const results = []
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let s = surahs.shift(); s; s = surahs.shift()) {
    try { results.push([s, await verify(s)]) } catch (e) { results.push([s, { ok: false, line: `${String(s).padStart(3)}: FAIL ${e.message}` }]) }
  }
}))
results.sort((a, b) => a[0] - b[0])
for (const [, r] of results) if (!r.ok || args.verbose) console.log(r.line)
const failed = results.filter(([, r]) => !r.ok).length
console.log(`${results.length} surahs checked, ${failed} failed`)
if (failed) process.exit(1)
