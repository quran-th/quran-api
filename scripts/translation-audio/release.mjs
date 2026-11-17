// Release index helpers for the audio scripts: which ayahs a release changed, and the audioRegen step.
import { getRelease, reportStep } from '../quran-database/lib/releaseIndex.mjs'

// The audio snapshot is Al-Mukhtasar (source 4) only
const AUDIO_SOURCE_IDS = [4]

// Pure: ayah rows of the wanted sources; footnote rows and removed verses have no audio.
export function audioAyahsFromVerses(verses, sourceIds = AUDIO_SOURCE_IDS) {
  const keys = new Map()
  for (const v of verses) {
    if (!sourceIds.includes(v.sourceId) || v.footnote !== 0 || v.class === 'rowRemoved') continue
    keys.set(`${v.surah}:${v.ayah}`, { surah: v.surah, ayah: v.ayah })
  }
  return [...keys.values()].sort((a, b) => a.surah - b.surah || a.ayah - b.ayah)
}

export async function releaseAudioAyahs(version, { sourceIds = AUDIO_SOURCE_IDS, ...options } = {}) {
  const { release, verses } = await getRelease(version, options)
  if (!release.sourceIds.some((id) => sourceIds.includes(id)))
    throw new Error(`release ${version} does not include source ${sourceIds.join(',')}, so it has no audio to regenerate`)
  const ayahs = audioAyahsFromVerses(verses, sourceIds)
  if (!ayahs.length) throw new Error(`release ${version} lists no changed ayahs for source ${sourceIds.join(',')}; send them first (export --release or backfill-release-verses.mjs)`)
  return ayahs
}

export const reportAudioRegen = (version, status, detail) => reportStep(version, 'audioRegen', status, detail)
