import { PIECES, type PieceId, pieceById, safeToken } from "@/lib/drums";
import { stampRootC3 } from "@/lib/audio-files";
import { buildSxt, type SxtGroupIn, type SxtZoneIn } from "@/lib/sxt";
import { mapVelocity } from "@/lib/velocity";
import type { ZipItem } from "@/lib/zip";

export type ExportSample = {
  name: string;
  ext: string;
  bytes: Uint8Array;
  peak: number;
  frames: number;
};

export type ExportPiece = {
  id: PieceId;
  note: number;
  /** List order is the layer order, not peak order. */
  manual?: boolean;
  samples: ExportSample[];
};

export type ExportKit = {
  name: string;
  author: string;
  copyright: string;
  url: string;
  comment: string;
  mode: "equal" | "amplitude";
  crossfade: number;
  levelMatch: boolean;
  /** Group samples within this many dB and set NN-XT Alt. Off when omitted/false. */
  alternate?: boolean;
  alternateDb?: number;
  pieces: ExportPiece[];
};

const AUTO_COMMENT =
  "Velocity-layered drum kit. Samples are sorted by amplitude: softest hit on low velocity, hardest on high. Several samples at the same amplitude alternate so the same hit is not played twice in a row. Load a patch from the patches folder, and do not move the files in Samples.";

function textFile(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function gainDb(peak: number, target: number, enabled: boolean): number {
  if (!enabled || peak <= 1e-8 || target <= 1e-8) return 0;
  return Math.min(24, 20 * Math.log10(target / Math.max(peak, 1e-8)));
}

function rangesFor(piece: ExportPiece, kit: ExportKit) {
  return mapVelocity(
    piece.samples.map((sample) => sample.peak),
    kit.mode,
    kit.crossfade,
    {
      alternateDb: kit.alternate ? (kit.alternateDb ?? 1) : null,
      manual: piece.manual ?? false,
    },
  );
}

function zonesFor(
  piece: ExportPiece,
  kit: ExportKit,
  folder: string,
  names: string[],
): SxtZoneIn[] {
  const peaks = piece.samples.map((s) => s.peak);
  const target = Math.max(...peaks, 0);
  const ranges = rangesFor(piece, kit);
  return piece.samples.map((sample, index) => {
    const range = ranges[index];
    const file = names[index];
    const base = file.replace(/\.[^.]+$/, "");
    return {
      key: piece.note,
      velLo: range.lo,
      velHi: range.hi,
      fadeIn: range.fadeIn,
      fadeOut: range.fadeOut,
      frames: Math.max(1, sample.frames),
      gainDb: gainDb(sample.peak, target, kit.levelMatch),
      stepUp: 1,
      alternate: range.alternate,
      path: ["Samples", folder, file],
      sampleName: base,
    };
  });
}

function fileNames(piece: ExportPiece, kit: ExportKit): string[] {
  const ranges = rangesFor(piece, kit);
  const used = new Set<string>();
  return piece.samples.map((sample, index) => {
    const range = ranges[index];
    const base = safeToken(sample.name.replace(/\.[^.]+$/, "")) || "sample";
    const vel = `v${String(range.lo).padStart(3, "0")}-${String(range.hi).padStart(3, "0")}`;
    const alt = range.alternate ? "-alt" : "";
    let name = `${String(index + 1).padStart(2, "0")}-${base}-${vel}${alt}.${sample.ext}`;
    while (used.has(name)) name = `${index + 1}-${name}`;
    used.add(name);
    return name;
  });
}

function patchFile(kitName: string, suffix: string | null): string {
  const token = safeToken(kitName) || "Drum-Kit";
  return suffix ? `${token}-${suffix}.sxt` : `${token}.sxt`;
}

export function buildRefill(kit: ExportKit, splash: Uint8Array): ZipItem[] {
  const root = safeToken(kit.name) || "Drum-Kit";
  const display = kit.name.trim() || "Drum Kit";
  const year = new Date().getFullYear();
  const copyright = kit.copyright.trim() || `(c) ${year}`;
  const url = kit.url.trim() || "-";
  const comment = kit.comment.trim() || AUTO_COMMENT;
  const info = `${display}\r\n${copyright}\r\n${url}\r\n${comment}\r\n`;
  const sampleCount = kit.pieces.reduce((n, p) => n + p.samples.length, 0);
  const description = `${display}. ${sampleCount} samples, ${kit.pieces.length} ${
    kit.pieces.length === 1 ? "voice" : "voices"
  }. ${
    kit.alternate
      ? "Matching hits alternate; otherwise velocity follows amplitude."
      : "Velocity follows amplitude."
  }`;
  const author = kit.author.trim() || "Sörhuus KitMaker";

  const items: ZipItem[] = [
    { path: `${root}/info.txt`, data: textFile(info) },
    { path: `${root}/splash.jpg`, data: splash },
  ];

  const groups: SxtGroupIn[] = [];
  for (const piece of kit.pieces) {
    if (!piece.samples.length) continue;
    const meta = pieceById(piece.id);
    const names = fileNames(piece, kit);
    names.forEach((name, index) => {
      items.push({
        path: `${root}/Samples/${meta.folder}/${name}`,
        data: stampRootC3(piece.samples[index].bytes, piece.samples[index].ext),
      });
    });
    const zones = zonesFor(piece, kit, meta.folder, names);
    groups.push({ polyphony: 24, zones });
    items.push({
      path: `${root}/NN-XT Sampler Patches/${patchFile(display, meta.folder)}`,
      data: buildSxt({
        name: `${display} ${meta.label}`.slice(0, 80),
        author,
        description,
        groups: [{ polyphony: 24, zones }],
      }),
    });
  }

  if (groups.length) {
    items.push({
      path: `${root}/NN-XT Sampler Patches/${patchFile(display, null)}`,
      data: buildSxt({
        name: display.slice(0, 80),
        author,
        description,
        groups,
      }),
    });
  }

  return items;
}

export function emptyKitName(): string {
  return "Drum Kit";
}

export const PIECE_ORDER: PieceId[] = PIECES.map((p) => p.id);
