// A file tree made in each test, on the folder host: the four levels, a chat's config, and the host's
// facts. The drafted guidance is copied in `fixtures/drafted/`, laid out as the shipped level (its
// `chat-defaults/` files at the level's root, where a definition's `reads` finds them). Everything
// else here is invented.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRef, FactDef, FactValue, LayerLevel, Scope } from "../../src/contract/index";
import type { FolderHost } from "../../src/hosts/folder/index";
import { createFolderHost } from "../../src/hosts/folder/index";

export const USER = "reader";
export const CHARACTER = "wren-hale";
export const scope: Scope = { user: USER, chat: "lighthouse", session: "s1", turn: "t1" };

export const author: AgentRef = { id: "lead-1", definition: "author" };
export const gm: AgentRef = { id: "gm-1", definition: "gm", parent: "lead-1" };

export type Files = Partial<Record<LayerLevel, Record<string, string>>>;

/** A level's folder on the folder host's disk. */
function levelDir(dir: string, level: LayerLevel): string {
  const files = join(dir, "files");
  if (level === "shipped") return join(files, "defaults");
  if (level === "global") return files;
  if (level === "character") return join(files, "chats", CHARACTER);
  return join(files, "chats", CHARACTER, scope.chat);
}

export interface Bench {
  host: FolderHost;
  put(level: LayerLevel, path: string, text: string): Promise<void>;
  drop(level: LayerLevel, path: string): Promise<void>;
  /** The host's facts' values for the chat, from now on. */
  facts(values: Record<string, FactValue>): Promise<void>;
  close(): Promise<void>;
}

/** A folder host over a tree of these files, declaring these facts. */
export async function bench(files: Files = {}, defs: FactDef[] = []): Promise<Bench> {
  const dir = await mkdtemp(join(tmpdir(), "rph-files-"));
  const put = async (level: LayerLevel, path: string, text: string) => {
    const at = join(levelDir(dir, level), path);
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, text, "utf8");
  };
  await mkdir(levelDir(dir, "chat"), { recursive: true });
  for (const [level, map] of Object.entries(files) as [LayerLevel, Record<string, string>][]) {
    for (const [path, text] of Object.entries(map)) await put(level, path, text);
  }
  const records = join(dir, "host", "chats", scope.chat);
  await mkdir(records, { recursive: true });
  await writeFile(join(records, "chat.json"), JSON.stringify({ character: CHARACTER }));
  const facts = (values: Record<string, FactValue>) => writeFile(join(dir, "host", "facts.json"), JSON.stringify({ defs, values: { [scope.chat]: values } }));
  await facts({});
  const host = await createFolderHost({ dir, user: USER });
  return {
    host,
    put,
    drop: (level, path) => rm(join(levelDir(dir, level), path), { force: true }),
    facts,
    close: async () => {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const DRAFTED = join(import.meta.dir, "fixtures", "drafted");

/** The drafted guidance as the shipped level holds it: path → text. */
export async function drafted(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const path of new Bun.Glob("**/*.md").scan({ cwd: DRAFTED, dot: true })) {
    out[path.replace(/^chat-defaults\//, "")] = await readFile(join(DRAFTED, path), "utf8");
  }
  return out;
}

/** One drafted file's text, by its path in `fixtures/drafted/`. */
export function draftedFile(path: string): Promise<string> {
  return readFile(join(DRAFTED, path), "utf8");
}

/** The table of files added for a turn, as RPE ships it (§5.2 part 7). */
export const ADDED = "stack:\n  added:\n    swipe: [SWIPE]\n    regenerate: [SWIPE]\n    delete: [DELETE]\n";

/** The facts the plan names (§5.4), as an invented host declares them. */
export const PLAN_FACTS: FactDef[] = [
  { name: "stage.unperceived", counts: "Who was on stage this turn with no perception recorded for it.", by: ["principal", "supporting", "extra"] },
  { name: "path.unperceived", counts: "The same, for earlier turns on the path.", by: ["principal", "supporting", "extra"] },
  { name: "turns.since.engine.change", counts: "Turns since anything was recorded in the engine lane." },
  { name: "history.leaving.uncovered", counts: "Messages about to leave the prompt that the record does not cover." },
];
