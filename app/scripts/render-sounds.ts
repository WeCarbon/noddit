/**
 * Renders the four notice-sound recipes (N291: "update" and "decide", each an A and a B variant)
 * to 16-bit mono 44.1kHz WAV files, from the exact same recipes `app/src/sounds.ts` plays through
 * Web Audio in the app — so a preview sounds like what the owner will actually hear. For the
 * owner to listen to and pick a variant; never run against anything but a scratch directory, and
 * the app itself never ships these WAVs (it synthesizes the sound live, with no audio file).
 *
 * Usage: node app/scripts/render-sounds.ts <output-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECIPES, renderToSamples, type SoundKind, type Variant } from '../src/sounds.ts'

const SAMPLE_RATE = 44100

/** A minimal PCM WAV: the RIFF/fmt/data chunks only — nothing a WAV reader would need beyond that. */
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28) // byte rate
  buf.writeUInt16LE(bytesPerSample, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * bytesPerSample)
  }
  return buf
}

const outDir = process.argv[2]
if (!outDir) {
  console.error('usage: node app/scripts/render-sounds.ts <output-dir>')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const kinds: SoundKind[] = ['update', 'decide']
const variants: Variant[] = ['A', 'B']
for (const kind of kinds) {
  for (const variant of variants) {
    const samples = renderToSamples(RECIPES[kind][variant], SAMPLE_RATE)
    const wav = encodeWav(samples, SAMPLE_RATE)
    const path = join(outDir, `${kind}-${variant}.wav`)
    writeFileSync(path, wav)
    console.log(`${path} — ${(samples.length / SAMPLE_RATE).toFixed(3)}s`)
  }
}
