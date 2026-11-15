// `bun run test`, the gate (plan §17.5: "whole suites in both repos, each file in its own process"):
// every test file under test/, each in a process of its own, as `bun test <file>` runs it alone, n at
// a time: by default the machine's cores less two, and never more than its cores, so each file has a
// core to itself. The slowest start first, by their times in test/timings-all.json, so no long file
// is left running by itself at the end. A file the record doesn't hold yet (added since the last
// recording) runs at the record's middle time and is named in the summary as not yet timed, until
// `--record` times it, as the lead's check does at a wave's end. Each file runs on the Bun that runs
// this script, and so does every `bun` it starts: this Bun's folder comes first on the PATH each file
// is given.
//
// A file that fails among the others is run again once the others are done, alone. One that fails
// alone too has failed. One that passes alone is a defect: it fails only beside other files, because
// it leans on timing or on something another file shares or leaves behind, so it is named with its
// failing tests and the run does not pass. A file still running after `FILE_LIMIT_MS` never finished
// (its top level never finished loading, or something it started never let go): it is stopped, and
// fails as one that never finished, so the run always ends with its summary. Each test has
// `TIMEOUT_MS`: with every core busy a test that takes two seconds alone can take longer than Bun's
// five, and thirty still ends a hang.
//
// The run's wall time is printed with the cores it used, set against a bar, `BUDGET_S` (plan §17.5:
// "well under ten minutes"), beside the machine's load average when the run began and when it ended.
// The bar is a measure to report, not a test of the code: a run over it says so plainly, with that
// load, and the verdict and the exit code are the code's alone. A recording's time is not set
// against the bar: it runs fewer files at once on purpose.
//
// Each file is given a temporary folder of its own as TMPDIR, inside the run's own, so what a file
// leaves in the system's temporary folder is found and named with the file that left it: after its
// process ends, whatever is still in its folder is left behind, a defect that fails the run, and
// then the folder goes. The run's own folder goes at its end, so the runner leaves nothing itself.
//
// Every skipped test is listed with its reason. Bun gives a skip no reason of its own, so a test that
// may be skipped says why at the end of its name while it is skipped, `(skipped: <why>)`; one that
// gives none is a defect that fails the run. (In a run filtered by `-t` or `--only`, Bun counts the
// tests left out as skipped, so skips are not judged there.)
//
// The gate runs the repository's own typecheck beside the files (`bun run typecheck`) and fails when
// it fails, printing what it said; a recording and a filtered run leave it out. Each run of the gate
// also writes what it came to, file by file, as data to .cache/suite.json (which git ignores), for
// the checks that read the last whole-suite run.
//
//   bun scripts/test-all.ts [files at once] [-- <bun test arguments>]   the gate
//   bun scripts/test-all.ts --list                                       the files it runs, one a line
//   bun scripts/test-all.ts --record [files at once]                     records test/timings-all.json
//
//   --budget <s>      the bar, in seconds (default `BUDGET_S`); the owner changes it here
//   --root <folder>   runs the suite of another folder's test/ instead (the runner's own tests run their
//                     fixture suites so)
//
// What follows `--` (or the first argument that starts with "-" and is none of the above) goes on to
// each file's `bun test`, as `-t <pattern>` does; a file none of whose tests the pattern names runs
// nothing, and that fails nothing.
//
// `--record` runs every file a third of the cores at a time, so each runs as it would alone, and
// writes each one's time, its whole process's, to test/timings-all.json, which this run's order reads.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TIMINGS = "test/timings-all.json";
const RECORD = ".cache/suite.json";
/** Each test's limit: Bun's 5 s default guards against a hang, and with every core busy a test that takes 2 s alone can take longer than that. */
export const TIMEOUT_MS = 30_000;
/** How long one file may run before it is stopped as one that never finished: a few times the slowest file's time with every core busy. */
export const FILE_LIMIT_MS = 10 * 60_000;
/** The bar the gate's wall time is set against: plan §17.5 asks for both suites "finishing in well under ten minutes", read as at most six on the lead's machine, its cores less two at a time. A measure the summary reports with the machine's load, never a failure of the code. `--budget <s>` changes it. */
export const BUDGET_S = 360;

/** One file's run: whether it passed, its tests passed and failed, and what failed between its tests. */
export interface FileRun {
  file: string;
  ok: boolean;
  passed: number;
  /** The failing tests' names, each after the blocks it is in (`block > test`). */
  failed: string[];
  /** The first error Bun reported between the tests, or how the process ended when no failing test says why. */
  error: string | null;
  ms: number;
  /** What it left in its temporary folder: each entry's name, a folder's with a slash after it. */
  left: string[];
  /** Its skipped tests. */
  skipped: Skip[];
}

/** A skipped test, and why, as its name gives it (`(skipped: <why>)` at its end); null when it gives no reason. */
export interface Skip {
  name: string;
  reason: string | null;
}

export interface AllRun {
  jobs: number;
  /** The machine's cores. */
  cores: number;
  /** Whether a `-t` pattern or `--only` left tests out, which Bun counts as skipped. */
  filtered: boolean;
  /** The files the timing record doesn't hold yet, which ran at its middle time. */
  untimed: string[];
  /** The machine's one-minute load average when the run began and when it ended. */
  load: { before: number; after: number };
  ms: number;
  /** Each file's run among the others, in the order they ended. */
  first: FileRun[];
  /** The run alone of each file that failed among the others. */
  alone: FileRun[];
}

/** Every test file under `root`'s test/, as `bun test` finds them there. */
export function testFiles(root: string): string[] {
  return [...new Bun.Glob("test/**/*.test.{ts,tsx}").scanSync({ cwd: root })].map((file) => file.split("\\").join("/")).sort();
}

/** The repository's own typecheck, as `bun run typecheck` ran it: whether it passed, how long it took, and what it said. */
export interface Typecheck {
  ok: boolean;
  ms: number;
  out: string;
}

/** Runs `root`'s own typecheck (`bun run typecheck`), keeping what it says. */
export async function typecheckOf(root: string): Promise<Typecheck> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, "run", "typecheck"], { cwd: root, env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, ms: performance.now() - started, out: `${out}\n${err}`.trim() };
}

/** Whether Bun's arguments leave tests out (a `-t` pattern, `--only`), which Bun then counts as skipped. */
const filtering = (bun: readonly string[]): boolean => bun.some((a) => a === "-t" || a.startsWith("--test-name-pattern") || a === "--only");

/** Per-file durations as `--record` writes them (`{ version, files }`). */
export function readTimings(path: string): Map<string, number> {
  if (!existsSync(path)) return new Map();
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const files = typeof parsed === "object" && parsed !== null && "files" in parsed ? parsed.files : null;
  if (typeof files !== "object" || files === null) return new Map();
  return new Map(Object.entries(files).flatMap(([file, value]) => (typeof value === "number" ? [[file, value] as const] : [])));
}

/** One test of a file, from Bun's JUnit report of it. */
interface Case {
  /** After the blocks it is in (`block > test`), as Bun names a failing test on the console. */
  name: string;
  state: "passed" | "failed" | "skipped";
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (text: string): string =>
  text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => (code.startsWith("#x") || code.startsWith("#X") ? String.fromCodePoint(parseInt(code.slice(2), 16)) : code.startsWith("#") ? String.fromCodePoint(Number(code.slice(1))) : (ENTITIES[code] ?? whole)));
const attribute = (attributes: string, name: string): string | null => {
  const found = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);
  return found === null ? null : unescape(found[1] ?? "");
};

/**
 * Every test of a file, from the JUnit report `bun test --reporter=junit` writes of it: the report's
 * outermost suite is the file, and each suite inside it a block. (A case's `classname` lists its
 * blocks innermost first, so the names are read from the suites instead.)
 */
export function readReport(xml: string): Case[] {
  const cases: Case[] = [];
  const suites: string[] = [];
  let open: Case | null = null;
  for (const [, closing, tag, attributes = "", selfClosing] of xml.matchAll(/<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g)) {
    if (tag === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attribute(attributes, "name") ?? "");
    } else if (tag === "testcase") {
      if (closing) {
        if (open !== null) cases.push(open);
        open = null;
      } else {
        const name = [...suites.slice(1), attribute(attributes, "name") ?? ""].join(" > ");
        if (selfClosing) cases.push({ name, state: "passed" });
        else open = { name, state: "passed" };
      }
    } else if (open !== null && !closing) open.state = tag === "skipped" ? "skipped" : "failed";
  }
  return cases;
}

interface RunOptions {
  /** What each file's `bun test` is given too. */
  bun: readonly string[];
  limitMs: number;
  env: Record<string, string | undefined>;
  /** The run's own scratch folder, for each file's report and its temporary folder. */
  scratch: string;
  /** This file's run's number in the run, which names its report and its temporary folder. */
  n: number;
}

/** Runs `file` as `bun test <file>` runs it, Bun given `bun` too, and reads Bun's report of it; stopped after `limitMs`, as one that never finished. */
async function runFile(root: string, file: string, o: RunOptions): Promise<FileRun> {
  const started = performance.now();
  const report = join(o.scratch, `${o.n}.xml`);
  const tmp = join(o.scratch, String(o.n));
  mkdirSync(tmp);
  // A file none of whose tests a `-t` pattern names runs no test, which fails nothing.
  const child = Bun.spawn([process.execPath, "test", `--timeout=${TIMEOUT_MS}`, "--pass-with-no-tests", "--reporter=junit", `--reporter-outfile=${report}`, ...o.bun, `./${file}`], { cwd: root, env: { ...o.env, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" });
  const limit = Promise.withResolvers<null>();
  const timer = setTimeout(() => limit.resolve(null), o.limitMs);
  const done = await Promise.race([Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), limit.promise]);
  clearTimeout(timer);
  if (done === null) {
    // Its output isn't waited for: whatever it started may hold that open after it is stopped.
    child.kill("SIGKILL");
    return { file, ok: false, passed: 0, failed: [], error: `it never finished: it was still running after ${o.limitMs / 1000} s, so it was stopped`, ms: performance.now() - started, left: leftIn(tmp), skipped: [] };
  }
  const [out, err, code] = done;
  const text = `${out}\n${err}`;
  // Bun writes no report for a file that broke before its tests: the console says what happened.
  const cases = existsSync(report) ? readReport(readFileSync(report, "utf8")) : null;
  const counted = /^ (\d+) pass$/m.exec(text);
  const failed = cases !== null ? cases.filter((c) => c.state === "failed").map((c) => c.name) : [...text.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1] ?? "");
  const passed = cases !== null ? cases.filter((c) => c.state === "passed").length : Number(counted?.[1] ?? 0);
  const skipped = (cases ?? [])
    .filter((c) => c.state === "skipped")
    .map((c): Skip => {
      const said = /^(.*?) ?\(skipped: (.+)\)$/.exec(c.name);
      return said === null ? { name: c.name, reason: null } : { name: said[1] ?? c.name, reason: said[2] ?? null };
    });
  const between = /# Unhandled error between tests[\s\S]*?^error: (.+)$/m.exec(text)?.[1];
  const ended = failed.length === 0 || counted === null ? `it ended with exit code ${code}${counted === null ? ", before Bun counted its tests" : ""}` : null;
  return { file, ok: code === 0, passed, failed, error: code === 0 ? null : (between ?? ended), ms: performance.now() - started, left: leftIn(tmp), skipped };
}

/** What a file left in its temporary folder, each entry's name, a folder's with a slash after it; then the folder goes. */
function leftIn(folder: string): string[] {
  const left = readdirSync(folder, { withFileTypes: true }).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
  rmSync(folder, { recursive: true, force: true });
  return left;
}

/** The environment each file runs in: this Bun's folder first on the PATH, so a `bun` a test starts is this one. */
function fileEnv(): Record<string, string | undefined> {
  return { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) };
}

/**
 * Runs `files` (all of `root`'s test files when not given), `jobs` at a time, the slowest by
 * `root`'s test/timings-all.json first and the files it doesn't list before them; then each file
 * that failed, again, alone. `bun`: what each file's `bun test` is given too; `limitMs`: how long a
 * file may run (`FILE_LIMIT_MS`). `heard` hears each file's first run as it ends.
 */
export async function runAll(options: { root?: string; jobs: number; files?: readonly string[]; bun?: readonly string[]; limitMs?: number; heard?: (run: FileRun, done: number, of: number) => void }): Promise<AllRun> {
  const root = options.root ?? ROOT;
  const loadBefore = loadavg()[0] ?? 0;
  const timings = readTimings(join(root, TIMINGS));
  const files = [...(options.files ?? testFiles(root))];
  // A file the record doesn't hold yet runs at the record's middle time, until a recording times it.
  const recorded = [...timings.values()].sort((a, b) => a - b);
  const middle = recorded[Math.floor(recorded.length / 2)] ?? 0;
  const untimed = files.filter((file) => !timings.has(file)).sort();
  const queue = files.sort((a, b) => (timings.get(b) ?? middle) - (timings.get(a) ?? middle) || a.localeCompare(b));
  const of = queue.length;
  const scratch = mkdtempSync(join(tmpdir(), "rph-suite-"));
  let n = 0;
  const bun = options.bun ?? [];
  const run = (file: string): Promise<FileRun> => runFile(root, file, { bun, limitMs: options.limitMs ?? FILE_LIMIT_MS, env: fileEnv(), scratch, n: ++n });
  try {
    const started = performance.now();
    const first: FileRun[] = [];
    const worker = async (): Promise<void> => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        const done = await run(file);
        first.push(done);
        options.heard?.(done, first.length, of);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.jobs, of)) }, worker));
    const alone: FileRun[] = [];
    for (const done of first) if (!done.ok) alone.push(await run(done.file));
    return { jobs: options.jobs, cores: availableParallelism(), filtered: filtering(bun), untimed, load: { before: loadBefore, after: loadavg()[0] ?? 0 }, ms: performance.now() - started, first, alone };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What a run came to: the files that failed alone too; the defects, each the run among the others of a file that passed alone; what the files left behind; every skipped test; and its time against the bar, which is reported and no part of the verdict. */
export interface Judged {
  run: AllRun;
  failed: FileRun[];
  beside: FileRun[];
  /** Each thing a file left in its temporary folder, among the others or alone. */
  left: { file: string; name: string }[];
  /** Every skipped test, each with the file it is in; none in a filtered run, where Bun counts the tests left out as skipped. */
  skips: (Skip & { file: string })[];
  /** The repository's typecheck, or null when this run didn't run it (a recording, a filtered run). */
  typecheck: Typecheck | null;
  /** The bar the wall time was set against, or null when this run's time is not (a recording). */
  budgetMs: number | null;
  /** Whether the wall time was over the bar: reported, and no part of `ok`. */
  overBar: boolean;
  ok: boolean;
}

export function judge(run: AllRun, options: { budgetMs?: number | null; typecheck?: Typecheck | null } = {}): Judged {
  const aloneOf = new Map(run.alone.map((r) => [r.file, r]));
  const failed = run.alone.filter((r) => !r.ok);
  const beside = run.first.filter((r) => !r.ok && aloneOf.get(r.file)?.ok === true);
  const left = [...run.first, ...run.alone].flatMap((r) => r.left.map((name) => ({ file: r.file, name })));
  const skips = run.filtered ? [] : run.first.flatMap((r) => (aloneOf.get(r.file) ?? r).skipped.map((s) => ({ ...s, file: r.file })));
  const budgetMs = options.budgetMs ?? null;
  const overBar = budgetMs !== null && run.ms > budgetMs;
  const typecheck = options.typecheck ?? null;
  // The bar is a measure the summary reports, not a test of the code: the verdict is the code's alone.
  const ok = failed.length === 0 && beside.length === 0 && left.length === 0 && skips.every((s) => s.reason !== null) && typecheck?.ok !== false;
  return { run, failed, beside, left, skips, typecheck, budgetMs, overBar, ok };
}

/**
 * What a run of the gate came to, as data, file by file: each file's result (`passed`; `failed`, also
 * when run alone; `beside`, failed only beside the others), its tests passed, its failing tests, its
 * skips with their reasons and what it left behind; then the typecheck, the time against the bar and
 * the verdict.
 */
export function runRecord(judged: Judged, at: Date): Record<string, unknown> {
  const { run } = judged;
  const aloneOf = new Map(run.alone.map((r) => [r.file, r]));
  const beside = new Set(judged.beside.map((r) => r.file));
  return {
    version: 1,
    at: at.toISOString(),
    whole: !run.filtered,
    verdict: judged.ok ? "pass" : "fail",
    ms: Math.round(run.ms),
    jobs: run.jobs,
    cores: run.cores,
    budgetMs: judged.budgetMs,
    overBar: judged.overBar,
    load: run.load,
    untimed: run.untimed,
    typecheck: judged.typecheck === null ? null : { ok: judged.typecheck.ok, ms: Math.round(judged.typecheck.ms) },
    files: run.first.map((r) => {
      const last = aloneOf.get(r.file) ?? r;
      const result = r.ok ? "passed" : beside.has(r.file) ? "beside" : "failed";
      return { file: r.file, result, passed: last.passed, failed: r.ok ? [] : r.failed, skipped: last.skipped, left: [...r.left, ...(aloneOf.get(r.file)?.left ?? [])], ms: Math.round(r.ms) };
    }),
  };
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const duration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  const [min, sec] = [Math.floor(s / 60), s % 60];
  return min === 0 ? `${sec} s` : sec === 0 ? `${min} min` : `${min} min ${sec} s`;
};

/** What a run came to, in short: the lines printed at its end, the verdict last. */
export function summarize(judged: Judged): string[] {
  const { run, failed, beside, budgetMs } = judged;
  const aloneOf = new Map(run.alone.map((r) => [r.file, r]));
  const last = run.first.map((r) => aloneOf.get(r.file) ?? r);
  const bar = budgetMs === null ? "its time is not set against the bar in this run." : `${judged.overBar ? "over" : "within"} the bar of ${duration(budgetMs)} (--budget ${budgetMs / 1000}).`;
  const lines = [
    "",
    `Every test file, each in a process of its own: ${plural(run.first.length, "file")}, ${plural(last.reduce((sum, r) => sum + r.passed, 0), "test")} passed.`,
    `Time: ${duration(run.ms)}, on ${run.jobs} of the machine's ${run.cores} cores (a file on each): ${bar}`,
    `Load: the machine's load average was ${run.load.before.toFixed(1)} when the run began and ${run.load.after.toFixed(1)} when it ended, on ${run.cores} cores, ${Math.max(0, run.cores - run.jobs)} of them left to other work.`,
    judged.typecheck === null ? "Typecheck (bun run typecheck): not run in this run." : `Typecheck (bun run typecheck): ${judged.typecheck.ok ? "passed" : "failed"} in ${(judged.typecheck.ms / 1000).toFixed(1)} s${judged.typecheck.ok ? "." : ":"}`,
    ...(judged.typecheck?.ok === false ? judged.typecheck.out.split("\n").map((line) => `    ${line}`) : []),
  ];
  if (failed.length > 0) {
    lines.push(`Failed, also when run alone (${failed.length}):`);
    for (const r of failed) {
      lines.push(`  ${r.file}`);
      for (const name of r.failed) lines.push(`    ${name}`);
      if (r.error !== null) lines.push(`    ${r.failed.length > 0 ? "and between its tests: " : ""}${r.error}`);
    }
  }
  if (beside.length > 0) {
    lines.push(`Defects: failed beside the other files and passed when run again alone (${beside.length}):`);
    for (const r of beside) {
      lines.push(`  ${r.file}`);
      for (const name of r.failed) lines.push(`    ${name}`);
      if (r.error !== null) lines.push(`    ${r.failed.length > 0 ? "and between its tests: " : ""}${r.error}`);
    }
  }
  if (judged.left.length > 0) {
    lines.push(`Left in the temporary folder, each after the file that left it (${judged.left.length}):`);
    for (const l of judged.left) lines.push(`  ${l.file}: ${l.name}`);
  }
  if (judged.skips.length > 0) {
    lines.push(`Skipped, each with its reason (${judged.skips.length}):`);
    for (const s of judged.skips) lines.push(`  ${s.file}: ${s.name}`, `    why: ${s.reason ?? "none given, a defect"}`);
  }
  if (run.untimed.length > 0) {
    lines.push(`Not yet timed, so each ran at the record's middle time until a recording (--record) times it (${run.untimed.length}):`);
    for (const file of run.untimed) lines.push(`  ${file}`);
  }
  lines.push("The ten slowest files in this run:");
  for (const r of [...run.first].sort((a, b) => b.ms - a.ms).slice(0, 10)) lines.push(`  ${`${(r.ms / 1000).toFixed(1)} s`.padStart(7)}  ${r.file}`);
  const why = [
    failed.length > 0 ? `${plural(failed.length, "file")} failed` : null,
    beside.length > 0 ? `${plural(beside.length, "file")} failed only beside the others` : null,
    judged.left.length > 0 ? `${plural(judged.left.length, "thing")} left in the temporary folder` : null,
    judged.skips.some((s) => s.reason === null) ? `${plural(judged.skips.filter((s) => s.reason === null).length, "skipped test")} with no reason given` : null,
    judged.typecheck?.ok === false ? "the typecheck failed" : null,
  ].filter((w) => w !== null);
  if (judged.overBar && budgetMs !== null) lines.push(`Over the bar: ${duration(run.ms)} against ${duration(budgetMs)}, with the machine's load average at ${run.load.before.toFixed(1)} when the run began. That is a measure to report, not a failure of the code.`);
  lines.push(judged.ok ? "Verdict: pass." : `Verdict: fail: ${why.join("; ")}.`);
  return lines;
}

export interface Args {
  mode: "gate" | "list" | "record";
  jobs: number | null;
  root: string | null;
  /** The bar, in seconds (`BUDGET_S`). */
  budgetS: number;
  bun: string[];
}

/**
 * The command line. Null for anything it doesn't take, and for a recording given Bun's arguments: a
 * filtered file's time isn't the file's.
 */
export function parseArgs(argv: readonly string[]): Args | null {
  const args: Args = { mode: "gate", jobs: null, root: null, budgetS: BUDGET_S, bun: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--") {
      args.bun = argv.slice(i + 1);
      break;
    }
    if (a === "--record" || a === "--list") {
      if (args.mode !== "gate") return null;
      args.mode = a === "--record" ? "record" : "list";
    } else if (a === "--root" || a === "--budget") {
      const value = argv[++i];
      if (value === undefined) return null;
      if (a === "--root") args.root = value;
      else if (/^\d+(\.\d+)?$/.test(value) && Number(value) > 0) args.budgetS = Number(value);
      else return null;
    } else if (a.startsWith("-")) {
      args.bun = argv.slice(i);
      break;
    } else if (/^[1-9]\d*$/.test(a) && args.jobs === null) args.jobs = Number(a);
    else return null;
  }
  if (args.mode === "record" && args.bun.length > 0) return null;
  return args;
}

const USAGE = "usage: bun scripts/test-all.ts [files at once] [--budget <s>] [--root <folder>] [-- <bun test arguments>]   (--list names the files; --record [files at once] records each file's time)";

async function main(argv: readonly string[]): Promise<number> {
  const cores = availableParallelism();
  const args = parseArgs(argv);
  if (args === null) {
    console.error(USAGE);
    return 2;
  }
  const root = resolve(args.root ?? ROOT);
  const files = testFiles(root);
  if (args.mode === "list") {
    for (const file of files) console.log(file);
    return 0;
  }
  const { bun } = args;
  const record = args.mode === "record";
  const asked = args.jobs ?? (record ? Math.floor(cores / 3) : cores - 2);
  const jobs = Math.max(1, Math.min(asked, cores));
  if (asked > cores) console.log(`${asked} at once is more than this machine's ${cores} cores: running ${jobs}, so each file has a core.`);
  console.log(`${files.length} test files, ${jobs} at a time, the slowest first${bun.length > 0 ? `, each given ${bun.join(" ")}` : ""}${record ? `; each one's time goes to ${TIMINGS}` : ""}.`);
  const started = performance.now();
  // The typecheck runs beside the files: a gate's whole run, never a recording or a filtered run.
  const checking = record || filtering(bun) ? null : typecheckOf(root);
  const ran = await runAll({
    root,
    jobs,
    files,
    bun,
    heard: (r, done, of) => {
      if (!r.ok) console.log(`${process.stdout.isTTY ? "\r" : ""}failed among the others, to run again alone at the end: ${r.file}${r.failed.length > 0 ? ` (${plural(r.failed.length, "test")})` : ""}`);
      if (process.stdout.isTTY) process.stdout.write(`\r${done}/${of} files`);
    },
  });
  const typecheck = checking === null ? null : await checking;
  // The gate's wall time is the typecheck's too, should it end after the files.
  const run: AllRun = { ...ran, ms: performance.now() - started };
  if (process.stdout.isTTY) process.stdout.write("\n");
  const judged = judge(run, { budgetMs: record ? null : args.budgetS * 1000, typecheck });
  if (!record) {
    mkdirSync(join(root, dirname(RECORD)), { recursive: true });
    writeFileSync(join(root, RECORD), `${JSON.stringify(runRecord(judged, new Date()), null, 2)}\n`);
  }
  for (const line of summarize(judged)) console.log(line);
  if (record) {
    // A failing run's time says little of a passing one's: a file that passed alone keeps that time, and one that failed there too keeps the record's earlier time where it has one.
    const before = readTimings(join(root, TIMINGS));
    const aloneOf = new Map(run.alone.map((r) => [r.file, r]));
    const timeOf = (r: FileRun): number => {
      if (r.ok) return r.ms;
      const alone = aloneOf.get(r.file);
      return alone?.ok ? alone.ms : (before.get(r.file) ?? r.ms);
    };
    const recorded = Object.fromEntries(run.first.map((r) => [r.file, Math.round(timeOf(r))] as const).sort(([, a], [, b]) => b - a));
    writeFileSync(join(root, TIMINGS), `${JSON.stringify({ version: 1, files: recorded }, null, 2)}\n`);
    console.log(`Each file's time is in ${TIMINGS}.`);
  }
  return judged.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
