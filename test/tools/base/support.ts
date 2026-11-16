// A bench for the base tools: a folder host holding the kit's seed, with RPH's own shipped files as
// its lowest level, the base tools made over it, and each called as an agent calls it. `turnGate`
// is what runs around every call in a turn, so a test sees an answer as the model reads it.
// Everything here is invented.
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRef, ApprovalsPort, JsonValue, ToolCtx } from "../../../src/contract";
import { createFacts, loadGuidance } from "../../../src/files";
import type { Guidance } from "../../../src/files/api";
import { TurnGate } from "../../../src/harness/gate";
import { DEFAULT_SETTINGS } from "../../../src/harness/settings";
import { SHIPPED_GUIDANCE } from "../../../src/harness/shipped";
import { layLead } from "../../lead-file";
import type { FolderHost } from "../../../src/hosts/folder";
import { RunTrace } from "../../../src/loop/trace";
import type { LoopToolResult } from "../../../src/loop/types";
import { KIT_SEED } from "../../../src/testing/kit";
import { baseTools, type BaseToolsDeps } from "../../../src/tools/base";
import type { OwnTool } from "../../../src/tools/kit";
import { layFolderSeed, makeFolderHost } from "../../hosts/folder-kit";

export const SCOPE = KIT_SEED.scope;

/** The lead: it plays no character, so it reads every lore entry. */
export const LEAD: AgentRef = { id: "lead", definition: "lead" };

/** What a test may set over the bench's own deps. */
export type Extra = Partial<BaseToolsDeps>;

export interface Bench {
  host: FolderHost;
  guidance: Guidance;
  /** The base tools over the host, as the environment and `extra` give them. */
  tools(extra?: Extra): OwnTool[];
  /** Calls one base tool by name, as the lead unless `agent` says otherwise. */
  call(name: string, args: JsonValue, options?: { agent?: AgentRef; extra?: Extra; callId?: string }): Promise<LoopToolResult>;
  close(): Promise<void>;
}

/** A bench over a new folder; `files` are more files of the agents' tree, by their path on disk under `files/` (`.skills/x/SKILL.md` is the global level's). */
export async function bench(files: Readonly<Record<string, string>> = {}): Promise<Bench> {
  const place = await mkdtemp(join(tmpdir(), "rph-base-tools-"));
  await layFolderSeed(KIT_SEED, place);
  await cp(SHIPPED_GUIDANCE, join(place, "files", "defaults"), { recursive: true });
  await layLead(join(place, "files", "defaults"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(place, "files", path)), { recursive: true });
    await writeFile(join(place, "files", path), text, "utf8");
  }
  const host = await makeFolderHost(KIT_SEED, place);
  const guidance = loadGuidance(host.files, SCOPE);
  let made = 0;
  const tools = (extra: Extra = {}) => baseTools({ env: host, guidance, texts: new Map(), ids: () => `check-${++made}`, gapHits: DEFAULT_SETTINGS.gapHits, perCall: DEFAULT_SETTINGS.perCall, ...extra });
  return {
    host,
    guidance,
    tools,
    async call(name, args, options = {}) {
      const tool = tools(options.extra).find((t) => t.name === name);
      if (tool === undefined) throw new Error(`No base tool is named ${name} here.`);
      const ctx: ToolCtx = { scope: SCOPE, agent: options.agent ?? LEAD, run: "kit-run", callId: options.callId ?? "call-1", signal: new AbortController().signal, onUpdate: () => {} };
      return tool.run(args, ctx);
    },
    async close() {
      await host.close();
      await rm(place, { recursive: true, force: true });
    },
  };
}

/** An answer's text, its parts one after another. */
export function textOf(result: LoopToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * What runs around every call in a turn (§13.3), over the bench's host, with the shipped words of
 * the tool answers' file: results clipped at `clipChars` (the default setting when absent), and
 * the player's permissions from `approvals` for `tools`.
 */
export async function turnGate(b: Bench, options: { clipChars?: number; approvals?: ApprovalsPort; tools?: readonly OwnTool[] } = {}): Promise<TurnGate> {
  const notices = await b.guidance.part("tool-notices");
  const lines = notices?.format === "lines" ? notices : undefined;
  return new TurnGate({
    scope: SCOPE,
    agent: LEAD,
    trace: new RunTrace(b.host.trace, SCOPE, "kit-run", b.host.clock),
    clock: b.host.clock,
    files: b.host.files,
    log: b.host.log,
    ...(options.approvals !== undefined ? { approvals: options.approvals } : {}),
    places: await b.host.files.places(SCOPE),
    rules: await b.guidance.ruleRun({ facts: createFacts(b.host.facts, () => ({})) }),
    words: (name, fields) => lines?.line(name, fields),
    tools: new Map((options.tools ?? []).map((tool) => [tool.name, { ...tool, from: "rph" as const }])),
    clipChars: options.clipChars ?? DEFAULT_SETTINGS.clipChars,
  });
}
