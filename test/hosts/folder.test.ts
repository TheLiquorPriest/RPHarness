// The folder host: the contract kit run against it; what it does beyond the kit's reach (links,
// what is outside the view, dropping an agent's writes, the session's tools, its records); and the
// kit failing hosts wrapped to break the jail.

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentRef, Scope, ToolCtx, TraceRecord } from "../../src/contract/index";
import type { FolderHost } from "../../src/hosts/folder/index";
import { KIT_SEED, runContractKit } from "../../src/testing/kit/index";
import { folderKitFactory, KIT_MANIFEST, levelDir, makeFolderHost } from "./folder-kit";

runContractKit("folder host", folderKitFactory);

const scope = KIT_SEED.scope;
const agentA: AgentRef = { id: "kit-a", definition: "character", parent: "kit-lead" };
const agentB: AgentRef = { id: "kit-b", definition: "gm", parent: "kit-lead" };

describe("folder host", () => {
  let place: string;
  let host: FolderHost;
  const chatDir = () => levelDir(place, KIT_SEED, "chat");

  beforeEach(async () => {
    place = await mkdtemp(join(tmpdir(), "rph-folder-"));
    host = await makeFolderHost(KIT_SEED, place);
  });

  afterEach(async () => {
    await host.close();
    await rm(place, { recursive: true, force: true });
  });

  test("links are not followed: through one, nothing is read, listed, found or written", async () => {
    await mkdir(join(place, "elsewhere"));
    await writeFile(join(place, "elsewhere", "secret.md"), "The keeper hid the key in the oil store.\n");
    await symlink(join(place, "elsewhere"), join(chatDir(), "persistent-workspace", "linked"));
    await symlink(join(place, "elsewhere", "secret.md"), join(chatDir(), "persistent-workspace", "linked.md"));

    expect(await host.files.read(scope, "persistent-workspace/linked.md")).toMatchObject({ status: "refused", reason: "link" });
    expect(await host.files.read(scope, "persistent-workspace/linked/secret.md")).toMatchObject({ status: "refused", reason: "link" });
    expect(await host.files.write(scope, "persistent-workspace/linked/planted.md", { op: "write", text: "x" }, agentA)).toMatchObject({ status: "refused", reason: "link" });
    expect(await host.files.write(scope, "persistent-workspace/linked.md", { op: "write", text: "x" }, agentA)).toMatchObject({ status: "refused", reason: "link" });
    expect(await readFile(join(place, "elsewhere", "secret.md"), "utf8")).toBe("The keeper hid the key in the oil store.\n");
    expect(await stat(join(place, "elsewhere", "planted.md")).catch(() => null)).toBeNull();

    const listed = await host.files.find(scope, { by: "list", path: "persistent-workspace", depth: 5 });
    expect(Array.isArray(listed) ? listed.map((h) => h.path) : listed).toEqual(["persistent-workspace/story", "persistent-workspace/story/threads.md"]);
    expect(await host.files.find(scope, { by: "grep", pattern: "oil store" })).toEqual([]);
  });

  test("another chat, the levels' own chats, the shipped folder and the host's records are outside the view", async () => {
    await mkdir(join(levelDir(place, KIT_SEED, "character"), "other-chat"), { recursive: true });
    await writeFile(join(levelDir(place, KIT_SEED, "character"), "other-chat", "AGENTS.md"), "Another chat's guidance.\n");

    expect(await host.files.read(scope, "@character/AGENTS.md")).toMatchObject({ status: "read", level: "character" });
    expect(await host.files.read(scope, "@character/other-chat/AGENTS.md")).toMatchObject({ status: "refused", reason: "outside" });
    expect(await host.files.read(scope, "@character/other-chat")).toMatchObject({ status: "refused", reason: "outside" });
    const character = await host.files.find(scope, { by: "list", path: "@character/" });
    expect(Array.isArray(character) ? character.map((h) => h.path) : character).toEqual(["@character/AGENTS.md"]);
    expect(await host.files.read(scope, `@global/chats/${KIT_SEED.character}/${scope.chat}/AGENTS.md`)).toMatchObject({ status: "refused", reason: "outside" });
    expect(await host.files.read(scope, "@global/defaults/TURN.md")).toMatchObject({ status: "refused", reason: "outside" });
    // "../host" from a mount lands in the chat's own folder, where there is no such thing.
    expect(await host.files.read(scope, "@global/../host/facts.json")).toEqual({ status: "missing", path: "host/facts.json" });
  });

  test("dropping an agent's writes puts back what it wrote this turn, and keeps a file someone changed after it", async () => {
    const threads = "persistent-workspace/story/threads.md";
    const seeded = await readFile(join(chatDir(), threads), "utf8");
    await host.files.write(scope, "persistent-workspace/a.md", { op: "write", text: "A was here.\n" }, agentA);
    await host.files.write(scope, threads, { op: "append", text: "The bell rang tonight.\n" }, agentA);
    await host.files.write(scope, threads, { op: "edit", old: "tonight", new: "at midnight" }, agentA);
    await host.files.write(scope, "persistent-workspace/c.md", { op: "write", text: "A's draft.\n" }, agentA);
    await host.files.write(scope, "persistent-workspace/b.md", { op: "write", text: "B's own.\n" }, agentB);
    await host.files.write(scope, "persistent-workspace/c.md", { op: "append", text: "B added this.\n" }, agentB);

    await host.events.dropStaged(scope, agentA);

    expect(await host.files.read(scope, "persistent-workspace/a.md")).toMatchObject({ status: "missing" });
    expect(await host.files.read(scope, threads)).toMatchObject({ text: seeded });
    expect(await host.files.read(scope, "persistent-workspace/c.md")).toMatchObject({ text: "A's draft.\nB added this.\n" });
    expect(await host.files.read(scope, "persistent-workspace/b.md")).toMatchObject({ text: "B's own.\n" });
    const events = (await readFile(join(place, "host", "chats", scope.chat, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ kind: "dropStaged", agent: agentA, restored: ["persistent-workspace/a.md", threads], kept: ["persistent-workspace/c.md"] });

    // Dropping again finds nothing more to put back.
    await host.events.dropStaged(scope, agentA);
    expect(await host.files.read(scope, threads)).toMatchObject({ text: seeded });
  });

  test("the tools listed when a session begins hold for it, across a new host; a new session sees the manifest as it is", async () => {
    const names = async (s: Scope) => (await host.tools.all(s)).map((t) => t.name);
    expect(await names(scope)).toEqual(["kit_tally", "kit_words", "kit_stamp"]);
    const words = (await host.tools.all(scope)).find((t) => t.name === "kit_words");
    expect(words?.description).toBe("Counts the words of a text.\n");

    await writeFile(join(place, "host", "tools.json"), JSON.stringify({ tools: KIT_MANIFEST.tools.filter((t) => t.name !== "kit_tally") }));
    await host.close();
    host = await makeFolderHost(KIT_SEED, place);
    expect(await names(scope)).toEqual(["kit_tally", "kit_words", "kit_stamp"]);
    expect(await names({ ...scope, session: "kit-session-2" })).toEqual(["kit_words", "kit_stamp"]);

    const tally = (await host.tools.all(scope)).find((t) => t.name === "kit_tally");
    const ctx: ToolCtx = { scope, agent: agentA, run: scope.turn, callId: "kit-call-1", signal: new AbortController().signal, onUpdate: () => {} };
    expect(await tally?.run({ numbers: [1, 2, 3.5] }, ctx)).toEqual({ content: [{ type: "text", text: "6.5" }] });

    await host.close();
    const log = await readFile(join(place, "host", "log.jsonl"), "utf8");
    expect(log).toContain("kit_shell");
    expect(log).toContain("kit_unrun");
  });

  test("the trace keeps every event in order in the chat's trace file; one it cannot keep is logged, not thrown", async () => {
    const lead: AgentRef = { id: "kit-lead", definition: "author" };
    const records: TraceRecord[] = [
      { seq: 1, run: scope.turn, scope, at: 1, agent: lead, event: { kind: "run_started", run: "turn", turn: "new", lead: "author" } },
      { seq: 2, run: scope.turn, scope, at: 2, agent: lead, event: { kind: "intent", text: "Wants: a quiet answer." } },
      { seq: 3, run: scope.turn, scope, at: 3, agent: lead, event: { kind: "run_ended", outcome: { status: "released", released: true, usage: { calls: 1, input: 10, cacheRead: 0, cacheWrite: 0, output: 5 } } } },
    ];
    for (const r of records) host.trace.event(r);
    expect(() => host.trace.event({ ...records[0], scope: { ...scope, user: "someone-else" } } as TraceRecord)).not.toThrow();
    await host.trace.flush();
    const kept = (await readFile(join(place, "host", "chats", scope.chat, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(kept).toEqual(records);
    await host.close();
    expect(await readFile(join(place, "host", "log.jsonl"), "utf8")).toContain("dropped");
  });

  test("the model layer's documents come back as saved, the secrets readable by their owner alone and outside the tree", async () => {
    expect(await host.models.loadConnections()).toBeNull();
    expect(await host.models.loadSecrets()).toBeNull();
    const connections = { v: 1 as const, default: "kit-conn", connections: [{ id: "kit-conn", name: "Kit", provider: "deepseek", auth: "key" as const, model: "kit-model" }] };
    const secrets = { v: 1 as const, keys: { "kit-conn": "sk-kit-0000000000000000" }, signins: {} };
    await host.models.saveConnections(connections);
    await host.models.saveSecrets(secrets);
    expect(await host.models.loadConnections()).toEqual(connections);
    expect(await host.models.loadSecrets()).toEqual(secrets);
    expect((await stat(join(place, "host", "secrets", "secrets.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(place, "host", "secrets"))).mode & 0o777).toBe(0o700);
    const anywhere = await host.files.find(scope, { by: "grep", pattern: "sk-kit", path: "@global/" });
    expect(anywhere).toEqual([]);
  });

  test("lore is read as its reader may know it: a character reads what anyone may know, what it is named for, and what is behind a gate that holds", async () => {
    const entry = (id: string, title: string, gate: string, open: boolean) =>
      JSON.stringify({ id, source: "Kit World", title, keys: [], text: `${title}, of the lighthouse.`, knowing: { by: "gate", gate, open } });
    await writeFile(join(place, "host", "lore", "w-8.json"), entry("w-8", "The Sealed Vault", "the key is found", false));
    await writeFile(join(place, "host", "lore", "w-9.json"), entry("w-9", "The Open Stair", "the door is opened", true));
    const lead: AgentRef = { id: "kit-lead", definition: "author" };
    const wren: AgentRef = { id: "kit-wren", definition: "character", parent: "kit-lead", plays: "Wren Alder" };
    const tamsin: AgentRef = { id: "kit-tamsin", definition: "character", parent: "kit-lead", plays: "Tamsin" };
    const ids = ["e-101", "w-7", "w-8", "w-9"];
    const read = async (reader: AgentRef) => (await host.lore.read(scope, ids, reader)).map((e) => e.id);
    const found = async (text: string, reader: AgentRef) => (await host.lore.search(scope, { text }, reader)).map((h) => h.id);

    expect(await read(lead)).toEqual(ids);
    expect(await read(wren)).toEqual(["e-101", "w-7", "w-9"]);
    expect(await read(tamsin)).toEqual(["e-101", "w-9"]);
    expect(await found("bronze", wren)).toEqual(["w-7"]);
    expect(await found("bronze", tamsin)).toEqual([]);
    expect(await found("vault", lead)).toEqual(["w-8"]);
    expect(await found("vault", wren)).toEqual([]);
  });

  test("a prompt given for a turn is what its layout and its activated lore come from; where slices were found is kept", async () => {
    const turn = { ...scope, turn: "kit-turn-9" };
    await expect(host.prompt.layout(turn)).rejects.toThrow("no prompt");
    await host.givePrompt(turn, {
      messages: [
        { role: "system", content: [{ type: "text", text: "Keep it short." }, { type: "image", data: "aGk=", mimeType: "image/png" }] },
        { role: "user", content: "Row out.", kind: "history", source: { id: "kit-m4", index: 4 } },
      ],
      activated: [{ id: "w-7", source: "Kit World", title: "The Drowned Bell" }],
    });
    const layout = await host.prompt.layout(turn);
    expect(layout.messages.map((m) => [m.length, m.images, m.parts[0]?.kind])).toEqual([
      [14, 1, "other"],
      [8, undefined, "history"],
    ]);
    expect(layout).toMatchObject({ blocks: [], blocksFrom: null, preset: KIT_SEED.preset, complete: true });
    expect(await host.lore.activated(turn)).toEqual([{ id: "w-7", source: "Kit World", title: "The Drowned Bell" }]);
    await expect(host.givePrompt(turn, { messages: [{ role: "narrator" as "system", content: "x" }] })).rejects.toThrow('"role"');

    const located = { preset: KIT_SEED.preset, slices: [], unclaimed: [{ message: 0, start: 0, end: 14 }], notices: [{ kind: "unmapped" as const }], front: { length: 0 } };
    await host.prompt.saveLocated(turn, located);
    expect(JSON.parse(await readFile(join(place, "host", "chats", scope.chat, "turns", "kit-turn-9", "located.json"), "utf8"))).toEqual(located);
  });

  test("a fact declared with no value counts 0; a scope of another user, or with an id that reaches out, is refused", async () => {
    expect(await host.facts.read(scope)).toEqual({
      "stage.unperceived": { count: 2, names: ["Wren Alder", "Tamsin"], by: { principal: 1, supporting: 1 }, namesBy: { principal: ["Wren Alder"], supporting: ["Tamsin"] } },
      "threads.open": { count: 0 },
      "history.leaving.uncovered": { count: 3, fields: { range: { from: 12, to: 15 } } },
    });
    await expect(host.files.read({ ...scope, user: "someone-else" }, "AGENTS.md")).rejects.toThrow("serves the user");
    await expect(host.files.read({ ...scope, chat: "../kit-chat" }, "AGENTS.md")).rejects.toThrow("cannot keep a chat");
    await expect(host.files.read({ ...scope, turn: "../../x" }, "AGENTS.md")).rejects.toThrow("cannot keep a turn");
  });
});

describe("the kit fails a host that breaks the jail", () => {
  const root = join(import.meta.dir, "..", "..");

  async function runKit(file: string): Promise<{ code: number; output: string }> {
    const child = Bun.spawn([process.execPath, "test", file], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: out + err };
  }

  test("a write to a user's file let through", async () => {
    const { code, output } = await runKit("./test/hosts/leaky-yours.kit.ts");
    expect(code).not.toBe(0);
    expect(output).toMatch(/\(fail\) .*a write outside where agents may write is refused, and changes nothing/);
    expect(output).toMatch(/\b1 fail\b/);
  }, 30_000);

  test("a path climbing out of the view written, though answered as refused", async () => {
    const { code, output } = await runKit("./test/hosts/leaky-escape.kit.ts");
    expect(code).not.toBe(0);
    expect(output).toMatch(/\(fail\) .*a path that leaves the view is refused, for reads, finds and writes, and nothing lands outside/);
    expect(output).toMatch(/\b1 fail\b/);
  }, 30_000);
});
