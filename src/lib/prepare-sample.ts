import {
  audioBufferToWav,
  fadeContainer,
  measureContainer,
  paintFade,
  statsFromBuffer,
  waveformPeaks,
} from "@/lib/audio-files";
import { decodeAudio } from "@/lib/preview-audio";

export const DEFAULT_FADE_MS = 12;
export const MAX_FADE_MS = 80;

export type PreparedSample = {
  peak: number;
  rms: number;
  frames: number;
  sampleRate: number;
  channels: number;
  bytes: Uint8Array;
  source: Uint8Array;
  ext: string;
  buffer: AudioBuffer;
  dry: Float32Array[];
  peaks: number[];
  fadeOutMs: number;
};

function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function finish(sample: Omit<PreparedSample, "source" | "dry" | "fadeOutMs" | "peaks">): PreparedSample {
  const source = sample.bytes;
  const dry = Array.from({ length: sample.buffer.numberOfChannels }, (_, c) => sample.buffer.getChannelData(c).slice());
  paintFade(sample.buffer, dry, DEFAULT_FADE_MS);
  const faded = fadeContainer(source, DEFAULT_FADE_MS);
  return {
    ...sample,
    source,
    dry,
    fadeOutMs: DEFAULT_FADE_MS,
    bytes: faded ?? audioBufferToWav(sample.buffer),
    ext: faded ? sample.ext : "wav",
    peaks: waveformPeaks(sample.buffer),
  };
}

export function renderFade<T extends PreparedSample>(sample: T, fadeOutMs: number): T {
  const ms = Math.max(0, Math.min(MAX_FADE_MS, Math.round(fadeOutMs) || 0));
  if (ms === sample.fadeOutMs) return sample;
  paintFade(sample.buffer, sample.dry, ms);
  const faded = ms > 0 ? fadeContainer(sample.source, ms) : sample.source;
  const bytes = faded ?? audioBufferToWav(sample.buffer);
  return {
    ...sample,
    fadeOutMs: ms,
    bytes,
    ext: containerExt(bytes, sample.ext),
    peaks: waveformPeaks(sample.buffer),
  };
}

function containerExt(bytes: Uint8Array, fallback: string): string {
  if (bytes.length >= 12) {
    const id = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (id === "RIFF") return "wav";
    if (id === "FORM") return "aiff";
  }
  return fallback;
}

export async function prepareBytes(name: string, raw: Uint8Array): Promise<PreparedSample> {
  const measured = measureContainer(raw);
  const ext = extensionOf(name);
  const keep =
    measured &&
    (ext === "wav" || ext === "wave" || ext === "aif" || ext === "aiff" || ext === "aifc");
  if (keep && measured) {
    const buffer = await decodeAudio(raw);
    const storedExt = ext === "wave" ? "wav" : ext === "aifc" ? "aiff" : ext;
    return finish({
      peak: measured.peak,
      rms: measured.rms,
      frames: measured.frames,
      sampleRate: measured.sampleRate,
      channels: measured.channels,
      bytes: raw,
      ext: storedExt,
      buffer,
    });
  }
  let buffer: AudioBuffer;
  try {
    buffer = await decodeAudio(raw);
  } catch {
    throw new Error(`${name} could not be read as audio`);
  }
  const stats = statsFromBuffer(buffer);
  return finish({
    peak: stats.peak,
    rms: stats.rms,
    frames: buffer.length,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    bytes: audioBufferToWav(buffer),
    ext: "wav",
    buffer,
  });
}

export async function prepareFile(file: File): Promise<PreparedSample> {
  const raw = new Uint8Array(await file.arrayBuffer());
  return prepareBytes(file.name, raw);
}
