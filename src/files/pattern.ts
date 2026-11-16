// The one pattern facility (§6.1, R-55): a pattern that parses is never refused for being slow; it
// runs where it can be stopped. Each run goes to a worker thread, and the caller waits on it through
// a shared buffer for at most the time it is given, so a check that must answer at once (a stream
// rule's, a grep's line) stays synchronous. Past the time the worker is stopped and a new one made,
// and the run says it ran out of time, which counts as no match; the next run goes on. The worker's
// code travels inside this module, so a bundled host carries it. Exported from `rp-harness/helpers`,
// so RPE's grep runs through it too (PlanHarnessCore-26).

/** A pattern's run on one text: its first match (or none), or that it ran out of time. */
export type PatternRun = { match: { index: number; text: string } | null } | { timedOut: true };

/** The worker: it compiles each pattern once, runs it from the text's start, and writes where it matched into the shared buffer. */
const WORKER = `
const compiled = new Map();
let shared;
self.onmessage = (event) => {
  const asked = event.data;
  if (asked.buffer !== undefined) {
    shared = new Int32Array(asked.buffer);
    Atomics.store(shared, 3, 1);
    Atomics.notify(shared, 3);
    return;
  }
  let index = -1;
  let length = 0;
  try {
    const key = asked.flags + "/" + asked.source;
    let pattern = compiled.get(key);
    if (pattern === undefined) {
      pattern = new RegExp(asked.source, asked.flags);
      compiled.set(key, pattern);
    }
    pattern.lastIndex = 0;
    const found = pattern.exec(asked.text);
    if (found !== null) {
      index = found.index;
      length = found[0].length;
    }
  } catch {
    index = -1;
  }
  Atomics.store(shared, 1, index);
  Atomics.store(shared, 2, length);
  Atomics.store(shared, 0, asked.seq);
  Atomics.notify(shared, 0);
};
`;

/** The longest wait for a new worker to be ready: its start is no pattern's time. */
const READY_MS = 5_000;

/** Slots of the shared buffer: the run answered (its number), where it matched, how long the match is, the worker is ready. */
const ANSWERED = 0;
const INDEX = 1;
const LENGTH = 2;
const READY = 3;

interface Running {
  worker: Worker;
  shared: Int32Array;
}

let url: string | undefined;
let running: Running | undefined;
let runs = 0;

function started(): Running {
  url ??= URL.createObjectURL(new Blob([WORKER], { type: "application/javascript" }));
  const worker = new Worker(url);
  // Never holds the process open: a host that is done ends with the worker idle. Bun's worker has `unref`, which the DOM's type leaves out.
  (worker as Worker & { unref(): void }).unref();
  const buffer = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  worker.postMessage({ buffer });
  return { worker, shared: new Int32Array(buffer) };
}

/**
 * `pattern`'s first match in `text`, from its start, run where it is stopped after `ms`
 * milliseconds: then `timedOut`, and the worker that ran it is replaced. Synchronous: the caller
 * waits on the worker.
 */
export function runPattern(pattern: RegExp, text: string, ms: number): PatternRun {
  const now = (running ??= started());
  if (Atomics.load(now.shared, READY) === 0) Atomics.wait(now.shared, READY, 0, READY_MS);
  runs += 1;
  const seq = runs;
  Atomics.store(now.shared, ANSWERED, 0);
  now.worker.postMessage({ seq, source: pattern.source, flags: pattern.flags, text });
  Atomics.wait(now.shared, ANSWERED, 0, ms);
  if (Atomics.load(now.shared, ANSWERED) !== seq) {
    now.worker.terminate();
    running = undefined;
    return { timedOut: true };
  }
  const index = Atomics.load(now.shared, INDEX);
  return { match: index < 0 ? null : { index, text: text.slice(index, index + Atomics.load(now.shared, LENGTH)) } };
}
