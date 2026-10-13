import { encodeInterleaved } from "./audio-files.ts";
import { fileStem, type PieceId } from "./drums.ts";

export type SplitOpts = {
  /** 0 = only the loudest attacks, 1 = soft hits too. */
  sensitivity: number;
  minGapMs: number;
  maxLenMs: number;
};

export const DEFAULT_SPLIT: SplitOpts = {
  sensitivity: 0.55,
  minGapMs: 90,
  maxLenMs: 3600,
};

export type SliceFeatures = {
  centroid: number;
  flatness: number;
  zcr: number;
  duration: number;
  bursts: number;
  pitch: number;
  pitchConf: number;
  peakiness: number;
  low: number;
  mid: number;
  high: number;
  bands: number[];
};

export type FoundSlice = {
  start: number;
  end: number;
  piece: PieceId | null;
  peak: number;
  features: SliceFeatures;
};

export type SplitResult = {
  slices: FoundSlice[];
  overview: number[];
  frames: number;
  sampleRate: number;
};

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function mixMono(channels: Float32Array[]): Float32Array {
  const frames = channels.reduce((n, ch) => Math.min(n, ch.length), channels[0]?.length ?? 0);
  if (channels.length === 1) return channels[0].subarray(0, frames);
  const out = new Float32Array(frames);
  const g = 1 / channels.length;
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = 0; i < frames; i++) out[i] += ch[i] * g;
  }
  return out;
}

function frameRms(mono: Float32Array, hop: number, win: number): Float32Array {
  const frames = Math.max(0, Math.floor((mono.length - win) / hop));
  const rms = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = i * hop;
    let s = 0;
    for (let j = 0; j < win; j++) {
      const v = mono[o + j];
      s += v * v;
    }
    rms[i] = Math.sqrt(s / win);
  }
  return rms;
}

function positiveFlux(rms: Float32Array): Float32Array {
  const flux = new Float32Array(rms.length);
  for (let i = 1; i < rms.length; i++) {
    const d = rms[i] - rms[i - 1];
    flux[i] = d > 0 ? d : 0;
  }
  return flux;
}

type Region = { a: number; b: number };

function regionsFromGate(rms: Float32Array, gateOn: number, gateOff: number, hold: number): Region[] {
  const regions: Region[] = [];
  let on = false;
  let start = 0;
  let below = 0;
  for (let i = 0; i < rms.length; i++) {
    if (!on) {
      if (rms[i] >= gateOn) {
        on = true;
        start = i;
        below = 0;
      }
    } else if (rms[i] < gateOff) {
      below++;
      if (below >= hold) {
        regions.push({ a: start, b: i - below + 1 });
        on = false;
      }
    } else {
      below = 0;
    }
  }
  if (on) regions.push({ a: start, b: rms.length - 1 });
  return regions;
}

function mergeRegions(regions: Region[], minGap: number): Region[] {
  if (!regions.length) return [];
  const out: Region[] = [{ ...regions[0] }];
  for (let i = 1; i < regions.length; i++) {
    const prev = out[out.length - 1];
    const next = regions[i];
    if (next.a - prev.b < minGap) prev.b = next.b;
    else out.push({ ...next });
  }
  return out;
}

function localMax(flux: Float32Array, i: number): boolean {
  const left = flux[i - 1] ?? 0;
  const right = flux[i + 1] ?? 0;
  return flux[i] >= left && flux[i] > right;
}

function dipped(rms: Float32Array, i: number, back: number): boolean {
  const near = Math.max(1, Math.floor(back * 0.15));
  let min = Infinity;
  const from = Math.max(0, i - back);
  const to = Math.max(from, i - near);
  for (let j = from; j < to; j++) if (rms[j] < min) min = rms[j];
  if (!Number.isFinite(min)) return false;
  return min < rms[i] * 0.62;
}

/** Split a long active region when a new attack arrives without a silent gap. */
function cutRegion(region: Region, rms: Float32Array, flux: Float32Array, minGap: number, hop: number, sr: number): Region[] {
  const span = (region.b - region.a) * hop;
  if (span < sr * 0.5) return [region];
  let maxFlux = 0;
  let maxRms = 0;
  for (let i = region.a; i <= region.b; i++) {
    if (flux[i] > maxFlux) maxFlux = flux[i];
    if (rms[i] > maxRms) maxRms = rms[i];
  }
  const back = Math.max(2, Math.round((0.12 * sr) / hop));
  const skip = Math.max(2, Math.round((0.05 * sr) / hop));
  const cuts: number[] = [];
  let last = region.a;
  for (let i = region.a + skip; i < region.b - 1; i++) {
    if (i - last < minGap) continue;
    if (!localMax(flux, i)) continue;
    if (flux[i] < maxFlux * 0.28) continue;
    if (rms[i] < maxRms * 0.34) continue;
    if (!dipped(rms, i, back)) continue;
    cuts.push(i);
    last = i;
  }
  if (!cuts.length) return [region];
  const parts: Region[] = [];
  let a = region.a;
  for (const cut of cuts) {
    parts.push({ a, b: cut });
    a = cut;
  }
  parts.push({ a, b: region.b });
  return parts;
}

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextRe;
      }
    }
  }
}

function analyzeSpectrum(samples: Float32Array, sr: number): { centroid: number; flatness: number; bands: number[]; peakiness: number } {
  const n = 2048;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const len = Math.min(n, samples.length);
  for (let i = 0; i < len; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, n - 1)));
    re[i] = samples[i] * w;
  }
  fft(re, im);
  const bins = n / 2;
  const mag = new Float32Array(bins);
  let sum = 0;
  let sumPower = 0;
  let maxPower = 0;
  for (let i = 1; i < bins; i++) {
    mag[i] = Math.hypot(re[i], im[i]);
    const power = mag[i] * mag[i];
    sum += mag[i];
    sumPower += power;
    if (power > maxPower) maxPower = power;
  }
  const binHz = sr / n;
  let centroidNum = 0;
  for (let i = 1; i < bins; i++) centroidNum += i * binHz * mag[i] * mag[i];
  const centroid = sumPower > 0 ? centroidNum / sumPower : 0;
  let logSum = 0;
  const count = bins - 1;
  for (let i = 1; i < bins; i++) logSum += Math.log(mag[i] + 1e-12);
  const geo = Math.exp(logSum / count);
  const arith = sum / Math.max(1, count);
  const flatness = arith > 0 ? Math.min(1, geo / arith) : 0;
  const peakiness = sumPower > 0 ? maxPower / (sumPower / count) : 0;
  const edges = [30, 120, 250, 600, 1600, 4000, 8000, 16000];
  const bands = [0, 0, 0, 0, 0, 0, 0];
  let bandSum = 0;
  for (let b = 0; b < 7; b++) {
    const a = Math.max(1, Math.floor(edges[b] / binHz));
    const c = Math.min(bins - 1, Math.floor(edges[b + 1] / binHz));
    let e = 0;
    for (let i = a; i <= c; i++) e += mag[i] * mag[i];
    bands[b] = e;
    bandSum += e;
  }
  if (bandSum > 0) for (let b = 0; b < 7; b++) bands[b] /= bandSum;
  return { centroid, flatness, bands, peakiness };
}

function zeroCrossRate(samples: Float32Array, sr: number): number {
  if (samples.length < 2) return 0;
  let z = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i] >= 0 && samples[i - 1] < 0) || (samples[i] < 0 && samples[i - 1] >= 0)) z++;
  }
  return (z * sr) / samples.length;
}

function burstCount(mono: Float32Array, start: number, sr: number): number {
  const end = Math.min(mono.length, start + Math.floor(sr * 0.05));
  const hop = Math.max(1, Math.floor(sr * 0.003));
  const env: number[] = [];
  let prev = mono[start] ?? 0;
  for (let i = start; i < end; i += hop) {
    let e = 0;
    const stop = Math.min(end, i + hop);
    for (let j = i; j < stop; j++) {
      const hp = mono[j] - prev;
      prev = mono[j];
      e += hp * hp;
    }
    env.push(Math.sqrt(e / Math.max(1, stop - i)));
  }
  if (env.length < 3) return 0;
  let max = 0;
  for (const v of env) if (v > max) max = v;
  if (max < 1e-6) return 0;
  const thr = max * 0.45;
  let count = 0;
  let last = -10;
  for (let i = 1; i < env.length - 1; i++) {
    if (i - last < 2) continue;
    if (env[i] >= thr && env[i] >= env[i - 1] && env[i] > env[i + 1]) {
      const before = env[Math.max(0, i - 2)];
      if (before < env[i] * 0.72) {
        count++;
        last = i;
      }
    }
  }
  return count;
}

function estimatePitch(samples: Float32Array, sr: number): { hz: number; conf: number } {
  const step = 4;
  const n = Math.floor(samples.length / step);
  if (n < 64) return { hz: 0, conf: 0 };
  const ds = new Float32Array(n);
  const dsr = sr / step;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * step;
    for (let k = 0; k < step; k++) s += samples[o + k] || 0;
    ds[i] = s / step;
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += ds[i];
  mean /= n;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    ds[i] -= mean;
    energy += ds[i] * ds[i];
  }
  if (energy < 1e-8) return { hz: 0, conf: 0 };
  const minLag = Math.max(2, Math.floor(dsr / 420));
  const maxLag = Math.min(n - 2, Math.floor(dsr / 32));
  if (maxLag <= minLag) return { hz: 0, conf: 0 };
  const corrAt = (lag: number) => {
    let c = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) c += ds[i] * ds[i + lag];
    return c;
  };
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const c = corrAt(lag);
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  const conf = bestLag ? best / energy : 0;
  if (bestLag === 0 || conf < 0.22) return { hz: 0, conf };
  return { hz: dsr / bestLag, conf };
}

export function featuresOf(mono: Float32Array, sr: number, start: number, end: number, hopRms?: { rms: Float32Array; hop: number; a: number }): SliceFeatures {
  const from = Math.max(0, start);
  const to = Math.min(mono.length, end);
  const slice = mono.subarray(from, Math.max(from + 1, to));
  let peak = 0;
  let peakAt = 0;
  for (let i = 0; i < slice.length; i++) {
    const a = Math.abs(slice[i]);
    if (a > peak) {
      peak = a;
      peakAt = i;
    }
  }
  const specAt = Math.min(slice.length - 1, peakAt + Math.floor(sr * 0.012));
  const spec = analyzeSpectrum(slice.subarray(specAt, Math.min(slice.length, specAt + 2048)), sr);
  const zcr = zeroCrossRate(slice.subarray(0, Math.min(slice.length, Math.floor(sr * 0.08))), sr);
  const pitchSlice = slice.subarray(
    Math.min(slice.length - 1, peakAt + Math.floor(sr * 0.02)),
    Math.min(slice.length, peakAt + Math.floor(sr * 0.22)),
  );
  const pitch = estimatePitch(pitchSlice, sr);
  let duration = slice.length / sr;
  if (hopRms) {
    const { rms, hop, a } = hopRms;
    let max = 0;
    let maxI = a;
    const b = Math.min(rms.length - 1, a + Math.ceil(slice.length / hop));
    for (let i = a; i <= b; i++) {
      if (rms[i] > max) {
        max = rms[i];
        maxI = i;
      }
    }
    const floor = max * 0.025;
    let last = maxI;
    for (let i = maxI; i <= b; i++) {
      if (rms[i] > floor) last = i;
    }
    duration = Math.max(0.01, ((last - a) * hop) / sr);
  }
  const low = spec.bands[0] + spec.bands[1];
  const mid = spec.bands[2] + spec.bands[3];
  const high = spec.bands[4] + spec.bands[5] + spec.bands[6];
  return {
    centroid: spec.centroid,
    flatness: spec.flatness,
    zcr,
    duration,
    bursts: burstCount(mono, from, sr),
    pitch: pitch.conf > 0.28 ? pitch.hz : 0,
    pitchConf: pitch.conf,
    peakiness: spec.peakiness,
    low,
    mid,
    high,
    bands: spec.bands,
  };
}

export function classifyFeatures(f: SliceFeatures): PieceId | null {
  const { centroid, flatness, zcr, duration, bursts, pitch, pitchConf, peakiness, low, mid, high } = f;

  if (bursts >= 3 && duration >= 0.09 && duration < 0.45 && flatness > 0.45 && low < 0.28 && peakiness < 80) {
    return "clap";
  }

  if (duration < 0.14 && duration > 0.03 && high > 0.28 && high < 0.72 && low < 0.16 && centroid > 1600 && centroid < 5600 && peakiness < 140) {
    return "hatPedal";
  }

  const cymbal = (high > 0.62 && low < 0.16) || (centroid > 7000 && high > 0.45 && low < 0.2);
  if (cymbal) {
    if (duration < 0.16) return "hatClosed";
    if (duration < 0.85) return "hatOpen";
    if (peakiness > 40 && zcr < 11000) return "ride";
    return "crash";
  }

  if (duration < 0.12 && mid > 0.45 && high < 0.28 && low < 0.2 && peakiness > 60) return "rim";

  const lowMid = low + mid;
  const body = high < 0.15 && centroid < 600 && flatness < 0.5 && (low > 0.55 || (lowMid > 0.8 && pitchConf > 0.5));
  if (body) {
    if (pitchConf > 0.55 && pitch >= 75 && pitch <= 520) {
      if (pitch < 120) return "tomLow";
      if (pitch < 190) return "tomMid";
      return "tomHigh";
    }
    return "kick";
  }

  if (
    flatness > 0.5 &&
    low > 0.15 &&
    low < 0.65 &&
    high > 0.18 &&
    high < 0.75 &&
    zcr > 2500 &&
    duration > 0.06 &&
    duration < 0.75 &&
    peakiness > 25 &&
    peakiness < 450
  ) {
    return "snare";
  }

  if (duration > 0.04 && duration < 0.6 && high < 0.6) return "perc";
  return null;
}

function overviewOf(mono: Float32Array, buckets = 960): number[] {
  const out: number[] = [];
  const size = Math.max(1, Math.floor(mono.length / buckets));
  let max = 0;
  for (let i = 0; i < buckets; i++) {
    let m = 0;
    const start = i * size;
    const end = i === buckets - 1 ? mono.length : Math.min(mono.length, start + size);
    for (let j = start; j < end; j++) {
      const a = Math.abs(mono[j]);
      if (a > m) m = a;
    }
    out.push(m);
    if (m > max) max = m;
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}

export function splitDump(channels: Float32Array[], sampleRate: number, opts: SplitOpts = DEFAULT_SPLIT): SplitResult {
  const sr = sampleRate;
  const mono = mixMono(channels);
  const frames = mono.length;
  const empty: SplitResult = { slices: [], overview: overviewOf(mono), frames, sampleRate: sr };
  if (frames < sr * 0.03) return empty;

  const sensitivity = clamp01(opts.sensitivity);
  const hop = Math.max(1, Math.round(sr * 0.004));
  const win = hop * 2;
  const rms = frameRms(mono, hop, win);
  if (!rms.length) return empty;
  let peakRms = 0;
  for (let i = 0; i < rms.length; i++) if (rms[i] > peakRms) peakRms = rms[i];
  if (peakRms < 1e-5) return empty;

  const gateRatio = 0.2 * (1 - sensitivity) + 0.028 * sensitivity;
  const gateOn = peakRms * gateRatio;
  const gateOff = gateOn * 0.26;
  const hold = Math.max(2, Math.round((0.028 * sr) / hop));
  const minGap = Math.max(2, Math.round(((opts.minGapMs || 90) / 1000) * sr) / hop);
  const maxSamples = Math.max(hop * 4, Math.round(((opts.maxLenMs || 3600) / 1000) * sr));
  const pre = Math.round(0.012 * sr);

  let regions = mergeRegions(regionsFromGate(rms, gateOn, gateOff, hold), minGap);
  const flux = positiveFlux(rms);
  const split: Region[] = [];
  for (const region of regions) split.push(...cutRegion(region, rms, flux, minGap, hop, sr));
  regions = split;

  let filePeak = 0;
  for (let i = 0; i < mono.length; i += 4) {
    const a = Math.abs(mono[i]);
    if (a > filePeak) filePeak = a;
  }
  const minPeak = filePeak * (0.07 * (1 - sensitivity) + 0.012 * sensitivity);

  const slices: FoundSlice[] = [];
  const release = Math.round(0.12 * sr);
  for (let r = 0; r < regions.length; r++) {
    const region = regions[r];
    let start = Math.max(0, region.a * hop - pre);
    let end = Math.min(frames, (region.b + 1) * hop + release);
    const next = regions[r + 1];
    if (next) {
      const nextStart = Math.max(0, next.a * hop - pre);
      if (end > nextStart) end = nextStart;
    }
    if (end - start > maxSamples) end = start + maxSamples;
    if (end - start < Math.round(0.02 * sr)) continue;
    let peak = 0;
    const step = Math.max(1, Math.floor((end - start) / 4000));
    for (let i = start; i < end; i += step) {
      const a = Math.abs(mono[i]);
      if (a > peak) peak = a;
    }
    if (peak < minPeak) continue;
    const features = featuresOf(mono, sr, start, end, { rms, hop, a: region.a });
    const piece = classifyFeatures(features);
    slices.push({ start, end, piece, peak, features });
  }
  return { slices, overview: overviewOf(mono), frames, sampleRate: sr };
}

export function slicesToFiles(
  channels: Float32Array[],
  sampleRate: number,
  slices: FoundSlice[],
): { name: string; hint: string; bytes: Uint8Array }[] {
  const tally = new Map<string, number>();
  const frames = channels.reduce((n, ch) => Math.min(n, ch.length), channels[0]?.length ?? 0);
  return slices.map((slice) => {
    const key = slice.piece ?? "hit";
    const n = (tally.get(key) ?? 0) + 1;
    tally.set(key, n);
    const stem = slice.piece ? fileStem(slice.piece) : "hit";
    const name = `${stem}-${String(n).padStart(2, "0")}.wav`;
    const start = Math.max(0, Math.min(frames, slice.start));
    const end = Math.max(start + 1, Math.min(frames, slice.end));
    const parts = channels.map((ch) => ch.subarray(start, end));
    return {
      name,
      hint: slice.piece ? stem : "",
      bytes: encodeInterleaved(parts, sampleRate),
    };
  });
}
