import { create } from "zustand";
import { classify, nextPieceFileName, PIECES, TOM_IDS, type PieceId, isAudioName } from "@/lib/drums";
import { demoFiles } from "@/lib/demo-kit";
import { prepareBytes, prepareFile, renderFade, type PreparedSample } from "@/lib/prepare-sample";

export type SampleItem = PreparedSample & { id: string; name: string };

export type PieceState = { note: number; sampleIds: string[]; manual: boolean };

type Incoming = { file?: File; name: string; hint: string; bytes?: Uint8Array };

type KitState = {
  name: string;
  author: string;
  copyright: string;
  url: string;
  comment: string;
  mode: "equal" | "amplitude";
  crossfade: number;
  levelMatch: boolean;
  alternate: boolean;
  alternateDb: number;
  auditionVelocity: number;
  selected: PieceId;
  pieces: Record<PieceId, PieceState>;
  unsorted: string[];
  samples: Record<string, SampleItem>;
  busy: string | null;
  error: string | null;
  notice: string | null;
  lastHit: { pieceId: PieceId; sampleId: string; velocity: number } | null;
  setField: (key: "name" | "author" | "copyright" | "url" | "comment", value: string) => void;
  setSelected: (id: PieceId) => void;
  setNote: (id: PieceId, note: number) => void;
  setMode: (mode: "equal" | "amplitude") => void;
  setCrossfade: (n: number) => void;
  setLevelMatch: (on: boolean) => void;
  setAlternate: (on: boolean) => void;
  setAlternateDb: (n: number) => void;
  setAudition: (n: number) => void;
  setLastHit: (hit: KitState["lastHit"]) => void;
  clearNotice: () => void;
  addIncoming: (items: Incoming[], target: PieceId | "auto") => Promise<void>;
  loadDemo: () => Promise<void>;
  removeSample: (id: string) => void;
  moveSample: (pieceId: PieceId, id: string, dir: -1 | 1) => void;
  sortPiece: (pieceId: PieceId) => void;
  assignUnsorted: (id: string, pieceId: PieceId) => void;
  reassign: (id: string, pieceId: PieceId) => void;
  reassignMany: (ids: string[], pieceId: PieceId) => void;
  setFade: (id: string, fadeOutMs: number) => void;
  reset: () => void;
};

function freshPieces(): Record<PieceId, PieceState> {
  const pieces = {} as Record<PieceId, PieceState>;
  for (const piece of PIECES) pieces[piece.id] = { note: piece.note, sampleIds: [], manual: false };
  return pieces;
}

function nameOnPiece(samples: Record<string, SampleItem>, pieceId: PieceId, ids: string[], sample: SampleItem): string {
  const ext = sample.ext.startsWith(".") ? sample.ext : `.${sample.ext || "wav"}`;
  return nextPieceFileName(
    ids.map((id) => samples[id].name),
    pieceId,
    ext,
  );
}

function insertByPeak(ids: string[], id: string, samples: Record<string, SampleItem>): string[] {
  const peak = samples[id].peak;
  const next = [...ids];
  let i = 0;
  while (i < next.length && samples[next[i]].peak <= peak) i++;
  next.splice(i, 0, id);
  return next;
}

function moveIds(s: KitState, ids: string[], pieceId: PieceId): Partial<KitState> {
  let samples = s.samples;
  let pieces = s.pieces;
  let unsorted = s.unsorted;
  let moved = false;
  for (const id of ids) {
    if (!samples[id] || pieces[pieceId].sampleIds.includes(id)) continue;
    const nextPieces = { ...pieces };
    for (const key of Object.keys(nextPieces) as PieceId[]) {
      if (!nextPieces[key].sampleIds.includes(id)) continue;
      nextPieces[key] = { ...nextPieces[key], sampleIds: nextPieces[key].sampleIds.filter((x) => x !== id) };
    }
    const sample = {
      ...samples[id],
      name: nameOnPiece(samples, pieceId, nextPieces[pieceId].sampleIds, samples[id]),
    };
    samples = { ...samples, [id]: sample };
    nextPieces[pieceId] = {
      ...nextPieces[pieceId],
      sampleIds: insertByPeak(nextPieces[pieceId].sampleIds, id, samples),
    };
    pieces = nextPieces;
    unsorted = unsorted.filter((x) => x !== id);
    moved = true;
  }
  if (!moved) return {};
  return { pieces, samples, unsorted, selected: pieceId };
}

function pickTom(pieces: Record<PieceId, PieceState>): PieceId {
  let best: PieceId = TOM_IDS[0];
  let count = Infinity;
  for (const id of TOM_IDS) {
    const n = pieces[id].sampleIds.length;
    if (n < count) {
      count = n;
      best = id;
    }
  }
  return best;
}

export const useKit = create<KitState>((set, get) => ({
  name: "Drum Kit",
  author: "",
  copyright: "",
  url: "",
  comment: "",
  mode: "equal",
  crossfade: 0,
  levelMatch: false,
  alternate: true,
  alternateDb: 1,
  auditionVelocity: 100,
  selected: "snare",
  pieces: freshPieces(),
  unsorted: [],
  samples: {},
  busy: null,
  error: null,
  notice: null,
  lastHit: null,
  setField: (key, value) => set({ [key]: value }),
  setSelected: (id) => set({ selected: id }),
  setNote: (id, note) =>
    set((s) => ({
      pieces: {
        ...s.pieces,
        [id]: { ...s.pieces[id], note: Math.max(0, Math.min(127, note | 0)) },
      },
    })),
  setMode: (mode) => set({ mode }),
  setCrossfade: (n) => set({ crossfade: Math.max(0, Math.min(24, Math.round(n))) }),
  setLevelMatch: (on) => set({ levelMatch: on }),
  setAlternate: (on) => set({ alternate: on }),
  setAlternateDb: (n) => set({ alternateDb: Math.max(0, Math.min(3, Math.round(n * 10) / 10)) }),
  setAudition: (n) => set({ auditionVelocity: Math.max(1, Math.min(127, Math.round(n))) }),
  setLastHit: (hit) => set({ lastHit: hit }),
  clearNotice: () => set({ error: null, notice: null }),
  addIncoming: async (items, target) => {
    const audio = items.filter((item) => isAudioName(item.name) || isAudioName(item.file?.name ?? ""));
    if (!audio.length) {
      set({ error: "No audio files in what you dropped. Use wav, aiff, or mp3." });
      return;
    }
    set({ busy: `Reading ${audio.length} ${audio.length === 1 ? "sample" : "samples"}…`, error: null });
    const errors: string[] = [];
    let added = 0;
    for (const item of audio) {
      try {
        const prepared = item.bytes
          ? await prepareBytes(item.name, item.bytes)
          : item.file
            ? await prepareFile(item.file)
            : null;
        if (!prepared) continue;
        const id = crypto.randomUUID();
        const sample: SampleItem = { ...prepared, id, name: item.name };
        const state = get();
        const classified = target === "auto" ? classify(`${item.hint} ${item.name}`) : target;
        const pieceId = classified === "tom" ? pickTom(state.pieces) : classified;
        set((s) => {
          const samples = { ...s.samples, [id]: sample };
          if (!pieceId) return { samples, unsorted: [...s.unsorted, id] };
          const piece = s.pieces[pieceId];
          return {
            samples,
            selected: pieceId,
            pieces: {
              ...s.pieces,
              [pieceId]: { ...piece, sampleIds: insertByPeak(piece.sampleIds, id, samples) },
            },
          };
        });
        added++;
        if (added % 6 === 0) {
          set({ busy: `Adding ${added} of ${audio.length}…` });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : item.name);
      }
    }
    set({
      busy: null,
      error: errors.length ? errors.slice(0, 3).join(" ") : null,
      notice: added ? `${added} ${added === 1 ? "sample added" : "samples added"} to the kit.` : null,
    });
  },
  loadDemo: async () => {
    set({
      samples: {},
      unsorted: [],
      pieces: freshPieces(),
      lastHit: null,
      error: null,
      notice: null,
    });
    const files = demoFiles().map((file) => ({ name: file.name, hint: file.hint, bytes: file.bytes }));
    await get().addIncoming(files, "auto");
    set({ notice: "Demo kit ready. Click the same spot twice — hits of equal strength swap samples." });
  },
  removeSample: (id) =>
    set((s) => {
      const samples = { ...s.samples };
      delete samples[id];
      const pieces = { ...s.pieces };
      for (const key of Object.keys(pieces) as PieceId[]) {
        pieces[key] = { ...pieces[key], sampleIds: pieces[key].sampleIds.filter((x) => x !== id) };
      }
      return { samples, pieces, unsorted: s.unsorted.filter((x) => x !== id) };
    }),
  moveSample: (pieceId, id, dir) =>
    set((s) => {
      const piece = s.pieces[pieceId];
      const ids = [...piece.sampleIds];
      const index = ids.indexOf(id);
      const next = index + dir;
      if (index < 0 || next < 0 || next >= ids.length) return s;
      [ids[index], ids[next]] = [ids[next], ids[index]];
      return { pieces: { ...s.pieces, [pieceId]: { ...piece, sampleIds: ids, manual: true } } };
    }),
  sortPiece: (pieceId) =>
    set((s) => {
      const piece = s.pieces[pieceId];
      const sampleIds = [...piece.sampleIds].sort(
        (a, b) => s.samples[a].peak - s.samples[b].peak || s.samples[a].rms - s.samples[b].rms,
      );
      return { pieces: { ...s.pieces, [pieceId]: { ...piece, sampleIds, manual: false } } };
    }),
  assignUnsorted: (id, pieceId) =>
    set((s) => {
      if (!s.unsorted.includes(id) || !s.samples[id]) return s;
      const piece = s.pieces[pieceId];
      const sample = { ...s.samples[id], name: nameOnPiece(s.samples, pieceId, piece.sampleIds, s.samples[id]) };
      const samples = { ...s.samples, [id]: sample };
      return {
        samples,
        unsorted: s.unsorted.filter((x) => x !== id),
        selected: pieceId,
        pieces: {
          ...s.pieces,
          [pieceId]: { ...piece, sampleIds: insertByPeak(piece.sampleIds, id, samples) },
        },
      };
    }),
  reassign: (id, pieceId) => set((s) => moveIds(s, [id], pieceId)),
  reassignMany: (ids, pieceId) => set((s) => moveIds(s, ids, pieceId)),
  setFade: (id, fadeOutMs) =>
    set((s) => {
      const sample = s.samples[id];
      if (!sample) return s;
      const next = renderFade(sample, fadeOutMs);
      if (next === sample) return s;
      return { samples: { ...s.samples, [id]: next } };
    }),
  reset: () =>
    set({
      samples: {},
      unsorted: [],
      pieces: freshPieces(),
      lastHit: null,
      error: null,
      notice: null,
    }),
}));
