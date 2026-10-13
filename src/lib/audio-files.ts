export type Measured = {
  peak: number;
  rms: number;
  frames: number;
  sampleRate: number;
  channels: number;
  bytes: Uint8Array;
  ext: "wav" | "aif" | "aiff";
};

function ascii(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

function readExtended80(view: DataView, offset: number): number {
  const expRaw = view.getUint16(offset, false);
  const sign = expRaw & 0x8000;
  const exp = expRaw & 0x7fff;
  const hi = view.getUint32(offset + 2, false);
  const lo = view.getUint32(offset + 6, false);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const mant = hi * 2 ** -31 + lo * 2 ** -63;
  const value = mant * 2 ** (exp - 16383);
  return sign ? -value : value;
}

function peakRmsInt(
  view: DataView,
  offset: number,
  frames: number,
  channels: number,
  bits: number,
  little: boolean,
  signed8 = false,
): { peak: number; rms: number } {
  const bytesPer = bits / 8;
  let peak = 0;
  let sum = 0;
  let count = 0;
  const total = frames * channels;
  const denom = bits === 8 ? 128 : 2 ** (bits - 1);
  for (let i = 0; i < total; i++) {
    const o = offset + i * bytesPer;
    if (o + bytesPer > view.byteLength) break;
    let sample = 0;
    if (bits === 8) sample = (signed8 ? view.getInt8(o) : view.getUint8(o) - 128) / denom;
    else if (bits === 16) sample = view.getInt16(o, little) / denom;
    else if (bits === 24) {
      const b0 = view.getUint8(o);
      const b1 = view.getUint8(o + 1);
      const b2 = view.getUint8(o + 2);
      let v = little ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
      if (v & 0x800000) v |= ~0xffffff;
      sample = v / denom;
    } else if (bits === 32) sample = view.getInt32(o, little) / denom;
    const a = Math.abs(sample);
    if (a > peak) peak = a;
    sum += sample * sample;
    count++;
  }
  return { peak, rms: count ? Math.sqrt(sum / count) : 0 };
}

function writeStr(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeMono16(samples: Float32Array, sampleRate: number): Uint8Array {
  return encodeInterleaved([samples], sampleRate);
}

export function encodeInterleaved(channels: Float32Array[], sampleRate: number): Uint8Array {
  const ch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * ch * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i] || 0));
      view.setInt16(44 + (i * ch + c) * 2, Math.round(s * 32767), true);
    }
  }
  return new Uint8Array(buf);
}

/** Reason treats C3 (MIDI 60) as the root note when the wav/aiff already has one. */
const FILE_ROOT_C3 = 60;

function chunkId(view: DataView, offset: number): string {
  return ascii(view, offset, 4);
}

function stampWavRoot(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (chunkId(view, 0) !== "RIFF" || chunkId(view, 8) !== "WAVE") return bytes;
  const chunks: { id: string; data: Uint8Array }[] = [];
  let sampleRate = 0;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = chunkId(view, o);
    const size = view.getUint32(o + 4, true);
    const start = o + 8;
    if (start > bytes.length) break;
    const end = Math.min(bytes.length, start + size);
    const data = bytes.slice(start, end);
    if (id === "fmt " && data.length >= 8) {
      sampleRate = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true);
    }
    if (id === "smpl" && data.length >= 20) {
      const patched = data.slice();
      const dv = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
      dv.setUint32(12, FILE_ROOT_C3, true);
      dv.setUint32(16, 0, true);
      chunks.push({ id, data: patched });
    } else {
      chunks.push({ id, data });
    }
    const step = size + (size % 2);
    if (step < 0) break;
    o = start + step;
    if (o <= start) break;
  }
  if (!chunks.some((c) => c.id === "smpl")) {
    const data = new Uint8Array(36);
    const dv = new DataView(data.buffer);
    if (sampleRate > 0) dv.setUint32(8, Math.round(1_000_000_000 / sampleRate), true);
    dv.setUint32(12, FILE_ROOT_C3, true);
    chunks.push({ id: "smpl", data });
  }
  let payload = 4;
  for (const c of chunks) payload += 8 + c.data.length + (c.data.length % 2);
  const out = new Uint8Array(8 + payload);
  const ov = new DataView(out.buffer);
  writeStr(ov, 0, "RIFF");
  ov.setUint32(4, payload, true);
  writeStr(ov, 8, "WAVE");
  let w = 12;
  for (const c of chunks) {
    writeStr(ov, w, c.id.padEnd(4, " ").slice(0, 4));
    ov.setUint32(w + 4, c.data.length, true);
    out.set(c.data, w + 8);
    w += 8 + c.data.length + (c.data.length % 2);
  }
  return out;
}

function stampAiffRoot(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (chunkId(view, 0) !== "FORM") return bytes;
  const form = chunkId(view, 8);
  if (form !== "AIFF" && form !== "AIFC") return bytes;
  const chunks: { id: string; data: Uint8Array }[] = [];
  let o = 12;
  let stamped = false;
  while (o + 8 <= bytes.length) {
    const id = chunkId(view, o);
    const size = view.getUint32(o + 4, false);
    const start = o + 8;
    if (start > bytes.length) break;
    const end = Math.min(bytes.length, start + size);
    let data = bytes.slice(start, end);
    if (id === "INST" && data.length >= 2) {
      data = data.slice();
      data[0] = FILE_ROOT_C3;
      data[1] = 0;
      stamped = true;
    }
    chunks.push({ id, data });
    const step = size + (size % 2);
    o = start + step;
    if (o <= start) break;
  }
  if (!stamped) {
    const data = new Uint8Array(20);
    data[0] = FILE_ROOT_C3;
    data[3] = 127;
    data[4] = 1;
    data[5] = 127;
    chunks.push({ id: "INST", data });
  }
  let payload = 4;
  for (const c of chunks) payload += 8 + c.data.length + (c.data.length % 2);
  const out = new Uint8Array(8 + payload);
  const ov = new DataView(out.buffer);
  writeStr(ov, 0, "FORM");
  ov.setUint32(4, payload, false);
  writeStr(ov, 8, form);
  let w = 12;
  for (const c of chunks) {
    writeStr(ov, w, c.id.padEnd(4, " ").slice(0, 4));
    ov.setUint32(w + 4, c.data.length, false);
    out.set(c.data, w + 8);
    w += 8 + c.data.length + (c.data.length % 2);
  }
  return out;
}

/** Make sure the sample file says the root note is C3, matching the NN-XT zone. */
export function stampRootC3(bytes: Uint8Array, ext: string): Uint8Array {
  const e = ext.toLowerCase();
  if (e === "wav" || e === "wave") return stampWavRoot(bytes);
  if (e === "aif" || e === "aiff" || e === "aifc") return stampAiffRoot(bytes);
  return bytes;
}

export function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return encodeInterleaved(channels, buffer.sampleRate);
}

export function statsFromBuffer(buffer: AudioBuffer): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  let count = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const s = data[i];
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sum += s * s;
      count++;
    }
  }
  return { peak, rms: count ? Math.sqrt(sum / count) : 0 };
}

export function waveformPeaks(buffer: AudioBuffer, buckets = 48): number[] {
  const data = buffer.numberOfChannels > 0 ? buffer.getChannelData(0) : new Float32Array();
  const out: number[] = [];
  const size = Math.max(1, Math.floor(data.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let m = 0;
    const start = i * size;
    const end = i === buckets - 1 ? data.length : Math.min(data.length, start + size);
    for (let j = start; j < end; j++) {
      const a = Math.abs(data[j]);
      if (a > m) m = a;
    }
    out.push(m);
  }
  return out;
}

function measureWav(bytes: Uint8Array): Measured | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") return null;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let blockAlign = 0;
  let dataOff = -1;
  let dataLen = 0;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = ascii(view, o, 4);
    const size = view.getUint32(o + 4, true);
    const start = o + 8;
    if (start + Math.min(size, 16) > bytes.length) break;
    if (id === "fmt " && size >= 16) {
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      blockAlign = view.getUint16(start + 12, true);
      bits = view.getUint16(start + 14, true);
      if (format === 0xfffe && size >= 40 && start + 26 <= bytes.length) {
        format = view.getUint16(start + 24, true);
      }
    } else if (id === "data") {
      dataOff = start;
      dataLen = size;
    }
    o = start + size + (size % 2);
  }
  if (dataOff < 0 || channels < 1 || sampleRate < 1) return null;
  const end = Math.min(bytes.length, dataOff + dataLen);
  const usable = end - dataOff;
  if (format === 1 && (bits === 8 || bits === 16 || bits === 24 || bits === 32) && blockAlign > 0) {
    const frames = Math.floor(usable / blockAlign);
    const { peak, rms } = peakRmsInt(view, dataOff, frames, channels, bits, true);
    return { peak, rms, frames, sampleRate, channels, bytes, ext: "wav" };
  }
  return null;
}

function measureAiff(bytes: Uint8Array): Measured | null {
  const layout = parseAiff(bytes);
  if (!layout || layout.float32) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { peak, rms } = peakRmsInt(
    view,
    layout.dataOff,
    layout.frames,
    layout.channels,
    layout.bits,
    layout.little,
    true,
  );
  return {
    peak,
    rms,
    frames: layout.frames,
    sampleRate: layout.sampleRate,
    channels: layout.channels,
    bytes,
    ext: "aiff",
  };
}

type AiffLayout = {
  channels: number;
  frames: number;
  bits: number;
  sampleRate: number;
  little: boolean;
  float32: boolean;
  dataOff: number;
};

function parseAiff(bytes: Uint8Array): AiffLayout | null {
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0, 4) !== "FORM") return null;
  const form = ascii(view, 8, 4);
  if (form !== "AIFF" && form !== "AIFC") return null;
  let channels = 0;
  let frames = 0;
  let bits = 0;
  let sampleRate = 44100;
  let compression = "NONE";
  let ssnd = -1;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = ascii(view, o, 4);
    const size = view.getUint32(o + 4, false);
    const start = o + 8;
    if (start > bytes.length) break;
    if (id === "COMM" && size >= 18 && start + 18 <= bytes.length) {
      channels = view.getInt16(start, false);
      frames = view.getUint32(start + 2, false);
      bits = view.getInt16(start + 6, false);
      sampleRate = Math.round(readExtended80(view, start + 8)) || 44100;
      if (form === "AIFC" && size >= 22 && start + 22 <= bytes.length) {
        compression = ascii(view, start + 18, 4);
      }
    } else if (id === "SSND" && size >= 8 && start + 8 <= bytes.length) {
      ssnd = start;
    }
    const step = size + (size % 2);
    if (step < 0) break;
    o = start + step;
    if (o <= start) break;
  }
  const comp = compression.trim();
  const little = comp === "sowt";
  const float32 = comp === "fl32" || comp === "FL32";
  const pcm = form === "AIFF" || comp === "NONE" || comp === "twos" || comp === "in16" || comp === "in24" || comp === "in32" || little;
  const bitsOk = bits === 8 || bits === 16 || bits === 24 || bits === 32;
  if (ssnd < 0 || channels < 1 || frames < 1 || (!float32 && (!pcm || !bitsOk))) return null;
  const offset = view.getUint32(ssnd, false);
  const dataOff = ssnd + 8 + offset;
  const width = float32 ? 4 : bits / 8;
  if (dataOff >= bytes.length || width < 1) return null;
  const avail = Math.floor((bytes.length - dataOff) / (width * channels));
  if (avail < 1) return null;
  return {
    channels,
    frames: Math.min(frames, avail),
    bits: float32 ? 32 : bits,
    sampleRate,
    little,
    float32,
    dataOff,
  };
}

/** Uncompressed WAV/AIFF the browser cannot decode itself. */
export function decodePcmContainer(bytes: Uint8Array): { sampleRate: number; channels: Float32Array[] } | null {
  const aiff = parseAiff(bytes);
  if (aiff) return deinterleave(bytes, aiff.dataOff, aiff.frames, aiff.channels, aiff.bits, aiff.little, true, aiff.float32, aiff.sampleRate);
  const wav = parseWavPcm(bytes);
  if (wav) return deinterleave(bytes, wav.dataOff, wav.frames, wav.channels, wav.bits, true, false, wav.float32, wav.sampleRate);
  return null;
}

function parseWavPcm(bytes: Uint8Array): { dataOff: number; frames: number; channels: number; bits: number; float32: boolean; sampleRate: number } | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") return null;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let blockAlign = 0;
  let dataOff = -1;
  let dataLen = 0;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = ascii(view, o, 4);
    const size = view.getUint32(o + 4, true);
    const start = o + 8;
    if (start > bytes.length) break;
    if (id === "fmt " && size >= 16 && start + 16 <= bytes.length) {
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      blockAlign = view.getUint16(start + 12, true);
      bits = view.getUint16(start + 14, true);
      if (format === 0xfffe && size >= 40 && start + 26 <= bytes.length) format = view.getUint16(start + 24, true);
    } else if (id === "data") {
      dataOff = start;
      dataLen = size;
    }
    const step = size + (size % 2);
    if (step < 0) break;
    o = start + step;
    if (o <= start) break;
  }
  const float32 = format === 3 && bits === 32;
  const pcm = format === 1 && (bits === 8 || bits === 16 || bits === 24 || bits === 32);
  if (dataOff < 0 || channels < 1 || sampleRate < 1 || blockAlign < 1 || (!pcm && !float32)) return null;
  const usable = Math.min(bytes.length, dataOff + dataLen) - dataOff;
  const frames = Math.floor(usable / blockAlign);
  if (frames < 1) return null;
  return { dataOff, frames, channels, bits, float32, sampleRate };
}

function deinterleave(
  bytes: Uint8Array,
  dataOff: number,
  frames: number,
  channels: number,
  bits: number,
  little: boolean,
  signed8: boolean,
  float32: boolean,
  sampleRate: number,
): { sampleRate: number; channels: Float32Array[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = float32 ? 4 : bits / 8;
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const denom = bits === 8 ? 128 : 2 ** (bits - 1);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * width;
      if (o + width > view.byteLength) break;
      let sample = 0;
      if (float32) sample = view.getFloat32(o, little);
      else if (bits === 8) sample = (signed8 ? view.getInt8(o) : view.getUint8(o) - 128) / denom;
      else if (bits === 16) sample = view.getInt16(o, little) / denom;
      else if (bits === 24) {
        const b0 = view.getUint8(o);
        const b1 = view.getUint8(o + 1);
        const b2 = view.getUint8(o + 2);
        let v = little ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
        if (v & 0x800000) v |= ~0xffffff;
        sample = v / denom;
      } else sample = view.getInt32(o, little) / denom;
      out[c][i] = sample;
    }
  }
  return { sampleRate, channels: out };
}

/** PCM WAV/AIFF we can measure without resampling. Null means "decode it". */
export function measureContainer(bytes: Uint8Array): Measured | null {
  return measureWav(bytes) ?? measureAiff(bytes);
}

/** Scale the tail of a PCM WAV or AIFF so the sample ends at zero. Null if the file is not PCM. */
export function fadeContainer(bytes: Uint8Array, fadeMs: number): Uint8Array | null {
  if (fadeMs <= 0) return bytes;
  const aiff = parseAiff(bytes);
  if (aiff) return fadePcm(bytes, aiff.dataOff, aiff.frames, aiff.channels, aiff.bits, aiff.little, true, aiff.float32, aiff.sampleRate, fadeMs);
  const wav = parseWavPcm(bytes);
  if (wav) return fadePcm(bytes, wav.dataOff, wav.frames, wav.channels, wav.bits, true, false, wav.float32, wav.sampleRate, fadeMs);
  return null;
}

function fadePcm(
  bytes: Uint8Array,
  dataOff: number,
  frames: number,
  channels: number,
  bits: number,
  little: boolean,
  signed8: boolean,
  float32: boolean,
  sampleRate: number,
  fadeMs: number,
): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const width = float32 ? 4 : bits / 8;
  const fadeFrames = Math.min(frames, Math.max(1, Math.round((sampleRate * fadeMs) / 1000)));
  const start = frames - fadeFrames;
  const denom = bits === 8 ? 128 : 2 ** (bits - 1);
  for (let i = 0; i < fadeFrames; i++) {
    const t = fadeFrames === 1 ? 1 : i / (fadeFrames - 1);
    const gain = Math.cos(t * Math.PI * 0.5);
    for (let c = 0; c < channels; c++) {
      const o = dataOff + ((start + i) * channels + c) * width;
      if (o + width > view.byteLength) break;
      let sample = 0;
      if (float32) sample = view.getFloat32(o, little);
      else if (bits === 8) sample = (signed8 ? view.getInt8(o) : view.getUint8(o) - 128) / denom;
      else if (bits === 16) sample = view.getInt16(o, little) / denom;
      else if (bits === 24) {
        const b0 = view.getUint8(o);
        const b1 = view.getUint8(o + 1);
        const b2 = view.getUint8(o + 2);
        let v = little ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
        if (v & 0x800000) v |= ~0xffffff;
        sample = v / denom;
      } else sample = view.getInt32(o, little) / denom;
      writeSample(view, o, sample * gain, bits, little, signed8, float32);
    }
  }
  return out;
}

function writeSample(
  view: DataView,
  offset: number,
  value: number,
  bits: number,
  little: boolean,
  signed8: boolean,
  float32: boolean,
) {
  const s = Math.max(-1, Math.min(1, value));
  if (float32) {
    view.setFloat32(offset, s, little);
    return;
  }
  if (bits === 8) {
    if (signed8) view.setInt8(offset, Math.round(s * 127));
    else view.setUint8(offset, Math.round(128 + s * 127));
    return;
  }
  if (bits === 16) {
    view.setInt16(offset, Math.round(s * 32767), little);
    return;
  }
  if (bits === 24) {
    let v = Math.round(s * 8388607);
    if (v < 0) v += 0x1000000;
    if (little) {
      view.setUint8(offset, v & 255);
      view.setUint8(offset + 1, (v >> 8) & 255);
      view.setUint8(offset + 2, (v >> 16) & 255);
    } else {
      view.setUint8(offset, (v >> 16) & 255);
      view.setUint8(offset + 1, (v >> 8) & 255);
      view.setUint8(offset + 2, v & 255);
    }
    return;
  }
  view.setInt32(offset, Math.round(s * 2147483647), little);
}

/** Copy dry channels into the buffer, then fade the tail. `dry` is left untouched. */
export function paintFade(buffer: AudioBuffer, dry: Float32Array[], fadeMs: number) {
  const frames = buffer.length;
  const fadeFrames = fadeMs <= 0 ? 0 : Math.min(frames, Math.max(1, Math.round((buffer.sampleRate * fadeMs) / 1000)));
  const start = frames - fadeFrames;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    const src = dry[c];
    if (!src) continue;
    data.set(src.subarray(0, frames));
    for (let i = 0; i < fadeFrames; i++) {
      const t = fadeFrames === 1 ? 1 : i / (fadeFrames - 1);
      data[start + i] *= Math.cos(t * Math.PI * 0.5);
    }
  }
}
