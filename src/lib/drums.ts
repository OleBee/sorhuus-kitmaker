export const PIECES = [
  { id: "kick", label: "Kick", short: "BD", note: 36, key: "z", folder: "Kick" },
  { id: "snare", label: "Snare", short: "SD", note: 38, key: "x", folder: "Snare" },
  { id: "hatClosed", label: "Closed hat", short: "CH", note: 42, key: "c", folder: "Hat-Closed" },
  { id: "hatOpen", label: "Open hat", short: "OH", note: 46, key: "v", folder: "Hat-Open" },
  { id: "tomHigh", label: "High tom", short: "HT", note: 48, key: "m", folder: "Tom-High" },
  { id: "tomMid", label: "Mid tom", short: "MT", note: 45, key: "n", folder: "Tom-Mid" },
  { id: "tomLow", label: "Floor tom", short: "FT", note: 41, key: "b", folder: "Tom-Low" },
  { id: "crash", label: "Crash", short: "CR", note: 49, key: "a", folder: "Crash" },
  { id: "ride", label: "Ride", short: "RD", note: 51, key: "s", folder: "Ride" },
  { id: "clap", label: "Clap", short: "CP", note: 39, key: "d", folder: "Clap" },
  { id: "rim", label: "Rim", short: "RM", note: 37, key: "f", folder: "Rim" },
  { id: "hatPedal", label: "Pedal hat", short: "PH", note: 44, key: "g", folder: "Hat-Pedal" },
  { id: "perc", label: "Percussion", short: "PC", note: 56, key: "h", folder: "Perc" },
] as const;

export type PieceId = (typeof PIECES)[number]["id"];

export const TOM_IDS = ["tomHigh", "tomMid", "tomLow"] as const satisfies readonly PieceId[];

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Reason octave: C3 = MIDI 60. */
export function noteName(midi: number): string {
  const n = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 2;
  return `${NOTES[n]}${oct}`;
}

export function pieceById(id: PieceId) {
  return PIECES.find((p) => p.id === id)!;
}

const FILE_STEM: Record<PieceId, string> = {
  kick: "bd-kick",
  snare: "sd-snare",
  hatClosed: "ch-hat",
  hatOpen: "oh-openhat",
  tomHigh: "ht-tom",
  tomMid: "mt-tom",
  tomLow: "ft-tom",
  crash: "crash",
  ride: "ride",
  clap: "clap",
  rim: "rim",
  hatPedal: "pedal-hat",
  perc: "perc",
};

export function fileStem(id: PieceId): string {
  return FILE_STEM[id];
}

export function nextPieceFileName(existingNames: string[], pieceId: PieceId, ext: string): string {
  const stem = FILE_STEM[pieceId];
  const suffix = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  const used = new Set(existingNames.map((name) => name.toLowerCase()));
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)(?:\\.[^.]+)?$`, "i");
  let max = 0;
  for (const name of existingNames) {
    const match = name.match(re);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let n = max + 1;
  let name = `${stem}-${String(n).padStart(2, "0")}${suffix}`;
  while (used.has(name.toLowerCase())) {
    n += 1;
    name = `${stem}-${String(n).padStart(2, "0")}${suffix}`;
  }
  return name;
}

export function pieceByKey(key: string): PieceId | null {
  const hit = PIECES.find((p) => p.key === key.toLowerCase());
  return hit ? hit.id : null;
}

/**
 * Classify a filename or folder hint. "tom" is generic and the caller
 * assigns it to the emptiest tom slot.
 */
export function classify(text: string): PieceId | "tom" | null {
  const s = text.toLowerCase().replace(/[_./\\]+/g, " ");

  if (
    /(?:open|åpen|apen|aapen).{0,16}(?:hat|hh|hått)|(?:hat|hihat|hi hat|hh).{0,16}(?:open|åpen|apen|aapen)|\bohh\b|\boh\b|\bopenhat\b/.test(
      s,
    )
  ) {
    return "hatOpen";
  }
  if (/pedal|foot\s*hat|foot\s*hh|\bfh\b/.test(s)) return "hatPedal";
  if (
    /(?:closed|lukket).{0,16}(?:hat|hh)|(?:hat|hihat|hi hat|hh).{0,16}(?:closed|lukket)|\bchh\b|\bclosedhat\b/.test(
      s,
    )
  ) {
    return "hatClosed";
  }
  if (/hihat|hi hat|hi-hat|hihatt|\bhat\b|\bhh\b|\bhats\b/.test(s)) return "hatClosed";
  if (/sidestick|cross\s*stick|rimshot|\brim\b|kantslag/.test(s)) return "rim";
  if (/clap|handclap|\bklapp\b/.test(s)) return "clap";
  if (/bass\s*drum|bassdrum|basstrom|stortrom|kickdrum|\bkick\b|\bbd\b|\bkicks\b/.test(s)) return "kick";
  if (/snare|skarptrom|\bvirvel\b|\bsd\b|\bsnr\b/.test(s)) return "snare";
  if (/floor\s*tom|gulvtom|low\s*tom|lav\s*tom|\btom\s*3\b|\bft\b/.test(s)) return "tomLow";
  if (/mid\s*tom|mellomtom|\btom\s*2\b|\bmt\b/.test(s)) return "tomMid";
  if (/high\s*tom|h[øo]y\s*tom|\btom\s*1\b|\bht\b/.test(s)) return "tomHigh";
  if (/\btoms?\b/.test(s)) return "tom";
  if (/crash|krasj|\bcymbal\b|\bcym\b|\bbekken\b/.test(s)) return "crash";
  if (/\bride\b/.test(s)) return "ride";
  if (/shaker|tamb|cowbell|kubjelle|conga|bongo|perkus|\bperc\b/.test(s)) return "perc";
  return null;
}

export function safeToken(input: string): string {
  const folded = input
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/Æ/g, "Ae")
    .replace(/Ø/g, "O")
    .replace(/Å/g, "A")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  const out = folded
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return out.slice(0, 48);
}

export function isAudioName(name: string): boolean {
  return /\.(wav|aif|aiff|mp3|flac|ogg|m4a|aac|caf)$/i.test(name);
}

export function toDb(peak: number): number {
  if (peak <= 1e-8) return -96;
  return 20 * Math.log10(peak);
}

export function formatDb(peak: number): string {
  const db = toDb(peak);
  if (db <= -95) return "-inf";
  return `${db.toFixed(1)} dB`;
}
