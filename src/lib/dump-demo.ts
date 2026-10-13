import type { PieceId } from "./drums.ts";

export type DumpHit = { piece: PieceId; peak: number; seed: number };

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scaleToPeak(data: Float32Array, peak: number) {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
  if (max <= 0) return;
  const g = peak / max;
  for (let i = 0; i < data.length; i++) data[i] *= g;
}

function durationOf(piece: PieceId): number {
  switch (piece) {
    case "hatClosed":
      return 0.09;
    case "hatPedal":
      return 0.07;
    case "rim":
      return 0.08;
    case "clap":
      return 0.28;
    case "hatOpen":
      return 0.48;
    case "kick":
      return 0.42;
    case "snare":
      return 0.32;
    case "tomLow":
    case "tomMid":
    case "tomHigh":
      return 0.46;
    case "crash":
      return 1.35;
    case "ride":
      return 1.15;
    default:
      return 0.3;
  }
}

/** One isolated drum hit, mono, scaled to `peak`. */
export function synthHit(piece: PieceId, peak: number, seed: number, sampleRate = 44100): Float32Array {
  const sr = sampleRate;
  const n = Math.max(1, Math.floor(sr * durationOf(piece)));
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  let phase = 0;
  let prev = 0;
  const tomF = piece === "tomLow" ? 86 : piece === "tomMid" ? 148 : 214;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const noise = rand() * 2 - 1;
    let s = 0;
    if (piece === "kick") {
      const f = 42 + 170 * Math.exp(-t * 20);
      phase += (2 * Math.PI * f) / sr;
      s = Math.sin(phase) * Math.exp(-t * 5.2) + noise * Math.exp(-t * 90) * 0.18;
    } else if (piece === "snare") {
      phase += (2 * Math.PI * 186) / sr;
      const body = Math.sin(phase) * Math.exp(-t * 18);
      let phase2 = phase * 1.78;
      const ring = Math.sin(phase2) * Math.exp(-t * 16) * 0.25;
      s = noise * Math.exp(-t * 12) * 0.85 + body * 0.7 + ring;
    } else if (piece === "clap") {
      const env =
        Math.exp(-t * 55) +
        (t > 0.011 ? 0.85 * Math.exp(-(t - 0.011) * 48) : 0) +
        (t > 0.024 ? 0.7 * Math.exp(-(t - 0.024) * 36) : 0);
      const hp = noise - prev;
      prev = noise * 0.35;
      s = hp * env;
    } else if (piece === "hatClosed" || piece === "hatOpen") {
      const hp = noise - prev;
      prev = noise * 0.15;
      s = hp * Math.exp(-t * (piece === "hatClosed" ? 42 : 6.5));
    } else if (piece === "hatPedal") {
      prev += 0.2 * (noise - prev);
      s = prev * Math.exp(-t * 48);
    } else if (piece === "rim") {
      phase += (2 * Math.PI * 740) / sr;
      s = Math.sin(phase) * Math.exp(-t * 48) * 0.7 + noise * Math.exp(-t * 80) * 0.45;
    } else if (piece === "tomLow" || piece === "tomMid" || piece === "tomHigh") {
      const f = tomF * (1 + 0.35 * Math.exp(-t * 28));
      phase += (2 * Math.PI * f) / sr;
      s = Math.sin(phase) * Math.exp(-t * (piece === "tomLow" ? 3.6 : 5.2)) + noise * Math.exp(-t * 30) * 0.12;
    } else if (piece === "crash") {
      const hp = noise - prev;
      prev = noise * 0.05;
      s = hp * Math.exp(-t * 1.45);
    } else if (piece === "ride") {
      phase += (2 * Math.PI * 3120) / sr;
      const hp = noise - prev;
      prev = noise * 0.2;
      s = Math.sin(phase) * Math.exp(-t * 1.7) * 0.85 + hp * Math.exp(-t * 3.2) * 0.35;
    } else {
      phase += (2 * Math.PI * 540) / sr;
      s = Math.sin(phase) * Math.exp(-t * 8) * 0.6 + noise * Math.exp(-t * 10) * 0.3;
    }
    out[i] = s;
  }
  scaleToPeak(out, peak);
  return out;
}

/** A long take: hits separated by silence, the usual "one wav of everything" dump. */
export function renderDump(hits: DumpHit[], sampleRate = 44100): Float32Array {
  const gap = Math.floor(sampleRate * 0.32);
  const lead = Math.floor(sampleRate * 0.18);
  const parts: Float32Array[] = [new Float32Array(lead)];
  for (const hit of hits) {
    parts.push(synthHit(hit.piece, hit.peak, hit.seed, sampleRate));
    parts.push(new Float32Array(gap));
  }
  let n = 0;
  for (const part of parts) n += part.length;
  const out = new Float32Array(n);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function practiceHits(): DumpHit[] {
  const hits: DumpHit[] = [];
  const add = (piece: PieceId, peaks: number[], seed: number) => {
    peaks.forEach((peak, i) => hits.push({ piece, peak, seed: seed + i * 17 }));
  };
  add("kick", [0.26, 0.52, 0.94], 3);
  add("snare", [0.2, 0.48, 0.9], 30);
  add("hatClosed", [0.18, 0.46, 0.82], 60);
  add("hatOpen", [0.36, 0.84], 90);
  add("tomLow", [0.42, 0.88], 120);
  add("tomMid", [0.4, 0.8], 150);
  add("tomHigh", [0.38, 0.78], 180);
  add("clap", [0.34, 0.72], 210);
  add("rim", [0.28, 0.66], 240);
  add("hatPedal", [0.4], 270);
  add("crash", [0.76], 300);
  add("ride", [0.7], 330);
  return hits;
}
