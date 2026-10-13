export type VelRange = {
  lo: number;
  hi: number;
  fadeIn: number;
  fadeOut: number;
  /** Velocity layer. Samples that share a group alternate when `alternate` is set. */
  group: number;
  alternate: boolean;
};

export type MapOptions = {
  /** null/omitted = one layer per sample. Otherwise peaks within this many dB share a layer. */
  alternateDb?: number | null;
  /** When true, layer order follows the list. Otherwise quiet peaks map to low velocity. */
  manual?: boolean;
};

export function equalRanges(count: number): { lo: number; hi: number }[] {
  if (count <= 0) return [];
  if (count === 1) return [{ lo: 1, hi: 127 }];
  const ranges: { lo: number; hi: number }[] = [];
  let cursor = 1;
  const n = Math.min(count, 127);
  for (let i = 0; i < n; i++) {
    const left = n - i;
    const remain = 127 - cursor + 1;
    const width = Math.max(1, Math.floor(remain / left));
    const hi = i === n - 1 ? 127 : Math.min(127, cursor + width - 1);
    ranges.push({ lo: cursor, hi });
    cursor = hi + 1;
  }
  return ranges;
}

function amplitudeRanges(peaks: number[]): { lo: number; hi: number }[] {
  const n = peaks.length;
  if (n <= 1) return equalRanges(n);
  const span = peaks[n - 1] - peaks[0];
  if (!(span > 1e-6)) return equalRanges(n);
  for (let i = 1; i < n; i++) {
    if (peaks[i] + 1e-9 < peaks[i - 1]) return equalRanges(n);
  }
  const pos = peaks.map((p) => 1 + ((p - peaks[0]) / span) * 126);
  const bounds: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    let b = Math.round((pos[i] + pos[i + 1]) / 2);
    const minB = i + 1;
    const maxB = 127 - (n - 1 - i);
    b = Math.max(minB, Math.min(maxB, b));
    if (bounds.length) b = Math.max(b, bounds[bounds.length - 1] + 1);
    bounds.push(b);
  }
  const ranges: { lo: number; hi: number }[] = [];
  let cursor = 1;
  for (let i = 0; i < n; i++) {
    const hi = i === n - 1 ? 127 : bounds[i];
    ranges.push({ lo: cursor, hi: Math.max(cursor, hi) });
    cursor = hi + 1;
  }
  return ranges;
}

function peakDb(peak: number): number {
  if (!(peak > 1e-8)) return -96;
  return 20 * Math.log10(peak);
}

/**
 * Group hits whose peaks sit within `toleranceDb` of the quietest member.
 * Group ids are in velocity order: quiet → loud, unless `manual` keeps list order.
 */
export function clusterByAmplitude(
  peaks: number[],
  toleranceDb: number,
  manual: boolean,
): { groupOf: number[]; reps: number[] } {
  const n = peaks.length;
  const groupOf = new Array<number>(n).fill(0);
  if (n === 0) return { groupOf, reps: [] };

  const tol = Math.max(0.05, toleranceDb);
  const order = peaks
    .map((p, i) => ({ i, db: peakDb(p) }))
    .sort((a, b) => a.db - b.db || a.i - b.i);

  const members: number[][] = [];
  let anchor = order[0].db;
  let current: number[] = [];
  for (const item of order) {
    if (current.length && item.db - anchor > tol) {
      members.push(current);
      current = [];
      anchor = item.db;
    }
    current.push(item.i);
  }
  if (current.length) members.push(current);

  const ranked = members.map((idxs) => ({
    idxs,
    peak: idxs.reduce((sum, i) => sum + peaks[i], 0) / idxs.length,
    pos: Math.min(...idxs),
  }));
  ranked.sort((a, b) => (manual ? a.pos - b.pos || a.peak - b.peak : a.peak - b.peak || a.pos - b.pos));

  const reps: number[] = [];
  ranked.forEach((cluster, gid) => {
    for (const i of cluster.idxs) groupOf[i] = gid;
    reps.push(cluster.peak);
  });
  return { groupOf, reps };
}

export function mapVelocity(
  peaksInOrder: number[],
  mode: "equal" | "amplitude",
  crossfade: number,
  options?: MapOptions,
): VelRange[] {
  const alternateDb = options?.alternateDb;
  const manual = options?.manual ?? false;
  const grouped = alternateDb != null && alternateDb >= 0;
  const { groupOf, reps } = grouped
    ? clusterByAmplitude(peaksInOrder, alternateDb, manual)
    : { groupOf: peaksInOrder.map((_, i) => i), reps: peaksInOrder.slice() };

  const base = mode === "amplitude" ? amplitudeRanges(reps) : equalRanges(reps.length);
  const xf = Math.max(0, Math.round(crossfade));
  const groupRanges = base.map((range, i) => {
    const lo = i === 0 ? range.lo : Math.max(1, range.lo - xf);
    const hi = i === base.length - 1 ? range.hi : Math.min(127, range.hi + xf);
    return {
      lo: Math.min(lo, hi),
      hi: Math.max(lo, hi),
      fadeIn: i === 0 ? 0 : xf,
      fadeOut: i === base.length - 1 ? 0 : xf,
    };
  });

  const sizes = new Array(reps.length).fill(0);
  for (const g of groupOf) sizes[g] += 1;

  return peaksInOrder.map((_, i) => {
    const g = groupOf[i];
    const range = groupRanges[g];
    return {
      lo: range.lo,
      hi: range.hi,
      fadeIn: range.fadeIn,
      fadeOut: range.fadeOut,
      group: g,
      alternate: sizes[g] > 1,
    };
  });
}

export function layerAtVelocity(ranges: VelRange[], velocity: number): number {
  const v = Math.max(1, Math.min(127, Math.round(velocity)));
  const exact = ranges.findIndex((r) => v >= r.lo && v <= r.hi);
  if (exact >= 0) return exact;
  let best = 0;
  let bestDist = Infinity;
  ranges.forEach((r, i) => {
    const dist = v < r.lo ? r.lo - v : v - r.hi;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

/** Every sample that should take turns at this velocity. One entry when the layer is alone. */
export function alternateIndices(ranges: VelRange[], velocity: number): number[] {
  if (!ranges.length) return [];
  const hit = layerAtVelocity(ranges, velocity);
  if (!ranges[hit].alternate) return [hit];
  const group = ranges[hit].group;
  const all: number[] = [];
  ranges.forEach((range, index) => {
    if (range.group === group) all.push(index);
  });
  return all.length ? all : [hit];
}

const lastPick = new Map<string, number>();

/** Next sample in the layer. Skips the one that just played when another exists. */
export function nextAlternateIndex(key: string, indices: number[]): number {
  if (indices.length === 0) return 0;
  if (indices.length === 1) {
    lastPick.set(key, indices[0]);
    return indices[0];
  }
  const prev = lastPick.get(key);
  const at = prev == null ? -1 : indices.indexOf(prev);
  const pick = indices[(at + 1) % indices.length];
  lastPick.set(key, pick);
  return pick;
}
