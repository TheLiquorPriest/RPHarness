// The folder host: the contract kit run against it; what it does beyond the kit's reach (links,
// what is outside the view, dropping an agent's writes, the session's tools, its records); and the
// kit failing hosts wrapped to break the jail.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentRef, Scope, ToolCtx, TraceRecord } from "../../src/contract/index";
import { createFolderHost, type FolderHost } from "../../src/hosts/folder/index";
import { hitsOf } from "../../src/testing/kit/context";
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
    expect(hitsOf(listed).map((h) => h.path)).toEqual(["persistent-workspace/story", "persistent-workspace/story/threads.md"]);
    expect(hitsOf(await host.files.find(scope, { by: "grep", pattern: "oil store" }))).toEqual([]);
  });

  test("another chat, the levels' own chats, the shipped folder and the host's records are outside the view", async () => {
    await mkdir(join(levelDir(place, KIT_SEED, "character"), "other-chat"), { recursive: true });
    await writeFile(join(levelDir(place, KIT_SEED, "character"), "other-chat", "AGENTS.md"), "Another chat's guidance.\n");

    expect(await host.files.read(scope, "@character/AGENTS.md")).toMatchObject({ status: "read", level: "character" });
    expect(await host.files.read(scope, "@character/other-chat/AGENTS.md")).toMatchObject({ status: "refused", reason: "outside" });
    expect(await host.files.read(scope, "@character/other-chat")).toMatchObject({ status: "refused", reason: "outside" });
    const character = await host.files.find(scope, { by: "list", path: "@character/" });
    expect(hitsOf(character).map((h) => h.path)).toEqual(["@character/AGENTS.md"]);
    expect(await host.files.read(scope, `@global/chats/${KIT_SEED.character}/${scope.chat}/AGENTS.md`)).toMatchObject({ status: "refused", reason: "outside" });
    expect(await host.files.read(scope, "@global/defaults/TURN.md")).toMatchObject({ status: "refused", reason: "outside" });
    // "../host" from a mount lands in the chat's own folder, where there is no such thing.
    expect(await host.files.read(scope, "@global/../host/facts.json")).toEqual({ status: "missing", path: "host/facts.json" });
  });

  test("a folder hidden from the view stays hidden under any spelling of its name, for read, list, glob and grep", async () => {
    const notes = join(levelDir(place, KIT_SEED, "character"), "other-chat", "persistent-workspace");
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, "vault.md"), "The vault opens to the word quillfeather.\n");
    // On a file system that ignores case these all name the chats folder; on one that does not, nothing.
    for (const chats of ["chats", "CHATS", "Chats", "chat\u017F"]) {
      const path = `@global/${chats}/${KIT_SEED.character}/other-chat/persistent-workspace/vault.md`;
      const read = await host.files.read(scope, path);
      expect({ path, text: read.status === "read" ? read.text : null }).toEqual({ path, text: null });
      for (const query of [{ by: "list", depth: 5 }, { by: "glob", pattern: "**/*" }, { by: "grep", pattern: "quillfeather" }] as const) {
        const found = await host.files.find(scope, { ...query, path: `@global/${chats}` });
        expect({ chats, by: query.by, found: found.status === "found" ? found.hits.map((h) => h.path) : [] }).toEqual({ chats, by: query.by, found: [] });
      }
    }
    for (const defaults of ["defaults", "DEFAULTS", "default\u017F"]) {
      const read = await host.files.read(scope, `@global/${defaults}/TURN.md`);
      expect({ defaults, text: read.status === "read" ? read.text : null }).toEqual({ defaults, text: null });
    }
    expect(hitsOf(await host.files.find(scope, { by: "grep", pattern: "quillfeather", path: "@global/" }))).toEqual([]);
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
    expect(await names(scope)).toEqual(["kit_tally", "kit_words", "kit_stamp", "kit_shell"]);
    const words = (await host.tools.all(scope)).find((t) => t.name === "kit_words");
    expect(words?.description).toBe("Counts the words of a text.\n");

    await writeFile(join(place, "host", "tools.json"), JSON.stringify({ tools: KIT_MANIFEST.tools.filter((t) => t.name !== "kit_tally") }));
    await host.close();
    host = await makeFolderHost(KIT_SEED, place);
    expect(await names(scope)).toEqual(["kit_tally", "kit_words", "kit_stamp", "kit_shell"]);
    expect(await names({ ...scope, session: "kit-session-2" })).toEqual(["kit_words", "kit_stamp", "kit_shell"]);

    const tally = (await host.tools.all(scope)).find((t) => t.name === "kit_tally");
    const ctx: ToolCtx = { scope, agent: agentA, run: scope.turn, callId: "kit-call-1", signal: new AbortController().signal, onUpdate: () => {} };
    expect(await tally?.run({ numbers: [1, 2, 3.5] }, ctx)).toEqual({ content: [{ type: "text", text: "6.5" }] });

    await host.close();
    const log = await readFile(join(place, "host", "log.jsonl"), "utf8");
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
    expect(await host.models.loadConnections(scope)).toBeNull();
    expect(await host.models.loadSecrets(scope)).toBeNull();
    const connections = { v: 1 as const, default: "kit-conn", connections: [{ id: "kit-conn", name: "Kit", provider: "deepseek", auth: "key" as const, model: "kit-model" }] };
    const secrets = { v: 1 as const, keys: { "kit-conn": "sk-kit-0000000000000000" }, signins: {} };
    await host.models.saveConnections(scope, connections);
    await host.models.saveSecrets(scope, secrets);
    expect(await host.models.loadConnections(scope)).toEqual(connections);
    expect(await host.models.loadSecrets(scope)).toEqual(secrets);
    expect((await stat(join(place, "host", "user", createHash("sha256").update(scope.user).digest("hex"), "secrets", "secrets.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(place, "host", "user", createHash("sha256").update(scope.user).digest("hex"), "secrets"))).mode & 0o777).toBe(0o700);
    const anywhere = await host.files.find(scope, { by: "grep", pattern: "sk-kit", path: "@global/" });
    expect(hitsOf(anywhere)).toEqual([]);
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

describe("the folder host's users", () => {
  /** A user's folder under `host/user/`, as the layout names it: the SHA-256 of his name in hex. */
  const folderOf = (name: string): string => createHash("sha256").update(name).digest("hex");
  const places: string[] = [];
  const hosts: FolderHost[] = [];
  const DOC = { v: 1 as const, default: "kit-conn", connections: [{ id: "kit-conn", name: "Kit", provider: "deepseek", auth: "key" as const, model: "kit-model" }] };

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const dir of places.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function made(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rph-folder-users-"));
    places.push(dir);
    return dir;
  }

  async function hostFor(user: string, dir: string): Promise<FolderHost> {
    const host = await createFolderHost({ dir, user });
    hosts.push(host);
    return host;
  }

  test("two folder hosts in one directory for Alice and alice: neither reads the other's saved key or lists the other's values", async () => {
    const dir = await made();
    const upper = await hostFor("Alice", dir);
    const lower = await hostFor("alice", dir);
    const secrets = { v: 1 as const, keys: { "conn-1": "sk-upper-0000000000000000" }, signins: {} };
    await upper.models.saveSecrets({ user: "Alice" }, secrets);
    await upper.store.set({ user: "Alice" }, "jobs/all/j1", { id: "j1", note: "Alice's" });

    expect(await lower.models.loadSecrets({ user: "alice" })).toBeNull();
    expect(await lower.store.list({ user: "alice" }, "")).toEqual([]);
    expect(await lower.store.get({ user: "alice" }, "jobs/all/j1")).toBeUndefined();
    expect(await upper.models.loadSecrets({ user: "Alice" })).toEqual(secrets);
    await lower.store.set({ user: "alice" }, "jobs/all/j1", { id: "j1", note: "alice's" });
    expect(await upper.store.get({ user: "Alice" }, "jobs/all/j1")).toEqual({ id: "j1", note: "Alice's" });
    // One folder each, whatever the disk's rule on case, each holding the name it is for.
    expect((await readdir(join(dir, "host", "user"))).sort()).toEqual([folderOf("Alice"), folderOf("alice")].sort());
    expect(JSON.parse(await readFile(join(dir, "host", "user", folderOf("Alice"), "user.json"), "utf8"))).toEqual({ user: "Alice" });
    expect(JSON.parse(await readFile(join(dir, "host", "user", folderOf("alice"), "user.json"), "utf8"))).toEqual({ user: "alice" });
    // Each host serves its own user and no other.
    await expect(upper.store.get({ user: "alice" }, "jobs/all/j1")).rejects.toThrow("serves the user");
    await expect(lower.models.loadSecrets({ user: "Alice" })).rejects.toThrow("serves the user");
  });

  test("a folder host for 'first reader', 'reader@example.com', 'Zoë' and a 200-character name serves him at its files, store and models ports alike; an empty name is refused at each", async () => {
    for (const name of ["first reader", "reader@example.com", "Zoë", "z".repeat(200)]) {
      const seed = { ...KIT_SEED, scope: { ...KIT_SEED.scope, user: name } };
      const named = await makeFolderHost(seed, await made());
      hosts.push(named);
      const own = seed.scope;
      expect({ name, files: (await named.files.read(own, "persistent-workspace/story/threads.md")).status }).toEqual({ name, files: "read" });
      await named.store.set({ user: name }, "jobs/all/j1", { id: "j1" });
      expect({ name, keys: await named.store.list({ user: name }, "jobs/") }).toEqual({ name, keys: ["jobs/all/j1"] });
      await named.models.saveConnections({ user: name }, DOC);
      expect({ name, doc: await named.models.loadConnections({ user: name }) }).toEqual({ name, doc: DOC });
    }

    const nobody = { ...KIT_SEED, scope: { ...KIT_SEED.scope, user: "" } };
    const none = await makeFolderHost(nobody, await made());
    hosts.push(none);
    await expect(none.files.read(nobody.scope, "persistent-workspace/story/threads.md")).rejects.toThrow("empty name");
    await expect(none.store.get({ user: "" }, "jobs/all/j1")).rejects.toThrow("empty name");
    await expect(none.store.list({ user: "" }, "")).rejects.toThrow("empty name");
    await expect(none.models.loadConnections({ user: "" })).rejects.toThrow("empty name");
    await expect(none.models.saveSecrets({ user: "" }, { v: 1, keys: {}, signins: {} })).rejects.toThrow("empty name");
  });

  test("two folder hosts in one directory keep each user's connections document in his own folder", async () => {
    const dir = await made();
    const first = await hostFor("first-reader", dir);
    const second = await hostFor("second-reader", dir);
    const other = { ...DOC, connections: [{ ...DOC.connections[0]!, id: "other-conn", name: "Other" }], default: "other-conn" };
    await first.models.saveConnections({ user: "first-reader" }, DOC);
    await second.models.saveConnections({ user: "second-reader" }, other);

    expect(JSON.parse(await readFile(join(dir, "host", "user", folderOf("first-reader"), "models", "connections.json"), "utf8"))).toEqual(DOC);
    expect(JSON.parse(await readFile(join(dir, "host", "user", folderOf("second-reader"), "models", "connections.json"), "utf8"))).toEqual(other);
    expect(await second.models.loadConnections({ user: "second-reader" })).toEqual(other);
    await expect(second.models.loadConnections({ user: "first-reader" })).rejects.toThrow("serves the user");
  });

  test("a folder that holds another user's name is refused, and a folder made under the name itself is not read", async () => {
    const dir = await made();
    await mkdir(join(dir, "host", "user", folderOf("reader")), { recursive: true });
    await writeFile(join(dir, "host", "user", folderOf("reader"), "user.json"), JSON.stringify({ user: "someone-else" }));
    await mkdir(join(dir, "host", "user", "tower-keeper", "store", "jobs", "all"), { recursive: true });
    await writeFile(join(dir, "host", "user", "tower-keeper", "store", "jobs", "all", "old.json"), JSON.stringify({ id: "old" }));

    const refused = await hostFor("reader", dir);
    await expect(refused.store.get({ user: "reader" }, "jobs/all/j1")).rejects.toThrow('is kept for the user "someone-else", not for "reader"');

    const keeper = await hostFor("tower-keeper", dir);
    expect(await keeper.store.list({ user: "tower-keeper" }, "")).toEqual([]);
  });
});

describe("the kit fails a host that breaks the jail, or shows one user another's data", () => {
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

  test("another user's scope given the first user's chat, lore, files and prompt", async () => {
    const { code, output } = await runKit("./test/hosts/leaky-users.kit.ts");
    expect(code).not.toBe(0);
    for (const area of ["files", "chat", "lore", "prompt"]) expect(output).toMatch(new RegExp(`\\(fail\\) .*> ${area} > another user's scope reads none of this user's`));
    // Its four areas' cases, and the files' read that names no chat, which sees another user's global files.
    expect(output).toMatch(/\b5 fail\b/);
  }, 30_000);

  test("a find that stops without saying so, at its limit, at a large file, at a long line or at a cap of its own", async () => {
    const { code, output } = await runKit("./test/hosts/leaky-silent.kit.ts");
    expect(code).not.toBe(0);
    expect(output).toMatch(/\(fail\) .*a find stopped by its limit, by a file's size or by a line's length says so/);
    expect(output).toMatch(/\(fail\) .*a find with no cap over more files than the host's own cap gives every hit or says it stopped/);
    expect(output).toMatch(/\b2 fail\b/);
  }, 30_000);
});
