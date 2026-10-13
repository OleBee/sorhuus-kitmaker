// NN-XT .sxt — IFF FORM/PTCH, big-endian, the patch Reason's sampler loads.

const V100 = 1_000_000;
const V110 = 1_001_000;
const V120 = 1_002_000;
const V130 = 1_003_000;
const V140 = 1_004_000;
const V150 = 1_005_000;
const V200 = 2_000_000;
const V220 = 2_002_000;
const V410 = 4_001_000;

const ZONE_BYTES = 241;
/**
 * Reason-oktav: C3 er MIDI 60, og det er originaltonen NN-XT forventer.
 * Key tracking (K. Track) is 0, otherwise C1 would play the file two octaves down.
 */
const ROOT_C3 = 60;

export type SxtZoneIn = {
  key: number;
  velLo: number;
  velHi: number;
  fadeIn: number;
  fadeOut: number;
  frames: number;
  gainDb: number;
  stepUp: number;
  /** NN-XT Alt. Overlapping zones with this set take turns instead of stacking. */
  alternate: boolean;
  path: string[];
  sampleName: string;
};

export type SxtGroupIn = {
  polyphony: number;
  zones: SxtZoneIn[];
};

export type SxtPatch = {
  name: string;
  author: string;
  description: string;
  groups: SxtGroupIn[];
};

class Bin {
  private parts: Uint8Array[] = [];
  length = 0;

  u8(n: number) {
    this.raw(Uint8Array.of(n & 255));
  }
  u32(n: number) {
    const v = n >>> 0;
    this.raw(Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255));
  }
  i16(n: number) {
    const v = n | 0;
    this.raw(Uint8Array.of((v >> 8) & 255, v & 255));
  }
  i32(n: number) {
    const v = n | 0;
    this.raw(Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255));
  }
  raw(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
  }
  version(v: number) {
    const major = Math.floor(v / 1_000_000);
    const minor = Math.floor((v % 1_000_000) / 1000);
    const rev = v % 1000;
    this.u8(0xbc);
    this.u8(major);
    this.u8(minor);
    this.u8(rev);
    this.u8(0);
  }
  str(text: string) {
    const data = latin1(text);
    this.u32(data.length);
    this.raw(data);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function latin1(text: string): Uint8Array {
  const clean = text.replace(/[\u0000-\u001f]/g, "");
  const out = new Uint8Array(clean.length);
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    out[i] = c > 255 ? 0x3f : c;
  }
  return out;
}

function ascii4(id: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i) || 32;
  return out;
}

function localChunk(id: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? 1 : 0;
  const out = new Uint8Array(8 + data.length + pad);
  out.set(ascii4(id), 0);
  const size = data.length >>> 0;
  out[4] = (size >>> 24) & 255;
  out[5] = (size >>> 16) & 255;
  out[6] = (size >>> 8) & 255;
  out[7] = size & 255;
  out.set(data, 8);
  return out;
}

function groupChunk(id: string, type: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? 1 : 0;
  const out = new Uint8Array(12 + data.length + pad);
  out.set(ascii4(id), 0);
  const size = (data.length + 4) >>> 0;
  out[4] = (size >>> 24) & 255;
  out[5] = (size >>> 16) & 255;
  out[6] = (size >>> 8) & 255;
  out[7] = size & 255;
  out.set(ascii4(type), 8);
  out.set(data, 12);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function secondsToCents(seconds: number): number {
  return Math.round((Math.log(seconds) / Math.LN2) * 1200);
}

export function ampGainFromDb(db: number): number {
  if (!Number.isFinite(db) || Math.abs(db) < 0.05) return 0;
  const clamped = Math.max(-36, Math.min(24, db));
  const ratio = 10 ** (clamped / 20);
  return Math.round(ratio ** (1 / 3) * 1440 - 1440);
}

function writeZone(bin: Bin, groupIndex: number, zone: SxtZoneIn) {
  const start = bin.length;
  const frames = Math.max(1, zone.frames >>> 0);
  const key = Math.max(0, Math.min(127, zone.key | 0));
  const velLo = Math.max(1, Math.min(127, zone.velLo | 0));
  const velHi = Math.max(velLo, Math.min(127, zone.velHi | 0));
  const fadeIn = Math.max(0, Math.min(127, zone.fadeIn | 0));
  const fadeOut = zone.fadeOut <= 0 ? 128 : Math.max(1, Math.min(127, 127 - (zone.fadeOut | 0)));
  const release = secondsToCents(12);

  bin.u32(groupIndex);
  bin.u8(key);
  bin.u8(key);
  bin.u8(velLo);
  bin.u8(velHi);
  bin.u8(ROOT_C3);
  bin.i16(0);
  bin.u32(0);
  bin.u32(frames);
  bin.u32(0);
  bin.u32(0);
  bin.u32(frames);
  bin.u8(0);
  bin.u8(0);
  bin.u8(fadeIn);
  bin.u8(fadeOut);
  bin.u8(zone.alternate ? 1 : 0);
  for (let i = 0; i < 11; i++) bin.i32(0);
  for (const s of [1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1]) bin.u8(s);
  bin.u8(1);
  bin.i32(-536);
  bin.u8(252);
  bin.i32(1);
  bin.u8(1);
  bin.u8(101);
  bin.i32(0);
  bin.i32(0);
  bin.i32(0);
  bin.u8(89);
  bin.i32(-536);
  bin.i32(-10500);
  bin.u8(1);
  bin.i32(0);
  bin.i32(0);
  bin.i32(-10500);
  bin.u8(1);
  bin.i32(-13159);
  bin.u8(0);
  bin.i32(-14400);
  bin.u8(1);
  bin.i32(-1200);
  bin.i32(0);
  bin.i32(-1200);
  bin.i32(0);
  bin.i32(0);
  bin.i32(0);
  bin.u8(2);
  bin.u8(0);
  bin.i16(0);
  bin.i16(0);
  bin.i32(0); // K. Track: 0 = same pitch on every key
  bin.u8(0);
  bin.i32(14100);
  bin.i32(0);
  bin.u8(61);
  bin.i32(0);
  bin.i32(-10500);
  bin.u8(1);
  bin.i32(-13159);
  bin.u8(0);
  bin.i32(-14400);
  bin.u8(1);
  bin.i32(release);
  bin.i32(1000);
  bin.i32(release);
  bin.i32(0);
  bin.i32(ampGainFromDb(zone.gainDb));
  bin.i32(0);
  bin.u8(87);
  bin.i32(0);
  if (bin.length - start !== ZONE_BYTES) {
    throw new Error(`Patch zone was ${bin.length - start} bytes, expected ${ZONE_BYTES}`);
  }
}

function writeSampleRef(zone: SxtZoneIn): Uint8Array {
  const bin = new Bin();
  bin.version(V110);
  bin.version(V110);
  bin.u8(1);
  bin.u32(Math.max(0, zone.stepUp | 0));
  bin.u32(zone.path.length);
  for (const part of zone.path) bin.str(part);
  bin.version(V120);
  bin.u8(0);
  bin.version(V150);
  bin.u8(0);
  bin.str(zone.sampleName);
  bin.str("");
  bin.str("");
  bin.u8(13);
  bin.str("");
  return bin.bytes();
}

export function buildSxt(patch: SxtPatch): Uint8Array {
  const flat: { groupIndex: number; zone: SxtZoneIn }[] = [];
  patch.groups.forEach((group, groupIndex) => {
    for (const zone of group.zones) flat.push({ groupIndex, zone });
  });

  const groups = new Bin();
  groups.version(V200);
  groups.u32(patch.groups.length);
  for (const group of patch.groups) {
    const poly = Math.max(1, Math.min(99, group.polyphony | 0));
    groups.u8(poly);
    groups.u8(47);
    groups.u8(0);
    groups.i32(-536);
  }

  const zones = new Bin();
  flat.forEach((item, index) => {
    writeZone(zones, item.groupIndex, item.zone);
    void index;
  });

  const zoneRefs = new Bin();
  flat.forEach((_item, index) => {
    zoneRefs.u8(1);
    zoneRefs.version(V410);
    zoneRefs.u8(1);
    zoneRefs.u32(index);
  });

  const body = new Bin();
  body.version(V100);
  body.raw(groups.bytes());
  body.version(V220);
  body.u32(flat.length);
  body.raw(zones.bytes());
  body.raw(zoneRefs.bytes());
  for (let i = 0; i < 2; i++) {
    body.version(V100);
    body.version(V120);
    body.u8(0);
    body.version(V140);
    body.u8(0);
  }

  const refs = concat(flat.map((item) => localChunk("REFE", writeSampleRef(item.zone))));

  const desc = new Bin();
  desc.version(V130);
  desc.u8(18);
  desc.str(patch.name.slice(0, 80));
  desc.str("NNXT Digital Sampler");

  const auth = new Bin();
  auth.version(V130);
  auth.str(patch.author.slice(0, 80));
  auth.str(patch.description.slice(0, 240));

  const parm = new Bin();
  parm.version(V100);
  for (const b of [9, 5, 0, 6, 0, 7, 0, 8, 0, 9, 0, 10, 0, 11, 0, 12, 0, 13, 100, 0]) parm.u8(b);

  const children = concat([
    groupChunk("CAT ", "REFS", refs),
    localChunk("DESC", desc.bytes()),
    localChunk("AUTH", auth.bytes()),
    localChunk("PARM", parm.bytes()),
    localChunk("BODY", body.bytes()),
  ]);
  return groupChunk("FORM", "PTCH", children);
}
