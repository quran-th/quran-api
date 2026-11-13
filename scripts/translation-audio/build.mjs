// Stitches a set's clips into mp3 audio per surah plus a manifest with exact per-ayah offsets.
// A surah whose whole file would pass --split-above-mb is also written as one mp3 per ayah (its parts).
import { mkdir, readFile, readdir, writeFile, rm, rmdir, open, access, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseArgs, parseSurahs, loadSnapshot, setDir, run, sha256, ffprobeDurationMs } from './common.mjs'

const args = parseArgs()
const setId = args.set
if (!setId || setId === true) throw new Error('--set is required')
const surahs = parseSurahs(args.surahs)
// Silence before each clip. `startMs` points at its start, so a player that seeks a little
// late or drops the first buffers after play() (iOS) still reaches the first syllable.
const leadMs = Number(args['lead-ms'] ?? 250)
const gapMs = Number(args['gap-ms'] ?? 0)
// Decided from the length at 64 kbps (8000 bytes/s), so nothing is encoded to decide
const splitAboveBytes = Number(args['split-above-mb'] ?? 20) * 1e6
// Web clients from before parts only play the whole-surah audioUrl
const writeWholeWhenSplit = !args['no-whole']
const root = setDir(setId)
const { ayahs } = await loadSnapshot()
const SOURCE = 'mukhtasar-th'
const PREFIX = `translation-audio/${SOURCE}/${setId}`
const ENCODE_CONCURRENCY = 6
const DRIFT_LIMIT_MS = 30
const execFileP = promisify(execFile)

const surahNames = new Map([...(await readFile(new URL('../../src/data/surahs.ts', import.meta.url), 'utf8'))
  .matchAll(/id: (\d+),[\s\S]*?name_thai: "([^"]+)"/g)].map(([, id, name]) => [Number(id), name]))
const YEAR = String(new Date().getFullYear())
// ID3v2.3 so Thai text shows in most players. The translation text belongs to Al-Mukhtasar;
// the license only covers our recording. Model and voice details stay in the manifest.
const id3Tags = (surah, ayah) => Object.entries({
  title: `${surah}. ${surahNames.get(surah)}${ayah ? ` อายะฮฺที่ ${ayah}` : ''} (คำแปลภาษาไทย)`,
  artist: 'quran.in.th',
  album_artist: 'Open Thai Quran Project',
  album: 'คำแปลอัลกุรอานภาษาไทย – อัล-มุคตะศ็อร',
  track: `${surah}/114`,
  genre: 'Quran',
  language: 'tha',
  publisher: 'quran.in.th',
  date: YEAR,
  comment: 'https://quran.in.th · คำแปลจากอัล-มุคตะศ็อร (mokhtasr.com) · เสียงสังเคราะห์ (AI)',
  copyright: `© ${YEAR} quran.in.th · CC BY-NC 4.0 · ข้อความคำแปลเป็นลิขสิทธิ์ของอัล-มุคตะศ็อร`,
}).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]).concat('-id3v2_version', '3')

// Each clip is decoded to mono 44.1 kHz 16-bit PCM, so its length is an exact sample count.
// The pieces and silences are joined as PCM and encoded once per file (mp3 64 kbps), which
// avoids the per-file encoder padding that makes joined mp3 files drift from summed durations.
const RATE = 44100
const ENCODE_ARGS = ['-c:a', 'libmp3lame', '-b:a', '64k']
const decode = async (file) => {
  const { stdout } = await execFileP('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', String(RATE), '-'], { encoding: 'buffer', maxBuffer: 1 << 30 })
  return stdout
}
const encode = (pcmFile, out, tags) => run('ffmpeg', ['-y', '-v', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', pcmFile, ...ENCODE_ARGS, ...tags, out])
// Same PCM with the same encode settings and tags gives the same file, so it is not re-encoded.
// The year is left out: a new year must not rename every part and bust every reader's cache.
const encodeHashOf = (tags) => sha256(JSON.stringify([RATE, ENCODE_ARGS, tags.map((t) => t.replaceAll(YEAR, '{year}'))]))
const hash8 = async (file) => sha256(await readFile(file)).slice(0, 8)
const silence = (ms) => { const samples = Math.round((ms * RATE) / 1000); return { samples, pcm: Buffer.alloc(samples * 2) } }
const lead = silence(leadMs)
const gap = silence(gapMs)
const msOf = (samples) => Math.round((samples * 1000) / RATE)
const exists = (file) => access(file).then(() => true, () => false)
const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null)
const localFile = (key) => path.join(root, 'surahs', ...key.slice(PREFIX.length + 1).split('/'))

await mkdir(path.join(root, 'surahs'), { recursive: true })

const report = []
const missingAll = []
const failures = []
for (const surah of surahs) {
  const list = ayahs.filter((a) => a.surah === surah)
  const clipDir = path.join(root, 'clips', String(surah))
  const have = new Set((await readdir(clipDir).catch(() => [])).filter((f) => f.endsWith('.json')).map((f) => Number(f.slice(0, -5))))
  const missing = list.filter((a) => !have.has(a.ayah)).map((a) => `${surah}:${a.ayah}`)
  if (missing.length) {
    missingAll.push(...missing)
    if (!args['allow-missing']) continue
  }
  const present = list.filter((a) => have.has(a.ayah))
  if (!present.length) continue

  const metas = []
  let estimateMs = gapMs * (present.length - 1)
  for (const a of present) {
    const m = JSON.parse(await readFile(path.join(clipDir, `${a.ayah}.json`), 'utf8'))
    metas.push(m)
    estimateMs += leadMs + (m.durationMs ?? await ffprobeDurationMs(path.join(clipDir, `${a.ayah}.mp3`)))
  }
  const manifestFile = path.join(root, 'surahs', `${surah}.json`)
  const previous = await readJson(manifestFile)
  const bySize = (estimateMs / 1000) * 8000 > splitAboveBytes
  // A surah near the threshold must not flip between split and whole on every text fix. Only a
  // complete build with parts recorded a decision (not manifests from before parts, not --allow-missing).
  const previousSplit = previous?.parts && previous.ayahs.length === list.length ? previous.parts.some((p) => p.audioPath !== previous.audioPath) : null
  const split = previousSplit === null || args.resplit ? bySize : previousSplit
  const previousParts = new Map((previous?.parts ?? []).map((p) => [p.firstAyah, p]))
  const partDir = path.join(root, 'surahs', String(surah))

  // Everything new is encoded into a staging folder and only moved into place once the whole
  // surah passed the drift check, so a failed build leaves the previous files and manifest as they were.
  // The whole file's PCM is streamed to disk, so a long surah is never held in memory.
  const stageDir = path.join(root, `.build-${surah}`)
  await mkdir(stageDir, { recursive: true })
  const temps = []
  const staged = []
  const wholePcm = path.join(stageDir, 'whole.pcm')
  const wholeTmp = path.join(stageDir, 'whole.mp3')
  temps.push(wholePcm, wholeTmp)
  const whole = !split || writeWholeWhenSplit ? await open(wholePcm, 'w') : null
  const wholeHash = createHash('sha256')
  const wholeTags = id3Tags(surah)

  const entries = []
  const parts = []
  const jobs = []
  const pending = new Set()
  const partDrifts = []
  let encoded = 0
  let samples = 0
  let wholeAudio = null
  let wholeMs = null
  let wholeDrift = null
  let committed = false
  try {
    for (let i = 0; i < present.length; i++) {
      const a = present[i]
      const pcm = await decode(path.join(clipDir, `${a.ayah}.mp3`))
      const start = samples
      const end = start + lead.samples + pcm.length / 2
      const chunks = [lead.pcm, pcm]
      // A gap belongs to the end of the part before it, so parts tile the surah's timeline
      if (gap.samples && i < present.length - 1) chunks.push(gap.pcm)
      samples = end + (chunks.length > 2 ? gap.samples : 0)
      entries.push({ ayah: a.ayah, startMs: msOf(start), endMs: msOf(end), part: split ? i : 0, textHash: metas[i].textHash })
      for (const c of chunks) { if (whole) await whole.write(c); wholeHash.update(c) }
      if (!split) continue

      const pcmHash = createHash('sha256')
      for (const c of chunks) pcmHash.update(c)
      const tags = id3Tags(surah, a.ayah)
      const part = { index: i, audioPath: null, startMs: msOf(start), durationMs: 0, firstAyah: a.ayah, lastAyah: a.ayah, pcmHash: pcmHash.digest('hex'), encodeHash: encodeHashOf(tags) }
      parts.push(part)
      const expectedMs = msOf(samples - start)
      const old = previousParts.get(a.ayah)
      if (pending.size >= ENCODE_CONCURRENCY) await Promise.race(pending)
      const job = (async () => {
        let file
        if (old && old.audioPath !== previous.audioPath && old.pcmHash === part.pcmHash && old.encodeHash === part.encodeHash && await exists(localFile(old.audioPath))) {
          part.audioPath = old.audioPath
          file = localFile(old.audioPath)
        } else {
          // Named by content: a changed ayah gets a new key, so an old build's files are never
          // overwritten and a stale client or an interrupted upload still sees matching audio
          const pcmFile = path.join(stageDir, `${a.ayah}.pcm`)
          file = path.join(stageDir, `${a.ayah}.mp3`)
          temps.push(pcmFile, file)
          await writeFile(pcmFile, Buffer.concat(chunks))
          await encode(pcmFile, file, tags)
          await rm(pcmFile, { force: true })
          const name = `${a.ayah}.${await hash8(file)}.mp3`
          part.audioPath = `${PREFIX}/${surah}/${name}`
          staged.push([file, path.join(partDir, name)])
          encoded++
        }
        part.durationMs = await ffprobeDurationMs(file)
        partDrifts.push(part.durationMs - expectedMs)
      })()
      jobs.push(job)
      pending.add(job)
      job.then(() => pending.delete(job), () => pending.delete(job))
    }
    await Promise.all(jobs)

    const wholePcmHash = wholeHash.digest('hex')
    const wholeEncodeHash = encodeHashOf(wholeTags)
    if (whole) {
      await whole.close()
      let file
      if (previous?.audioPcmHash === wholePcmHash && previous.audioEncodeHash === wholeEncodeHash && await exists(localFile(previous.audioPath))) {
        wholeAudio = previous.audioPath
        file = localFile(previous.audioPath)
      } else {
        await encode(wholePcm, wholeTmp, wholeTags)
        const name = `${surah}.${await hash8(wholeTmp)}.mp3`
        wholeAudio = `${PREFIX}/${name}`
        file = wholeTmp
        staged.push([wholeTmp, path.join(root, 'surahs', name)])
        encoded++
      }
      await rm(wholePcm, { force: true })
      wholeMs = await ffprobeDurationMs(file)
      wholeDrift = wholeMs - msOf(samples)
    }

    const cursor = msOf(samples)
    if (!split) parts.push({ index: 0, audioPath: wholeAudio, startMs: 0, durationMs: wholeMs, firstAyah: entries[0].ayah, lastAyah: entries[entries.length - 1].ayah, pcmHash: wholePcmHash, encodeHash: wholeEncodeHash })
    const maxPartDrift = Math.max(0, ...partDrifts.map(Math.abs))
    const drift = Math.max(Math.abs(wholeDrift ?? 0), maxPartDrift)
    report.push({ surah, drift })
    const note = split !== bySize ? ` (kept ${split ? 'split' : 'whole'} from the previous build; --resplit to decide by size)` : ''
    if (split) console.log(`surah ${surah}: ${entries.length} ayahs in ${parts.length} parts, ${cursor} ms, max part drift ${maxPartDrift} ms${whole ? `, whole drift ${wholeDrift} ms` : ''}, ${encoded} files encoded${note}`)
    else console.log(`surah ${surah}: ${entries.length} ayahs, ${wholeMs} ms, drift ${wholeDrift} ms, ${encoded} files encoded${note}`)
    if (drift > DRIFT_LIMIT_MS) {
      failures.push(`surah ${surah}: |drift| ${drift} ms > ${DRIFT_LIMIT_MS} ms, nothing written`)
      continue
    }

    if (split) await mkdir(partDir, { recursive: true })
    for (const [from, to] of staged) await rename(from, to)
    const manifest = {
      source: SOURCE, set: setId, surah, provider: metas[0].provider, model: metas[0].model, voiceId: metas[0].voiceId,
      generatedAt: new Date().toISOString(),
      ...(whole ? { audioPath: wholeAudio, audioPcmHash: wholePcmHash, audioEncodeHash: wholeEncodeHash } : {}),
      durationMs: split ? cursor : wholeMs, parts, ayahs: entries,
    }
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2))
    committed = true
  } finally {
    await whole?.close().catch(() => {})
    for (const file of temps) await rm(file, { force: true })
    await rmdir(stageDir).catch(() => {})
  }
  if (!committed) continue

  // Superseded audio goes only after the new manifest is written
  const referenced = new Set([...parts.map((p) => p.audioPath), ...(wholeAudio ? [wholeAudio] : [])])
  for (const f of (await readdir(partDir).catch(() => [])).filter((f) => f.endsWith('.mp3'))) {
    if (!referenced.has(`${PREFIX}/${surah}/${f}`)) await rm(path.join(partDir, f))
  }
  if (!split) await rmdir(partDir).catch(() => {})
  const wholeName = new RegExp(`^${surah}(\\.[0-9a-f]{8})?\\.mp3$`)
  for (const f of (await readdir(path.join(root, 'surahs'))).filter((f) => wholeName.test(f))) {
    if (!referenced.has(`${PREFIX}/${f}`)) await rm(path.join(root, 'surahs', f))
  }
}

if (missingAll.length) {
  const msg = `missing clips (${missingAll.length}): ${missingAll.join(', ')}`
  if (!args['allow-missing']) { console.error('FAILED, ' + msg + '\nUse --allow-missing to build anyway.'); process.exit(1) }
  console.warn('WARNING ' + msg)
}

// Index lists every surah that has a built manifest, not only this run's.
const built = (await readdir(path.join(root, 'surahs'))).filter((f) => f.endsWith('.json')).map((f) => Number(f.slice(0, -5))).sort((a, b) => a - b)
await writeFile(path.join(root, 'index.json'), JSON.stringify({ source: SOURCE, set: setId, surahs: built, updatedAt: new Date().toISOString() }, null, 2))
const maxDrift = Math.max(0, ...report.map((r) => r.drift))
console.log(`built ${report.length} surahs, max |drift| ${maxDrift} ms, index surahs: ${built.join(',')}`)
if (failures.length) { console.error('FAILED, ' + failures.join('; ')); process.exit(1) }
