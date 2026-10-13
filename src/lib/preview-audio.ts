import { decodePcmContainer } from "@/lib/audio-files";

let ctx: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function bufferFromPcm(bytes: Uint8Array): AudioBuffer | null {
  const pcm = decodePcmContainer(bytes);
  const frames = pcm?.channels[0]?.length ?? 0;
  if (!pcm || pcm.channels.length < 1 || frames < 1) return null;
  const buffer = audioContext().createBuffer(pcm.channels.length, frames, pcm.sampleRate);
  for (let c = 0; c < pcm.channels.length; c++) buffer.getChannelData(c).set(pcm.channels[c]);
  return buffer;
}

function isAiff(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[8], bytes[9], bytes[10], bytes[11]);
  return head === "FORMAIFF" || head === "FORMAIFC";
}

export async function decodeAudio(bytes: Uint8Array): Promise<AudioBuffer> {
  const context = audioContext();
  if (isAiff(bytes)) {
    const decoded = bufferFromPcm(bytes);
    if (decoded) return decoded;
  }
  try {
    const copy = bytes.slice().buffer;
    return await context.decodeAudioData(copy);
  } catch {
    const decoded = bufferFromPcm(bytes);
    if (decoded) return decoded;
    throw new Error("Could not read the audio file");
  }
}

export function playBuffer(buffer: AudioBuffer) {
  const context = audioContext();
  const src = context.createBufferSource();
  src.buffer = buffer;
  const gain = context.createGain();
  gain.gain.value = 1;
  src.connect(gain);
  gain.connect(context.destination);
  src.start();
}
