// Uploads a built set to R2. Local by default; production needs --remote --i-have-approval.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs, parseSurahs, setDir, run, sleep, limit, apiServesParts } from './common.mjs'

const args = parseArgs()
const setId = args.set
if (!setId || setId === true) throw new Error('--set is required')
const remote = Boolean(args.remote)
if (remote && !args['i-have-approval']) throw new Error('--remote requires --i-have-approval')

const BUCKET = 'quran-assets'
const PREFIX = 'translation-audio/mukhtasar-th'
const SET_PREFIX = `${PREFIX}/${setId}/`
const root = setDir(setId)
const surahs = args.surahs
  ? parseSurahs(args.surahs)
  : (await readdir(path.join(root, 'surahs'))).filter((f) => f.endsWith('.json')).map((f) => Number(f.slice(0, -5))).sort((a, b) => a - b)

// A Worker from before parts heads <set>/<surah>.mp3 and would pair an old whole file with the
// new offsets, so production only gets the new layout once the live API serves parts
if (remote && !args['skip-api-check']) {
  const api = (args.api && args.api !== true ? String(args.api) : 'https://api.quran.in.th').replace(/\/$/, '')
  const check = await apiServesParts(api, surahs)
  if (!check.ok) throw new Error(`${check.reason}. Deploy the Worker that serves parts first, or pass --skip-api-check`)
  console.log(`API check: ${check.reason}`)
}

async function accountId() {
  if (!remote) return 'local'
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID
  const { stdout } = await run('npx', ['wrangler', 'whoami'])
  const ids = [...new Set(stdout.match(/\b[0-9a-f]{32}\b/g) ?? [])]
  if (ids.length !== 1) throw new Error('Cannot tell which Cloudflare account wrangler uses; set CLOUDFLARE_ACCOUNT_ID')
  return ids[0]
}

// Audio keys are content-addressed (<surah>.<hash8>.mp3, <surah>/<ayah>.<hash8>.mp3), so one that
// was put once never needs putting again. The record is per target, account and bucket; when the
// bucket lost objects anyway (wiped local state, deleted elsewhere), --all puts everything again.
const recordFile = path.join(root, `.uploaded-${remote ? 'remote' : 'local'}-${await accountId()}-${BUCKET}.json`)
const uploaded = new Set(await readFile(recordFile, 'utf8').then(JSON.parse, () => []))
const saveRecord = () => writeFile(recordFile, JSON.stringify([...uploaded].sort(), null, 2))
const isHashed = (key) => /\.[0-9a-f]{8}\.mp3$/.test(key)

const put = async (key, file, contentType) => {
  // Wrangler 3 writes to the real bucket unless told --local; it has no --remote flag
  const target = remote ? [] : ['--local']
  for (let attempt = 1; ; attempt++) {
    try {
      await run('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, ...target, '--file', file, '--content-type', contentType])
      break
    } catch (e) {
      if (attempt >= 3) throw e
      await sleep(1000 * attempt)
    }
  }
  console.log(`${remote ? 'REMOTE' : 'local'} ${key}`)
}
const fileOf = (key) => path.join(root, 'surahs', ...key.slice(SET_PREFIX.length).split('/'))
const limited = limit(6)

// After the first failure no new put starts, the manifest is not uploaded and the run exits 1:
// every key the old manifest references is still there, so readers stay on the previous build
async function putAll(keys, step) {
  let failure = null
  await Promise.all(keys.map((key) => limited(async () => {
    if (failure) return
    try { await put(key, fileOf(key), 'audio/mpeg'); uploaded.add(key) } catch (e) { failure ??= e }
  })))
  await saveRecord()
  if (failure) {
    console.error(`FAILED ${step}: ${failure.message.split('\n')[0]}\nManifest not uploaded.`)
    process.exit(1)
  }
}

for (const s of surahs) {
  const manifestFile = path.join(root, 'surahs', `${s}.json`)
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  // `audioPath` is the whole-surah file; manifests from before parts have no `parts`
  const wholeKey = manifest.audioPath
  const partKeys = (manifest.parts ?? []).map((p) => p.audioPath).filter((k) => k !== wholeKey)
  const audioKeys = [...partKeys, ...(wholeKey ? [wholeKey] : [])]
  for (const key of audioKeys) if (!key.startsWith(SET_PREFIX)) throw new Error(`surah ${s}: audio key outside the set: ${key}`)
  const needed = (k) => args.all || !isHashed(k) || !uploaded.has(k)

  // Parts, then the whole file, then the manifest
  const parts = partKeys.filter(needed)
  await putAll(parts, `surah ${s} parts`)
  const wholes = wholeKey && needed(wholeKey) ? [wholeKey] : []
  await putAll(wholes, `surah ${s} whole file`)
  await put(`${SET_PREFIX}${s}.json`, manifestFile, 'application/json').catch((e) => {
    console.error(`FAILED surah ${s} manifest: ${e.message.split('\n')[0]}\nThe API still serves the previous manifest, whose audio is all still in the bucket.`)
    process.exit(1)
  })

  const putCount = parts.length + wholes.length
  const orphans = [...uploaded].filter((k) => (k.startsWith(`${SET_PREFIX}${s}/`) || (k.startsWith(`${SET_PREFIX}${s}.`) && k.endsWith('.mp3'))) && !audioKeys.includes(k))
  console.log(`surah ${s}: ${audioKeys.length} audio files, ${putCount} put, ${audioKeys.length - putCount} skipped (already uploaded)`)
  if (orphans.length) console.log(`surah ${s}: ${orphans.length} uploaded audio keys no longer referenced (not deleted, listed in ${path.basename(recordFile)})`)
}
await put(`${SET_PREFIX}index.json`, path.join(root, 'index.json'), 'application/json')
if (args['make-current']) await put(`${PREFIX}/current.json`, path.join(root, 'index.json'), 'application/json')
