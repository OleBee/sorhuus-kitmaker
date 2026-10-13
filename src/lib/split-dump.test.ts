import assert from "node:assert/strict";
import { practiceHits, renderDump } from "./dump-demo.ts";
import { splitDump } from "./split-dump.ts";

const hits = practiceHits();
const audio = renderDump(hits);
const result = splitDump([audio], 44100, { sensitivity: 0.55, minGapMs: 80, maxLenMs: 4000 });

assert.equal(result.slices.length, hits.length, `slice count ${result.slices.length}`);
for (let i = 0; i < hits.length; i++) {
  assert.equal(result.slices[i]?.piece, hits[i].piece, `slice ${i} wanted ${hits[i].piece}`);
}
