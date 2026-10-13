import { encodeMono16, measureContainer, stampRootC3 } from "@/lib/audio-files";
import { classify } from "@/lib/drums";
import { buildRefill } from "@/lib/refill";
import { ampGainFromDb, buildSxt } from "@/lib/sxt";
import { equalRanges, mapVelocity, alternateIndices, nextAlternateIndex } from "@/lib/velocity";
import { zipStore } from "@/lib/zip";

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

function u32be(b: Uint8Array, o: number) {
  return b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
}

function i16be(b: Uint8Array, o: number) {
  const v = (b[o] << 8) | b[o + 1];
  return v & 0x8000 ? v - 0x10000 : v;
}

/** Same field order as NN-XT's zone (SxtZone.read). */
function parseZone(z: Uint8Array) {
  let o = 4;
  const key = z[o++];
  o++; // key hi
  const velLo = z[o++];
  const velHi = z[o++];
  const root = z[o++];
  o += 2 + 20 + 5 + 44 + 12;
  o += 1 + 4 + 1 + 4 + 1 + 1 + 12 + 1;
  o += 4 + 4 + 1 + 4 + 4;
  o += 4 + 1 + 4 + 1 + 4 + 1 + 4 + 4 + 4 + 4 + 4 + 4;
  const octave = z[o + 1];
  const semitone = i16be(z, o + 2);
  const cent = i16be(z, o + 4);
  const keyToPitch = (z[o + 6] << 24) | (z[o + 7] << 16) | (z[o + 8] << 8) | z[o + 9];
  return { key, velLo, velHi, root, alt: z[35], octave, semitone, cent, keyToPitch };
}

function wavRoot(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const size = view.getUint32(o + 4, true);
    if (id === "smpl" && size >= 20 && o + 8 + 16 <= bytes.length) return view.getUint32(o + 8 + 12, true);
    o += 8 + size + (size % 2);
  }
  return null;
}

function walk(buf: Uint8Array, start: number, end: number) {
  const chunks: { id: string; data: Uint8Array }[] = [];
  let o = start;
  while (o + 8 <= end) {
    const id = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    const size = u32be(buf, o + 4);
    chunks.push({ id, data: buf.subarray(o + 8, o + 8 + size) });
    o += 8 + size + (size % 2);
  }
  return chunks;
}

function zonesOf(file: Uint8Array) {
  assert(String.fromCharCode(...file.subarray(0, 4)) === "FORM", "missing FORM");
  assert(String.fromCharCode(...file.subarray(8, 12)) === "PTCH", "missing PTCH");
  const formSize = u32be(file, 4);
  const children = walk(file, 12, 12 + formSize - 4);
  const body = children.find((c) => c.id === "BODY");
  const parm = children.find((c) => c.id === "PARM");
  assert(body, "missing BODY");
  assert(parm && parm.data.includes(100), "master volume");
  const data = body!.data;
  const groups = u32be(data, 10);
  let o = 14 + groups * 7 + 5;
  const count = u32be(data, o);
  o += 4;
  const zones = [];
  for (let i = 0; i < count; i++) {
    const z = data.subarray(o, o + 241);
    assert(z.length === 241, "short zone");
    zones.push(parseZone(z));
    o += 241;
  }
  assert(data[o] === 1, "zone reference block");
  return zones;
}

const samples = new Float32Array(1000);
samples[10] = 0.5;
samples[20] = -0.25;
const wav = encodeMono16(samples, 44100);
const measured = measureContainer(wav);
assert(measured, "wav measure");
assert(Math.abs(measured!.peak - 0.5) < 0.002, `peak ${measured!.peak}`);
assert(measured!.frames === 1000, "frames");
assert(measured!.sampleRate === 44100, "rate");

const ranges = equalRanges(4);
assert(ranges[0].lo === 1 && ranges[0].hi === 31, "r0");
assert(ranges[1].lo === 32 && ranges[1].hi === 63, "r1");
assert(ranges[3].hi === 127, "r3");
assert(equalRanges(1)[0].hi === 127, "single");

const shaped = mapVelocity([0.1, 0.2, 0.9], "amplitude", 0);
assert(shaped[0].lo === 1 && shaped[2].hi === 127, "amp cover");
assert(shaped[2].lo > shaped[1].lo, "amp order");
assert(shaped[0].hi + 1 === shaped[1].lo, "no gap");
assert(!shaped[0].alternate, "no alt unless asked");

const round = mapVelocity([0.5, 0.5, 0.9], "amplitude", 0, { alternateDb: 1 });
assert(round[0].lo === 1 && round[2].hi === 127, "rr cover");
assert(round[0].lo === round[1].lo && round[0].hi === round[1].hi, "same layer");
assert(round[2].lo === round[0].hi + 1, "rr gapless");
assert(round[0].alternate && round[1].alternate && !round[2].alternate, "alt flags");
assert(round[0].group === round[1].group && round[2].group !== round[0].group, "groups");
assert(alternateIndices(round, 10).join(",") === "0,1", "choices low");
assert(alternateIndices(round, 120).length === 1, "choices high");
assert(nextAlternateIndex("rr-test", [0, 1, 2]) === 0, "rr0");
assert(nextAlternateIndex("rr-test", [0, 1, 2]) === 1, "rr1");
assert(nextAlternateIndex("rr-test", [0, 1, 2]) === 2, "rr2");
assert(nextAlternateIndex("rr-test", [0, 1, 2]) === 0, "rr wrap");

const apart = mapVelocity([0.1, 0.9], "amplitude", 0, { alternateDb: 1 });
assert(apart[0].hi < apart[1].lo && !apart[0].alternate, "distinct stay split");

const faded = mapVelocity([0.2, 0.2, 0.8], "equal", 8, { alternateDb: 1 });
assert(faded[0].lo === faded[1].lo && faded[0].hi === faded[1].hi, "fade stays shared");
assert(faded[0].fadeOut === 8 && faded[2].fadeIn === 8, "fade edges");

assert(classify("snare_hard.wav") === "snare", "snare");
assert(classify("BD-01.wav") === "kick", "kick");
assert(classify("closed hat 3.wav") === "hatClosed", "ch");
assert(classify("oh_01.wav") === "hatOpen", "oh");
assert(classify("gulvtom.wav") === "tomLow", "ft");
assert(classify("mystery loop.wav") === null, "none");
assert(ampGainFromDb(0) === 0, "unity gain");

const patch = buildSxt({
  name: "Skarp",
  author: "Test",
  description: "Lag",
  groups: [
    {
      polyphony: 24,
      zones: [
        {
          key: 38,
          velLo: 1,
          velHi: 63,
          fadeIn: 0,
          fadeOut: 0,
          frames: 1000,
          gainDb: 0,
          stepUp: 1,
          alternate: false,
          path: ["Samples", "Snare", "soft.wav"],
          sampleName: "soft",
        },
        {
          key: 38,
          velLo: 64,
          velHi: 127,
          fadeIn: 0,
          fadeOut: 0,
          frames: 1000,
          gainDb: 0,
          stepUp: 1,
          alternate: true,
          path: ["Samples", "Snare", "hard.wav"],
          sampleName: "hard",
        },
      ],
    },
  ],
});
const zones = zonesOf(patch);
assert(zones.length === 2, "two zones");
assert(zones[0].key === 38 && zones[0].velLo === 1 && zones[0].velHi === 63, "soft map");
assert(zones[1].velLo === 64 && zones[1].velHi === 127 && zones[1].root === 60, "hard map");
assert(zones[0].root === 60 && zones[0].octave === 0 && zones[0].semitone === 0 && zones[0].cent === 0, "no tune");
assert(zones[0].keyToPitch === 0 && zones[1].keyToPitch === 0, "no key track");
assert(zones[0].alt === 0 && zones[1].alt === 1, "alt byte");
assert(new TextDecoder().decode(patch).includes("soft.wav"), "path stored");

const items = buildRefill(
  {
    name: "Trommesett",
    author: "",
    copyright: "",
    url: "",
    comment: "",
    mode: "equal",
    crossfade: 0,
    levelMatch: false,
    alternate: true,
    alternateDb: 1,
    pieces: [
      {
        id: "snare",
        note: 38,
        samples: [
          { name: "soft.wav", ext: "wav", bytes: wav, peak: 0.2, frames: 1000 },
          { name: "hard.wav", ext: "wav", bytes: wav, peak: 0.9, frames: 1000 },
          { name: "hard-b.wav", ext: "wav", bytes: wav, peak: 0.9, frames: 1000 },
        ],
      },
      {
        id: "kick",
        note: 36,
        samples: [{ name: "bd.wav", ext: "wav", bytes: wav, peak: 0.8, frames: 800 }],
      },
    ],
  },
  Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
);
assert(items.some((i) => i.path.endsWith("/info.txt")), "info");
assert(items.some((i) => i.path.endsWith("/splash.jpg")), "splash");
assert(items.some((i) => i.path.includes("/NN-XT Sampler Patches/") && i.path.endsWith("Trommesett.sxt")), "kit patch");
assert(items.some((i) => i.path.includes("/Samples/Snare/")), "snare samples");
const kitPatch = items.find((i) => i.path.endsWith("/Trommesett.sxt"))!;
const kitZones = zonesOf(kitPatch.data);
assert(kitZones.length === 4, `kit zones ${kitZones.length}`);
assert(kitZones.some((z) => z.key === 36 && z.root === 60 && z.keyToPitch === 0), "kick stays put");
const snareZones = kitZones.filter((z) => z.key === 38);
assert(snareZones.length === 3, "snare count");
assert(snareZones.every((z) => z.root === 60 && z.keyToPitch === 0), "snare root C3");
const snareFile = items.find((i) => i.path.includes("/Samples/Snare/") && i.path.endsWith(".wav"));
assert(snareFile && wavRoot(snareFile.data) === 60, "wav root C3");
const retagged = stampRootC3(wav, "wav");
assert(wavRoot(retagged) === 60, "stamp keeps C3");
const kept = measureContainer(retagged);
assert(kept && kept.frames === 1000 && kept.sampleRate === 44100 && Math.abs(kept.peak - 0.5) < 0.002, "stamp keeps pcm");
const low = wav.slice();
const tagged = stampRootC3(low, "wav");
const again = tagged.slice();
const view = new DataView(again.buffer, again.byteOffset, again.byteLength);
let smplAt = -1;
for (let o = 12; o + 8 <= again.length; ) {
  const id = String.fromCharCode(again[o], again[o + 1], again[o + 2], again[o + 3]);
  const size = view.getUint32(o + 4, true);
  if (id === "smpl") smplAt = o;
  o += 8 + size + (size % 2);
}
assert(smplAt > 0, "smpl exists");
view.setUint32(smplAt + 8 + 12, 36, true);
assert(wavRoot(stampRootC3(again, "wav")) === 60, "rewrite low root");
const hard = snareZones.filter((z) => z.alt === 1);
assert(hard.length === 2 && hard[0].velLo === hard[1].velLo && hard[0].velHi === hard[1].velHi, "snare alt");
assert(snareZones.some((z) => z.alt === 0 && z.velHi < hard[0].velLo), "soft under hard");
assert(items.some((i) => i.path.includes("-alt.")), "alt filename");
const zip = zipStore(items);
assert(zip[0] === 0x50 && zip[1] === 0x4b, "zip");

console.log("selftest ok");
