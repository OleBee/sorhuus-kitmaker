import { isAudioName } from "./drums.ts";
import { decodeAudio } from "./preview-audio.ts";
import { DEFAULT_SPLIT, slicesToFiles, splitDump, type FoundSlice, type SplitOpts } from "./split-dump.ts";

const MAX_BYTES = 120_000_000;
const MAX_SECONDS = 8 * 60;
export const SLICE_CAP = 180;

export type CutPreview = {
  fileName: string;
  slices: FoundSlice[];
  overview: number[];
  frames: number;
  sampleRate: number;
  truncated: boolean;
  capped: boolean;
};

export type CutFiles = { name: string; hint: string; bytes: Uint8Array }[];

function channelsOf(buffer: AudioBuffer, frames: number): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    channels.push(frames === data.length ? data : data.subarray(0, frames));
  }
  return channels;
}

export function previewCut(
  channels: Float32Array[],
  sampleRate: number,
  fileName: string,
  opts: SplitOpts,
  truncated: boolean,
): CutPreview {
  const result = splitDump(channels, sampleRate, opts);
  const capped = result.slices.length > SLICE_CAP;
  const slices = capped ? result.slices.slice(0, SLICE_CAP) : result.slices;
  return {
    fileName,
    slices,
    overview: result.overview,
    frames: result.frames,
    sampleRate,
    truncated,
    capped,
  };
}

export function packCut(
  channels: Float32Array[],
  sampleRate: number,
  fileName: string,
  opts: SplitOpts,
  truncated: boolean,
): { files: CutFiles; preview: CutPreview } {
  const preview = previewCut(channels, sampleRate, fileName, opts, truncated);
  return {
    files: slicesToFiles(channels, sampleRate, preview.slices),
    preview,
  };
}

export async function readCutFile(file: File): Promise<{ channels: Float32Array[]; sampleRate: number; truncated: boolean }> {
  if (file.size > MAX_BYTES) {
    throw new Error("The file is too large for the browser. Use a wav under eight minutes.");
  }
  if (!isAudioName(file.name) && !file.type.startsWith("audio/")) {
    throw new Error("That needs to be an audio file, for example wav, aiff, or mp3.");
  }
  const raw = new Uint8Array(await file.arrayBuffer());
  let buffer: AudioBuffer;
  try {
    buffer = await decodeAudio(raw);
  } catch {
    throw new Error("Could not read the audio file. Use uncompressed wav, aiff, or mp3.");
  }
  const truncated = buffer.duration > MAX_SECONDS;
  const frames = truncated ? Math.floor(MAX_SECONDS * buffer.sampleRate) : buffer.length;
  return { channels: channelsOf(buffer, frames), sampleRate: buffer.sampleRate, truncated };
}

export async function cutAudioFile(file: File, opts: SplitOpts = DEFAULT_SPLIT) {
  const opened = await readCutFile(file);
  return packCut(opened.channels, opened.sampleRate, file.name, opts, opened.truncated);
}
