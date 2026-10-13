import { useEffect, useRef, useState } from "react";
import { AudioLines } from "lucide-react";
import { Device, Knob, Waveform } from "@/components/chrome";
import { PIECES, type PieceId } from "@/lib/drums";
import { practiceHits, renderDump } from "@/lib/dump-demo";
import { previewCut, readCutFile, type CutPreview } from "@/lib/ingest-dump";
import { useKit } from "@/lib/kit-store";
import { DEFAULT_SPLIT, slicesToFiles, type SplitOpts } from "@/lib/split-dump";

type Source = { kind: "file"; file: File } | { kind: "demo" };

function paint() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function clock(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function commit(files: { name: string; hint: string; bytes: Uint8Array }[], preview: CutPreview) {
  const kit = useKit.getState();
  kit.reset();
  await useKit.getState().addIncoming(
    files.map((file) => ({ name: file.name, hint: file.hint, bytes: file.bytes })),
    "auto",
  );
  const state = useKit.getState();
  if (state.error && !Object.keys(state.samples).length) return;
  let best: PieceId = "kick";
  let bestCount = -1;
  let voices = 0;
  for (const piece of PIECES) {
    const count = state.pieces[piece.id].sampleIds.length;
    if (count > 0) voices++;
    if (count > bestCount) {
      bestCount = count;
      best = piece.id;
    }
  }
  const unknown = state.unsorted.length;
  const extra = [
    preview.truncated ? "Only the first eight minutes were read." : "",
    preview.capped
      ? "Took the first 180 hits. Lower the sensitivity if the file is one continuous track."
      : "",
    unknown ? `${unknown} ${unknown === 1 ? "was" : "were"} not recognized and sit under Unsorted.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  useKit.setState({
    selected: bestCount > 0 ? best : state.selected,
    notice:
      `${preview.slices.length} ${preview.slices.length === 1 ? "hit" : "hits"} across ${voices} ${voices === 1 ? "voice" : "voices"}. Matching drums at different strengths are velocity layers. ${extra}`.trim(),
  });
}

type Held = {
  channels: Float32Array[];
  sampleRate: number;
  fileName: string;
  truncated: boolean;
};

export function Cutter({ job }: { job: { file: File; id: number } | null }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const seenJob = useRef<number | null>(null);
  const heldRef = useRef<Held | null>(null);
  const previewRef = useRef<CutPreview | null>(null);
  const optsRef = useRef<SplitOpts>(DEFAULT_SPLIT);
  const applyGen = useRef(0);
  const loadGen = useRef(0);
  const commitTimer = useRef(0);
  const chain = useRef(Promise.resolve());

  function enqueue(gen: number) {
    chain.current = chain.current.then(() => settle(gen)).catch(() => undefined);
  }
  const [sensitivity, setSensitivity] = useState(Math.round(DEFAULT_SPLIT.sensitivity * 100));
  const [minGap, setMinGap] = useState(DEFAULT_SPLIT.minGapMs);
  const [preview, setPreview] = useState<CutPreview | null>(null);
  const busy = useKit((s) => s.busy);

  optsRef.current = {
    sensitivity: sensitivity / 100,
    minGapMs: minGap,
    maxLenMs: DEFAULT_SPLIT.maxLenMs,
  };

  function show(next: CutPreview) {
    previewRef.current = next;
    setPreview(next);
  }

  async function settle(gen: number) {
    if (gen !== applyGen.current) return;
    const held = heldRef.current;
    const current = previewRef.current;
    if (!held || !current) return;
    if (!current.slices.length) {
      useKit.setState({
        busy: null,
        error: "No clear hits found. Raise the sensitivity, or check that the file has gaps between hits.",
      });
      return;
    }
    useKit.setState({ busy: "Sorting by sound…", error: null });
    await paint();
    if (gen !== applyGen.current) return;
    const files = slicesToFiles(held.channels, held.sampleRate, current.slices);
    if (gen !== applyGen.current) return;
    await commit(files, current);
  }

  function schedule(immediate: boolean) {
    window.clearTimeout(commitTimer.current);
    const held = heldRef.current;
    if (!held) return;
    const next = previewCut(held.channels, held.sampleRate, held.fileName, optsRef.current, held.truncated);
    show(next);
    const gen = ++applyGen.current;
    if (immediate) enqueue(gen);
    else commitTimer.current = window.setTimeout(() => enqueue(gen), 280);
  }

  async function run(source: Source) {
    window.clearTimeout(commitTimer.current);
    const load = ++loadGen.current;
    applyGen.current++;
    heldRef.current = null;
    useKit.setState({
      error: null,
      notice: null,
      busy: source.kind === "file" ? "Reading audio file…" : "Slicing practice dump…",
    });
    await paint();
    try {
      const held: Held =
        source.kind === "file"
          ? { ...(await readCutFile(source.file)), fileName: source.file.name }
          : { channels: [renderDump(practiceHits())], sampleRate: 44100, fileName: "Practice dump", truncated: false };
      if (load !== loadGen.current) return;
      heldRef.current = held;
      schedule(true);
    } catch (err) {
      if (load !== loadGen.current) return;
      useKit.setState({ busy: null, error: err instanceof Error ? err.message : "Could not slice the file" });
    }
  }

  useEffect(() => {
    if (!job || seenJob.current === job.id) return;
    seenJob.current = job.id;
    void run({ kind: "file", file: job.file });
    // A new drop starts a cut. Knob changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  useEffect(() => {
    if (!heldRef.current) return;
    const id = window.setTimeout(() => schedule(false), 0);
    return () => window.clearTimeout(id);
    // schedule reads the latest knobs through optsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sensitivity, minGap]);

  return (
    <Device title="Slice">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 max-w-xl">
          <p className="text-sm text-muted">
            One recording with many drum hits. Turn the knobs and the cuts follow. A wrong voice can be moved
            afterwards.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <button
            type="button"
            className="btn btn-primary w-full sm:w-auto"
            disabled={!!busy}
            onClick={() => inputRef.current?.click()}
          >
            <AudioLines className="size-4" />
            Choose audio file
          </button>
          <button
            type="button"
            className="btn btn-metal w-full sm:w-auto"
            disabled={!!busy}
            onClick={() => void run({ kind: "demo" })}
          >
            Practice dump
          </button>
        </div>
      </div>
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept="audio/*,.wav,.aif,.aiff,.mp3,.flac,.ogg,.m4a"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void run({ kind: "file", file });
        }}
      />

      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-4">
        <Knob
          label="Sensitivity"
          value={sensitivity}
          min={10}
          max={95}
          display={String(sensitivity)}
          onChange={setSensitivity}
        />
        <Knob
          label="Min gap"
          value={minGap}
          min={40}
          max={220}
          step={5}
          display={`${minGap} ms`}
          onChange={setMinGap}
        />
      </div>

      {preview && (
        <div className="mt-4">
          <div className="mb-2">
            <p className="truncate text-sm">
              {preview.fileName}
              <span className="ml-2 font-mono text-xs text-muted">
                {clock(preview.frames / preview.sampleRate)} · {preview.slices.length}{" "}
                {preview.slices.length === 1 ? "hit" : "hits"}
              </span>
            </p>
          </div>
          <Waveform
            stretch
            className="mt-1 h-24 w-full"
            peaks={preview.overview}
            markers={preview.frames ? preview.slices.map((slice) => slice.start / preview.frames) : []}
            label="Hits in the file"
          />
        </div>
      )}
    </Device>
  );
}
