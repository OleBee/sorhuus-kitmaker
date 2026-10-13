import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, Download, Drum, Play, RotateCcw, Trash2, Upload } from "lucide-react";
import { Cutter } from "@/components/cutter";
import { Device, Knob, Screws, Waveform } from "@/components/chrome";
import { collectDropped } from "@/lib/drop-files";
import { formatDb, isAudioName, noteName, PIECES, pieceById, pieceByKey, safeToken, type PieceId } from "@/lib/drums";
import { useKit, type SampleItem } from "@/lib/kit-store";
import { playBuffer } from "@/lib/preview-audio";
import { buildRefill, type ExportKit } from "@/lib/refill";
import { renderSplash } from "@/lib/splash";
import { alternateIndices, mapVelocity, nextAlternateIndex, type VelRange } from "@/lib/velocity";
import { zipStore } from "@/lib/zip";

const PAD_IDS = ["kick", "snare", "hatClosed", "hatOpen", "tomHigh", "tomMid", "tomLow", "crash", "ride", "clap"] as const;

const LAYER_SOLO = "#e15d68";
const LAYER_ALT = ["#e2a56c", "#7ec8b8", "#b398e0", "#7eaddb"];

function layerColors(ranges: VelRange[]): string[] {
  const groups: number[] = [];
  for (const range of ranges) {
    if (range.alternate && !groups.includes(range.group)) groups.push(range.group);
  }
  return ranges.map((range) => {
    if (!range.alternate) return LAYER_SOLO;
    return LAYER_ALT[groups.indexOf(range.group) % LAYER_ALT.length];
  });
}

function pieceRanges(
  peaks: number[],
  state: {
    mode: "equal" | "amplitude";
    crossfade: number;
    alternate: boolean;
    alternateDb: number;
  },
  manual: boolean,
) {
  return mapVelocity(peaks, state.mode, state.crossfade, {
    alternateDb: state.alternate ? state.alternateDb : null,
    manual,
  });
}

export function Studio() {
  const kit = useKit();
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [cutJob, setCutJob] = useState<{ file: File; id: number } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);

  const sampleCount = Object.keys(kit.samples).length;
  const voiced = PIECES.filter((p) => kit.pieces[p.id].sampleIds.length > 0).length;
  const selected = kit.pieces[kit.selected];
  const selectedMeta = pieceById(kit.selected);
  const ordered = selected.sampleIds;
  const ranges = pieceRanges(
    ordered.map((id) => kit.samples[id].peak),
    kit,
    selected.manual,
  );
  const colors = layerColors(ranges);
  const layerCount = new Set(ranges.map((range) => range.group)).size;
  const filled = PIECES.filter((piece) => kit.pieces[piece.id].sampleIds.length > 0);
  const voiceList = filled.length ? filled : PIECES;
  const shown = [...kit.unsorted, ...[...ordered].reverse()];
  const pickedHere = picked.filter((id) => shown.includes(id));

  const filledKey = filled.map((piece) => piece.id).join(",");

  useEffect(() => {
    if (!filledKey) return;
    const ids = filledKey.split(",") as PieceId[];
    if (!ids.includes(kit.selected)) kit.setSelected(ids[0]);
  }, [filledKey, kit.selected, kit]);

  useEffect(() => {
    setPicked([]);
    anchor.current = null;
  }, [kit.selected]);

  function togglePick(id: string, shift: boolean) {
    const from = anchor.current;
    if (shift && from && shown.includes(from)) {
      const a = shown.indexOf(from);
      const b = shown.indexOf(id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setPicked((cur) => [...new Set([...cur, ...shown.slice(lo, hi + 1)])]);
      return;
    }
    anchor.current = id;
    setPicked((cur) => (cur.includes(id) ? cur.filter((item) => item !== id) : [...cur, id]));
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const pieceId = pieceByKey(event.key);
      if (!pieceId) return;
      event.preventDefault();
      playPiece(pieceId, useKit.getState().auditionVelocity);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let depth = 0;
    const allows = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");
    const enter = (event: DragEvent) => {
      if (!allows(event)) return;
      event.preventDefault();
      depth += 1;
      setDragOver(true);
    };
    const over = (event: DragEvent) => {
      if (!allows(event)) return;
      event.preventDefault();
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    };
    const drop = (event: DragEvent) => {
      if (!allows(event) || !event.dataTransfer) return;
      event.preventDefault();
      depth = 0;
      setDragOver(false);
      void collectDropped(event.dataTransfer).then((files) => {
        if (!files.length) return;
        if (files.length === 1 && isAudioName(files[0].name)) {
          setCutJob({ file: files[0].file, id: Date.now() });
          return;
        }
        void useKit.getState().addIncoming(
          files.map((item) => ({ file: item.file, name: item.name, hint: item.hint })),
          "auto",
        );
      });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  function playPiece(pieceId: PieceId, velocity: number) {
    const state = useKit.getState();
    const ids = state.pieces[pieceId].sampleIds;
    if (!ids.length) {
      state.setSelected(pieceId);
      return;
    }
    const nextRanges = pieceRanges(
      ids.map((id) => state.samples[id].peak),
      state,
      state.pieces[pieceId].manual,
    );
    const choices = alternateIndices(nextRanges, velocity);
    if (!choices.length) return;
    const layer = nextRanges[choices[0]];
    const index = nextAlternateIndex(`${pieceId}:${layer.lo}-${layer.hi}`, choices);
    const sample = state.samples[ids[index]];
    playBuffer(sample.buffer);
    state.setSelected(pieceId);
    state.setAudition(velocity);
    state.setLastHit({ pieceId, sampleId: sample.id, velocity });
  }

  async function takeFiles(list: { file: File; hint: string; name: string }[], target: PieceId | "auto") {
    await kit.addIncoming(
      list.map((item) => ({ file: item.file, name: item.name, hint: item.hint })),
      target,
    );
  }

  async function onExport() {
    const state = useKit.getState();
    const pieces = PIECES.map((meta) => ({
      id: meta.id,
      note: state.pieces[meta.id].note,
      manual: state.pieces[meta.id].manual,
      samples: state.pieces[meta.id].sampleIds.map((id) => {
        const sample = state.samples[id];
        return {
          name: sample.name,
          ext: sample.ext,
          bytes: sample.bytes,
          peak: sample.peak,
          frames: sample.frames,
        };
      }),
    })).filter((piece) => piece.samples.length > 0);
    if (!pieces.length) return;
    useKit.setState({ busy: "Building kit…", error: null });
    try {
      const splash = await renderSplash();
      const exportKit: ExportKit = {
        name: state.name,
        author: state.author,
        copyright: state.copyright,
        url: state.url,
        comment: state.comment,
        mode: state.mode,
        crossfade: state.crossfade,
        levelMatch: state.levelMatch,
        alternate: state.alternate,
        alternateDb: state.alternateDb,
        pieces,
      };
      const zip = zipStore(buildRefill(exportKit, splash));
      const blob = new Blob([zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer], {
        type: "application/zip",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeToken(state.name) || "Drum-Kit"}.zip`;
      link.click();
      URL.revokeObjectURL(url);
      useKit.setState({
        busy: null,
        notice: "Kit folder downloaded. Unzip it and keep the Samples folder next to the patches.",
      });
    } catch (err) {
      useKit.setState({
        busy: null,
        error: err instanceof Error ? err.message : "Could not build the kit",
      });
    }
  }

  return (
    <div className="rack min-h-screen overflow-x-hidden text-fg">
      <div className="h-1 bg-amber" />
      <header className="device mx-auto mt-4 max-w-6xl">
        <Screws />
        <div className="flex flex-col gap-5 pl-4 pr-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-mono text-xs tracking-widest text-amber">
              <span className="led led-on" aria-hidden />
              DRUM KITS
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Sörhuus KitMaker</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
              One long recording in, one drum kit out. Hits are sliced and sorted by sound. Different strengths
              of the same drum become velocity layers.
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:max-w-sm">
            <label className="text-xs tracking-wide text-muted" htmlFor="kit-name">
              Kit name
            </label>
            <input
              id="kit-name"
              className="lcd-input"
              value={kit.name}
              onChange={(event) => kit.setField("name", event.target.value)}
            />
            <button type="button" className="btn btn-primary" disabled={!sampleCount || !!kit.busy} onClick={() => void onExport()}>
              <Download className="size-4" />
              Download kit folder
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid min-w-0 max-w-6xl gap-3 px-4 py-3 sm:px-6">
        <Cutter job={cutJob} />

        <div className="grid min-w-0 gap-3 lg:grid-cols-12">
          <Device
            className="lg:col-span-4"
            title="Voices"
            aside={
              <span className="lcd">
                {voiced} · {sampleCount}
              </span>
            }
          >
            <div className="flex min-w-0 gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
              {voiceList.map((meta) => {
                const count = kit.pieces[meta.id].sampleIds.length;
                const active = kit.selected === meta.id;
                return (
                  <button
                    key={meta.id}
                    type="button"
                    onClick={() => kit.setSelected(meta.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void collectDropped(event.dataTransfer).then((files) => takeFiles(files, meta.id));
                    }}
                    data-on={active ? "true" : "false"}
                    className="voice"
                  >
                    <span className={`led ${count ? "led-on" : ""}`} aria-hidden />
                    <span className="w-8 font-mono text-xs text-amber">{meta.short}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{meta.label}</span>
                      <span className="font-mono text-xs text-muted">
                        {noteName(kit.pieces[meta.id].note)} · {count}
                      </span>
                    </span>
                    {count > 0 ? (
                      <Waveform
                        peaks={kit.samples[kit.pieces[meta.id].sampleIds[count - 1]].peaks}
                        fit
                        hot={active}
                        decorative
                        className="h-6 w-14 shrink-0"
                      />
                    ) : null}
                  </button>
                );
              })}
              {kit.unsorted.length > 0 && (
                <div className="voice">
                  <span className="led" aria-hidden />
                  <span className="w-8 font-mono text-xs text-muted">?</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">Unsorted</span>
                    <span className="font-mono text-xs text-muted">{kit.unsorted.length}</span>
                  </span>
                </div>
              )}
            </div>
          </Device>

          <Device
            className="lg:col-span-8"
            title={selectedMeta.label}
            aside={
              <label className="flex items-center gap-2 text-xs text-muted" htmlFor="midi-note">
                Note
                <input
                  id="midi-note"
                  className="lcd-input w-16 text-center"
                  type="number"
                  min={0}
                  max={127}
                  value={selected.note}
                  onChange={(event) => kit.setNote(kit.selected, Number(event.target.value))}
                />
              </label>
            }
          >
            <p className="mb-3 font-mono text-xs text-muted">
              Key {selectedMeta.key.toUpperCase()} · MIDI {selected.note}
            </p>

            <div
              className={`well mb-4 border border-dashed px-4 py-5 ${ordered.length ? "border-line" : "border-amber"}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void collectDropped(event.dataTransfer).then((files) => takeFiles(files, kit.selected));
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Upload className="mt-0.5 size-5 shrink-0 text-amber" />
                  <div>
                    <p className="text-sm font-medium">Or drop single samples on {selectedMeta.label.toLowerCase()}</p>
                    <p className="text-sm text-muted">
                      A folder of named samples is sorted by filename. Wav and aiff are left untouched.
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button type="button" className="btn btn-metal whitespace-nowrap" onClick={() => inputRef.current?.click()}>
                    Files
                  </button>
                  <button type="button" className="btn btn-metal whitespace-nowrap" onClick={() => folderRef.current?.click()}>
                    Folder
                  </button>
                  <button
                    type="button"
                    className="btn btn-metal whitespace-nowrap"
                    onClick={() => void kit.loadDemo()}
                    disabled={!!kit.busy}
                  >
                    <Drum className="size-4" />
                    Demo kit
                  </button>
                </div>
              </div>
              <input
                ref={inputRef}
                className="hidden"
                type="file"
                accept="audio/*,.wav,.aif,.aiff,.mp3,.flac,.ogg,.m4a"
                multiple
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])].map((file) => ({
                    file,
                    hint: file.webkitRelativePath || "",
                    name: file.name,
                  }));
                  void takeFiles(files, kit.selected);
                  event.target.value = "";
                }}
              />
              <input
                ref={(node) => {
                  folderRef.current = node;
                  if (node) {
                    node.setAttribute("webkitdirectory", "");
                    node.setAttribute("directory", "");
                  }
                }}
                className="hidden"
                type="file"
                multiple
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])].map((file) => ({
                    file,
                    hint: file.webkitRelativePath || "",
                    name: file.name,
                  }));
                  void takeFiles(files, "auto");
                  event.target.value = "";
                }}
              />
            </div>

            <div className="mb-4 grid gap-4 rounded-sm bg-bg/40 p-3 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-xs text-muted">Layer width</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-on={kit.mode === "equal" ? "true" : "false"}
                    className="btn btn-metal flex-1"
                    onClick={() => kit.setMode("equal")}
                  >
                    Equal
                  </button>
                  <button
                    type="button"
                    data-on={kit.mode === "amplitude" ? "true" : "false"}
                    className="btn btn-metal flex-1"
                    onClick={() => kit.setMode("amplitude")}
                  >
                    By amplitude
                  </button>
                </div>
              </div>
              <Knob
                label="Crossfade"
                value={kit.crossfade}
                min={0}
                max={24}
                display={String(kit.crossfade)}
                onChange={kit.setCrossfade}
              />
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={kit.levelMatch}
                  onChange={(event) => kit.setLevelMatch(event.target.checked)}
                />
                <span>
                  Even out level
                  <span className="mt-0.5 block text-xs text-muted">Only the tone changes, not the loudness</span>
                </span>
              </label>
              <div>
                <label className="flex min-h-11 items-start gap-3 text-sm">
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={kit.alternate}
                    onChange={(event) => kit.setAlternate(event.target.checked)}
                  />
                  <span>
                    Alternate matching hits
                    <span className="mt-0.5 block text-xs text-muted">
                      Same amplitude swaps samples, here and in the patch.
                    </span>
                  </span>
                </label>
                <div className="mt-3">
                  <Knob
                    label="Same within"
                    value={kit.alternateDb}
                    min={0}
                    max={3}
                    step={0.1}
                    display={`${kit.alternateDb.toFixed(1)} dB`}
                    disabled={!kit.alternate}
                    onChange={kit.setAlternateDb}
                  />
                </div>
              </div>
            </div>

            {kit.busy && (
              <p className="mb-3 font-mono text-xs text-amber" role="status">
                {kit.busy}
              </p>
            )}
            {kit.error && (
              <p className="mb-3 text-sm text-amber" role="alert">
                {kit.error}
              </p>
            )}
            {kit.notice && !kit.error && (
              <p className="mb-3 text-sm text-muted" role="status">
                {kit.notice}
              </p>
            )}

            {(kit.unsorted.length > 0 || ordered.length > 0) && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex h-11 items-center gap-2 text-sm">
                  <Tick
                    checked={shown.length > 0 && pickedHere.length === shown.length}
                    label="Select all samples"
                    onClick={() => setPicked(pickedHere.length === shown.length ? [] : shown)}
                  />
                  <span className="font-mono text-xs text-muted">
                    {pickedHere.length ? `${pickedHere.length} selected` : "Select"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-40">
                    <select
                      className="field"
                      aria-label="Move selected to"
                      value=""
                      disabled={!pickedHere.length}
                      onChange={(event) => {
                        const next = event.target.value as PieceId;
                        if (!next || !pickedHere.length) return;
                        kit.reassignMany(pickedHere, next);
                        setPicked([]);
                        anchor.current = null;
                      }}
                    >
                      <option value="">Move selected</option>
                      {PIECES.map((meta) => (
                        <option key={meta.id} value={meta.id}>
                          {meta.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {ordered.length > 0 && (
                    <button
                      type="button"
                      className="h-11 shrink-0 text-xs text-amber"
                      onClick={() => kit.sortPiece(kit.selected)}
                    >
                      Sort by amplitude
                    </button>
                  )}
                </div>
              </div>
            )}

            {kit.unsorted.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-2 text-sm font-semibold">Unsorted</h3>
                <ul className="flex flex-col gap-1">
                  {kit.unsorted.map((id) => (
                    <SampleLine
                      key={id}
                      sample={kit.samples[id]}
                      picked={pickedHere.includes(id)}
                      onToggle={(shift) => togglePick(id, shift)}
                      onPlay={() => playBuffer(kit.samples[id].buffer)}
                      onFade={(ms) => kit.setFade(id, ms)}
                      onRemove={() => kit.removeSample(id)}
                    />
                  ))}
                </ul>
              </div>
            )}

            {ordered.length === 0 ? (
              <p className="well px-4 py-8 text-sm text-muted">
                No samples on this voice yet. Soft, medium, and hard hits become their own velocity layers.
                Several hits at the same strength take turns instead of stacking.
              </p>
            ) : (
              <div>
                <h3 className="mb-2 text-sm font-semibold">
                  Velocity layers
                  <span className="ml-2 font-normal text-muted">
                    {layerCount} {layerCount === 1 ? "layer" : "layers"}
                    {layerCount < ordered.length ? ` · ${ordered.length} samples` : ""}
                  </span>
                </h3>
                <ol className="flex flex-col gap-1">
                  {[...ordered].reverse().map((id) => {
                    const index = ordered.indexOf(id);
                    return (
                      <LayerRow
                        key={id}
                        sample={kit.samples[id]}
                        range={ranges[index]}
                        color={colors[index]}
                        hot={kit.lastHit?.sampleId === id}
                        picked={pickedHere.includes(id)}
                        canUp={index < ordered.length - 1}
                        canDown={index > 0}
                        onToggle={(shift) => togglePick(id, shift)}
                        onUp={() => kit.moveSample(kit.selected, id, 1)}
                        onDown={() => kit.moveSample(kit.selected, id, -1)}
                        onPlay={() => {
                          playBuffer(kit.samples[id].buffer);
                          kit.setLastHit({
                            pieceId: kit.selected,
                            sampleId: id,
                            velocity: ranges[index].lo,
                          });
                        }}
                        onFade={(ms) => kit.setFade(id, ms)}
                        onRemove={() => kit.removeSample(id)}
                      />
                    );
                  })}
                </ol>
                {selected.manual && (
                  <p className="mt-2 text-xs text-muted">
                    Order is manual. Amplitude sorting stays off until you sort again.
                  </p>
                )}
              </div>
            )}
          </Device>
        </div>

        <Device
          title="Play"
          aside={
            <Knob
              label="Key vel"
              value={kit.auditionVelocity}
              min={1}
              max={127}
              display={String(kit.auditionVelocity)}
              onChange={kit.setAudition}
            />
          }
        >
          <p className="mb-3 text-sm text-muted">
            Click high on a pad for a hard hit, low for a soft one. Hitting the same spot again swaps the sample
            when several hits share an amplitude.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {PAD_IDS.map((id) => {
              const meta = pieceById(id);
              const ids = kit.pieces[id].sampleIds;
              const active = kit.lastHit?.pieceId === id;
              const loud = ids.length ? kit.samples[ids[ids.length - 1]] : undefined;
              const shown = active && kit.lastHit ? kit.samples[kit.lastHit.sampleId] : loud;
              return (
                <button
                  key={id}
                  type="button"
                  data-hot={active ? "true" : "false"}
                  className="pad"
                  onPointerDown={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const ratio = 1 - (event.clientY - rect.top) / rect.height;
                    const velocity = Math.round(1 + Math.min(1, Math.max(0, ratio)) * 126);
                    playPiece(id, velocity);
                  }}
                >
                  <span className="flex items-center justify-between">
                    <span className="font-mono text-xs text-amber">{meta.key.toUpperCase()}</span>
                    <span className={`led ${active ? "led-on" : ""}`} aria-hidden />
                    <span className="font-mono text-xs text-muted">{ids.length || "–"}</span>
                  </span>
                  {shown ? (
                    <Waveform peaks={shown.peaks} hot={active} fit decorative className="h-8 w-full" />
                  ) : (
                    <span className="h-8" />
                  )}
                  <span>
                    <span className="block text-sm font-medium">{meta.label}</span>
                    <span className="font-mono text-xs text-muted">
                      {active && kit.lastHit ? `vel ${kit.lastHit.velocity}` : noteName(kit.pieces[id].note)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </Device>

        <div className="grid gap-3 lg:grid-cols-2">
          <details className="device group" open>
            <Screws />
            <summary className="pl-4 pr-4">
              <ChevronDown className="size-4 shrink-0 text-muted -rotate-90 group-open:rotate-0" />
              <span className="text-sm font-semibold">From a file to a kit</span>
            </summary>
            <ol className="mt-4 flex list-decimal flex-col gap-2 pl-9 pr-4 text-sm text-muted">
              <li>Load one long file, or a folder of single samples. The practice dump walks the whole path without your own file.</li>
              <li>Unzip the download. Inside are info.txt, splash.jpg, samples, and sampler patches.</li>
              <li>Load a patch from the patches folder. Do not move the files in Samples.</li>
              <li>One download is one complete kit — snare, kick, toms, and hi-hat on GM notes.</li>
            </ol>
          </details>
          <details className="device group">
            <Screws />
            <summary className="pl-4 pr-4">
              <ChevronDown className="size-4 shrink-0 text-muted -rotate-90 group-open:rotate-0" />
              <span className="text-sm font-semibold">Kit info</span>
            </summary>
            <div className="mt-4 grid gap-3 px-4">
              <label className="block text-xs text-muted">
                Author
                <input
                  className="field mt-1"
                  value={kit.author}
                  placeholder="Sörhuus KitMaker"
                  onChange={(event) => kit.setField("author", event.target.value)}
                />
              </label>
              <label className="block text-xs text-muted">
                Copyright
                <input
                  className="field mt-1"
                  value={kit.copyright}
                  placeholder="(c) 2026"
                  onChange={(event) => kit.setField("copyright", event.target.value)}
                />
              </label>
              <label className="block text-xs text-muted">
                URL
                <input
                  className="field mt-1"
                  value={kit.url}
                  placeholder="https://"
                  onChange={(event) => kit.setField("url", event.target.value)}
                />
              </label>
              <label className="block text-xs text-muted">
                Comment
                <textarea
                  className="field mt-1 h-auto min-h-24 py-2"
                  value={kit.comment}
                  placeholder="An empty field gets a short explanation automatically."
                  onChange={(event) => kit.setField("comment", event.target.value)}
                />
              </label>
              <button type="button" className="btn btn-metal" onClick={() => kit.reset()} disabled={!sampleCount}>
                <RotateCcw className="size-4" />
                Clear the kit
              </button>
            </div>
          </details>
        </div>
        <p className="max-w-3xl px-1 pb-8 text-xs leading-relaxed text-muted">
          A long file is sliced where the sound rises above the noise floor, and each hit is sorted by tone: kick,
          snare, hi-hat, tom, clap, and cymbals. Hits that sound alike but differ in strength become velocity layers.
          The level in the file is kept, so a soft hit both triggers low and sounds soft. “Even out level” lifts the
          quiet layers in the patch. A packed library file has to be made by the sampler’s own tool — the browser
          cannot pack that format.
        </p>
      </main>
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center bg-bg/80 px-6">
          <p className="lcd px-6 py-4 text-lg">Drop audio</p>
        </div>
      )}
    </div>
  );
}

function Tick({
  checked,
  label,
  onClick,
}: {
  checked: boolean;
  label: string;
  onClick: (shift: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className="flex size-11 shrink-0 items-center justify-center"
      onClick={(event) => onClick(event.shiftKey)}
    >
      <span
        className={`flex size-4 items-center justify-center rounded-[3px] ${checked ? "bg-amber text-ink" : "bg-bg shadow-[inset_0_0_0_1px_var(--color-line)]"}`}
      >
        {checked ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
    </button>
  );
}

function FadeField({ ms, name, onChange }: { ms: number; name: string; onChange: (ms: number) => void }) {
  return (
    <label className="flex w-14 shrink-0 flex-col items-center gap-0.5">
      <input
        className="lcd-input w-12 px-0 text-center font-mono text-xs"
        type="number"
        min={0}
        max={80}
        value={ms}
        aria-label={`Fade out ${name}`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="text-[10px] leading-none text-muted">fade ms</span>
    </label>
  );
}

function MarkBox({
  name,
  checked,
  onToggle,
}: {
  name: string;
  checked: boolean;
  onToggle: (shift: boolean) => void;
}) {
  return <Tick checked={checked} label={`Select ${name}`} onClick={onToggle} />;
}

function SampleLine({
  sample,
  picked,
  onToggle,
  onPlay,
  onFade,
  onRemove,
}: {
  sample: SampleItem;
  picked: boolean;
  onToggle: (shift: boolean) => void;
  onPlay: () => void;
  onFade: (ms: number) => void;
  onRemove: () => void;
}) {
  return (
    <li className="sample-row" data-on={picked ? "true" : "false"}>
      <div className="flex items-center gap-2">
        <MarkBox name={sample.name} checked={picked} onToggle={onToggle} />
        <button type="button" className="icon-btn" onClick={onPlay} aria-label={`Play ${sample.name}`}>
          <Play className="ml-0.5 size-4" />
        </button>
        <p className="min-w-0 flex-1 truncate text-sm">{sample.name}</p>
        <span className="shrink-0 font-mono text-xs text-muted">{formatDb(sample.peak)}</span>
        <FadeField ms={sample.fadeOutMs} name={sample.name} onChange={onFade} />
        <button type="button" className="icon-btn" onClick={onRemove} aria-label="Remove sample">
          <Trash2 className="size-4" />
        </button>
      </div>
    </li>
  );
}

function LayerRow({
  sample,
  range,
  color,
  hot,
  picked,
  canUp,
  canDown,
  onToggle,
  onUp,
  onDown,
  onPlay,
  onFade,
  onRemove,
}: {
  sample: SampleItem;
  range: VelRange;
  color: string;
  hot: boolean;
  picked: boolean;
  canUp: boolean;
  canDown: boolean;
  onToggle: (shift: boolean) => void;
  onUp: () => void;
  onDown: () => void;
  onPlay: () => void;
  onFade: (ms: number) => void;
  onRemove: () => void;
}) {
  const dur = sample.sampleRate ? `${(sample.frames / sample.sampleRate).toFixed(2)} s` : "";
  return (
    <li
      className="sample-row"
      data-hot={hot ? "true" : "false"}
      data-on={picked ? "true" : "false"}
      style={{ "--layer": color } as CSSProperties}
    >
      <div className="flex items-center gap-2">
        <MarkBox name={sample.name} checked={picked} onToggle={onToggle} />
        <button type="button" className="icon-btn" onClick={onPlay} aria-label={`Play ${sample.name}`}>
          <Play className="ml-0.5 size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm">{sample.name}</p>
            <p className="shrink-0 font-mono text-xs" style={{ color: "var(--layer)" }}>
              {range.alternate ? "ALT " : ""}
              {String(range.lo).padStart(3, "0")}–{String(range.hi).padStart(3, "0")}
            </p>
          </div>
          <Waveform
            peaks={sample.peaks}
            hot={hot}
            fit
            className="mt-1 h-8 w-full rounded-sm bg-bg"
            label={`Waveform of ${sample.name}`}
          />
          <p className="mt-1 font-mono text-xs text-muted">
            {formatDb(sample.peak)} · {dur}
            {sample.channels > 1 ? " · stereo" : " · mono"}
          </p>
        </div>
        <FadeField ms={sample.fadeOutMs} name={sample.name} onChange={onFade} />
        <div className="flex shrink-0 gap-1">
          <button type="button" className="icon-btn" onClick={onUp} disabled={!canUp} aria-label="Higher velocity">
            <ArrowUp className="size-4" />
          </button>
          <button type="button" className="icon-btn" onClick={onDown} disabled={!canDown} aria-label="Lower velocity">
            <ArrowDown className="size-4" />
          </button>
          <button type="button" className="icon-btn" onClick={onRemove} aria-label="Remove sample">
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
    </li>
  );
}
