// The folder host's ways with the disk: files written whole so a reader never meets half of one,
// one change at a time per key, appends kept in order, and the hashes the contract names.

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** SHA-256 of a text's UTF-8, or of raw bytes, lower-case hex: a file's hash (`FileText.hash`). */
export function sha256(data: string | Uint8Array): string {
  return typeof data === "string" ? createHash("sha256").update(data, "utf8").digest("hex") : createHash("sha256").update(data).digest("hex");
}

/** A text's hash in a prompt's layout (`TextHash`): the first 32 hex digits of its SHA-256. */
export function textHash(text: string): string {
  return sha256(text).slice(0, 32);
}

/** The error code a failed file call threw with, if it has one. */
export function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** A file's text; undefined when there is no file. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** A JSON file's value; undefined when there is no file. A file that is not JSON rejects with words that name it. */
export async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Writes a file whole: to a new file beside it, flushed to the disk, then moved over the old one,
 * so a reader meets the old file or the new one and never half of either. `mode` is the new file's
 * (0o600 for a secret).
 */
export async function writeWhole(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", mode);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Writes a value as JSON, whole. */
export async function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
  await writeWhole(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Runs changes one at a time per key, each after the last one settles, whatever it came to. */
export class Serial {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, change: () => Promise<T>): Promise<T> {
    const before = this.#tails.get(key) ?? Promise.resolve();
    const next = before.then(change, change);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return next;
  }

  /** Resolves once every change given so far has settled. */
  async idle(): Promise<void> {
    while (this.#tails.size > 0) await Promise.all([...this.#tails.values()]);
  }
}

/**
 * Lines appended to files, each file's in the order given, without the caller waiting. A line
 * that cannot be written is reported to `failed`, and the lines after it still go.
 */
export class Appender {
  readonly #serial = new Serial();
  readonly #failed: (path: string, error: unknown) => void;

  constructor(failed: (path: string, error: unknown) => void) {
    this.#failed = failed;
  }

  line(path: string, value: unknown): void {
    const text = `${JSON.stringify(value)}\n`;
    void this.#serial.run(path, async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, text, "utf8");
      } catch (error) {
        this.#failed(path, error);
      }
    });
  }

  /** Resolves once every line given so far is written. */
  flush(): Promise<void> {
    return this.#serial.idle();
  }
}

/** The lines of a JSON-lines file, each parsed; none when there is no file. A line that is not JSON rejects with words that name the file and the line. */
export async function readLines(path: string): Promise<unknown[]> {
  const text = await readText(path);
  if (text === undefined) return [];
  const values: unknown[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`${path} line ${i + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return values;
}

/**
 * An id the host puts in a path (a chat's, a session's, a turn's): letters, digits, `.`, `_` and
 * `-`, not starting with a dot, at most 128 long. Anything else is refused with words that say so,
 * since it could reach outside the folder.
 */
export function safeId(what: string, id: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`The folder host cannot keep a ${what} with the id ${JSON.stringify(id)}: an id here is letters, digits, ".", "_" and "-", not starting with ".", at most 128 long.`);
  return id;
}
