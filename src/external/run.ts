// The command runner every command-running thing shares (§5.4, §16; PlanHarnessCore-2 item 1): a
// hook, a rule's command, a command tool, an MCP server started by a command. It runs a command as
// the server's user, outside RPH's process, with JSON on stdin, and reads JSON (or text) from its
// stdout, no more than it is given to read; past its timeout it is killed. It runs nothing the
// host's switches do not have on for the user, asked by its kind, its name and exactly the command
// line written in his file, so a changed line waits again. The line is never built from an agent's
// arguments or any chat or lore text: it comes whole from the file. The environment it runs in is
// the few names a shell needs to find its programs, so no key the process holds reaches it.

import type { JsonValue, SwitchableKind, SwitchesPort, SwitchState } from "../contract";

/** What a command run is asked. */
export interface CommandRun {
  /** The command line, exactly as written in his file. */
  command: string;
  /** The thing as the switches know it: its kind and its name; its target is `command`. */
  kind: SwitchableKind;
  name: string;
  /** The user whose file names it, and whose switches must have it on. */
  user: string;
  /** Sent on stdin as JSON; nothing is sent where it is absent. */
  input?: JsonValue;
  /** Milliseconds it may run; then it is killed. */
  timeoutMs: number;
  /** The most bytes read of its stdout; past them it is cut and killed. */
  readMost: number;
  /** The folder it runs in; the process's own where absent. */
  cwd?: string;
}

/**
 * How a run went. `off`/`waiting`: not run, as the switches say. `failed`: it could not be started.
 * `ran`: its exit code, its stdout as JSON where it parses (`output`) and as text, whether it was cut
 * at the read limit, its stderr's end, and how long it took; `timedOut`: killed at its timeout.
 */
export type CommandResult =
  | { status: Exclude<SwitchState, "on"> }
  | { status: "failed"; why: string }
  | { status: "ran"; exit: number | null; output?: JsonValue; text: string; cut: boolean; timedOut: boolean; stderr: string; ms: number };

/** The characters of a command's stderr kept: its end, where the reason a command failed is usually written. */
const STDERR_KEPT = 2_000;

/** The names of the environment a command runs with: enough for a shell to find programs and a home, and no value of the server's own. */
const PASSED = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TZ"] as const;

function environment(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSED) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Reads a stream to its end or to `most` bytes, whichever comes first: the bytes, and whether it stopped at the limit. */
async function readUpTo(stream: ReadableStream<Uint8Array>, most: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(chunks), cut: false };
    if (size + value.byteLength > most) {
      chunks.push(value.subarray(0, most - size));
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks), cut: true };
    }
    chunks.push(value);
    size += value.byteLength;
  }
}

/** Runs a command, as `CommandRun` says, once the switches have it on for the user. */
export async function runCommand(run: CommandRun, switches: SwitchesPort | undefined): Promise<CommandResult> {
  // Without the host's registry, everything that runs a command is off.
  const state: SwitchState = switches === undefined ? "off" : await switches.state(run.user, { kind: run.kind, name: run.name, target: run.command });
  if (state !== "on") return { status: state };
  const started = performance.now();
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["/bin/sh", "-c", run.command], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: environment(), ...(run.cwd !== undefined ? { cwd: run.cwd } : {}) });
  } catch (error) {
    return { status: "failed", why: error instanceof Error ? error.message : String(error) };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, run.timeoutMs);
  try {
    if (run.input !== undefined) proc.stdin.write(JSON.stringify(run.input));
    await proc.stdin.end();
  } catch {
    // A command that reads nothing may close its stdin first; what it answers still counts.
  }
  const [out, err] = await Promise.all([readUpTo(proc.stdout, run.readMost), new Response(proc.stderr).text().catch(() => "")]);
  if (out.cut) proc.kill("SIGKILL");
  const exit = await proc.exited;
  clearTimeout(timer);
  const text = new TextDecoder().decode(out.bytes);
  let output: JsonValue | undefined;
  try {
    output = text.trim() === "" ? undefined : (JSON.parse(text) as JsonValue);
  } catch {
    output = undefined;
  }
  return { status: "ran", exit: timedOut || out.cut ? null : exit, ...(output !== undefined ? { output } : {}), text, cut: out.cut, timedOut, stderr: err.slice(-STDERR_KEPT), ms: Math.round(performance.now() - started) };
}
