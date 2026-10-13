import { encodeMono16 } from "@/lib/audio-files";

export type DemoFile = { name: string; hint: string; bytes: Uint8Array };

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

function hit(kind: "kick" | "snare" | "hat" | "open" | "tom", peak: number, seed: number): Float32Array {
  const sr = 44100;
  const dur = kind === "hat" ? 0.12 : kind === "open" ? 0.45 : kind === "kick" ? 0.4 : 0.3;
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  let phase = 0;
  let prev = 0;
  const tomF = 70 + (seed % 50);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    if (kind === "kick") {
      const f = 46 + 150 * Math.exp(-t * 16);
      phase += (2 * Math.PI * f) / sr;
      s = Math.sin(phase) * Math.exp(-t * 6.5);
    } else if (kind === "snare") {
      const noise = rand() * 2 - 1;
      phase += (2 * Math.PI * 188) / sr;
      s = noise * Math.exp(-t * 16) + Math.sin(phase) * Math.exp(-t * 22) * 0.4;
    } else if (kind === "hat" || kind === "open") {
      const noise = rand() * 2 - 1;
      const hp = noise - prev;
      prev = noise * 0.2;
      s = hp * Math.exp(-t * (kind === "hat" ? 36 : 8));
    } else {
      phase += (2 * Math.PI * tomF) / sr;
      const noise = rand() * 2 - 1;
      s = Math.sin(phase) * Math.exp(-t * 5.5) + noise * Math.exp(-t * 18) * 0.25;
    }
    out[i] = s;
  }
  scaleToPeak(out, peak);
  return out;
}

function wav(kind: "kick" | "snare" | "hat" | "open" | "tom", peak: number, seed: number): Uint8Array {
  return encodeMono16(hit(kind, peak, seed), 44100);
}

export function demoFiles(): DemoFile[] {
  const files: DemoFile[] = [];
  const kicks = [0.22, 0.48, 0.74, 0.97];
  kicks.forEach((peak, i) =>
    files.push({ name: `bd-${i + 1}.wav`, hint: "kick", bytes: wav("kick", peak, 10 + i) }),
  );
  const snares = [0.14, 0.3, 0.5, 0.72, 0.95];
  snares.forEach((peak, i) =>
    files.push({ name: `sd-${i + 1}.wav`, hint: "snare", bytes: wav("snare", peak, 40 + i) }),
  );
  files.push({ name: "sd-4b.wav", hint: "snare", bytes: wav("snare", 0.72, 48) });
  files.push({ name: "sd-4c.wav", hint: "snare", bytes: wav("snare", 0.72, 49) });
  [0.25, 0.55, 0.9].forEach((peak, i) =>
    files.push({
      name: `ch-${i + 1}.wav`,
      hint: "closed hat",
      bytes: wav("hat", peak, 70 + i),
    }),
  );
  files.push({ name: "ch-2b.wav", hint: "closed hat", bytes: wav("hat", 0.55, 76) });
  [0.35, 0.88].forEach((peak, i) =>
    files.push({
      name: `oh-${i + 1}.wav`,
      hint: "hihat open",
      bytes: wav("open", peak, 90 + i),
    }),
  );
  [0.4, 0.86].forEach((peak, i) =>
    files.push({ name: `ft-${i + 1}.wav`, hint: "floor tom", bytes: wav("tom", peak, 110 + i) }),
  );
  return files;
}
