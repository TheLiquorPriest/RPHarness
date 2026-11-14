// The kit's cases for the file port (§5, §5.1): layers in load order, exact reads, finding, the
// three kinds, writes where agents may write, and refusal of everything else, which changes nothing.

import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import type { AgentRef, FileOp, LayerLevel } from "../../contract/index";
import type { KitContext } from "./context";
import { hitsOf, landed, mountOf, sha256, viewPicture } from "./context";

const ORDER: LayerLevel[] = ["shipped", "global", "character", "chat"];

/** The agent the kit writes as: a sub-agent of the turn's lead. */
export const KIT_AGENT: AgentRef = { id: "kit-agent-1", definition: "kit-scribe", parent: "kit-lead" };

export function fileCases(ctx: KitContext<"files">): void {
  test("the levels come farthest first, the chat's at the agents' root, each reading its own files", async () => {
    const layers = await ctx.env.files.layers(ctx.scope);
    const levels = layers.map((l) => l.level);
    expect(levels).toEqual(ORDER);
    expect(layers.find((l) => l.level === "chat")?.mount).toBe("");
    // The mounts are the same in every host, so guidance can name them.
    expect(layers.filter((l) => l.level !== "chat").map((l) => l.mount)).toEqual(["@shipped/", "@global/", "@character/"]);
    for (const layer of layers) {
      for (const folder of Object.values(layer.folders)) expect(folder.startsWith("/") || folder.split("/").includes("..")).toBe(false);
    }
    for (const f of ctx.seed.files) {
      const read = await ctx.env.files.read(ctx.scope, mountOf(layers, f.level) + f.path);
      expect(read.status).toBe("read");
      if (read.status !== "read") continue;
      expect(read.text).toBe(f.text);
      expect(read.level).toBe(f.level);
    }
  });

  test("a read gives exactly the lines asked for, with the whole file's size, hash and lines", async () => {
    const world = ctx.seed.files.find((f) => f.level === "chat" && f.path === "WORLD.md");
    if (world === undefined) throw new Error("The seed has no WORLD.md.");
    const lines = world.text.split("\n").slice(0, -1).map((l) => `${l}\n`);
    const whole = await ctx.env.files.read(ctx.scope, "WORLD.md");
    expect(whole).toMatchObject({ status: "read", path: "WORLD.md", text: world.text, start: 1, end: lines.length, lines: lines.length, bytes: Buffer.byteLength(world.text), hash: sha256(world.text), kind: "yours", level: "chat" });

    const middle = await ctx.env.files.read(ctx.scope, "WORLD.md", { start: 2, end: 3 });
    expect(middle).toMatchObject({ status: "read", text: lines.slice(1, 3).join(""), start: 2, end: 3, lines: lines.length, hash: sha256(world.text) });

    const tail = await ctx.env.files.read(ctx.scope, "/WORLD.md", { start: 4 });
    expect(tail).toMatchObject({ status: "read", path: "WORLD.md", text: lines.slice(3).join(""), start: 4, end: lines.length });

    const past = await ctx.env.files.read(ctx.scope, "WORLD.md", { start: lines.length + 4 });
    expect(past).toMatchObject({ status: "read", text: "", start: lines.length + 4, end: lines.length + 3 });

    expect(await ctx.env.files.read(ctx.scope, "NOT-THERE.md")).toEqual({ status: "missing", path: "NOT-THERE.md" });
    expect(await ctx.env.files.read(ctx.scope, "persistent-workspace")).toMatchObject({ status: "missing", folder: true });
  });

  test("find lists a folder, matches paths by glob and lines by pattern, in the order of their paths", async () => {
    const layers = await ctx.env.files.layers(ctx.scope);
    const root = hitsOf(await ctx.env.files.find(ctx.scope, { by: "list" }));
    const names = root.map((h) => `${h.type}:${h.path}`);
    for (const want of ["file:AGENTS.md", "file:WORLD.md", "folder:persistent-workspace"]) expect(names).toContain(want);
    // Each other level's mount is listed at the root as a folder.
    for (const level of ["shipped", "global", "character"] as const) expect(names).toContain(`folder:${mountOf(layers, level)}`);
    const keys = root.map((h) => (h.type === "folder" && !h.path.endsWith("/") ? `${h.path}/` : h.path));
    expect(keys).toEqual([...keys].sort());

    const md = hitsOf(await ctx.env.files.find(ctx.scope, { by: "glob", pattern: "**/*.md" }));
    const chatFiles = ctx.seed.files.filter((f) => f.level === "chat" && f.path.endsWith(".md")).map((f) => f.path);
    expect(md.map((h) => h.path).filter((p) => chatFiles.includes(p)).sort()).toEqual([...chatFiles].sort());
    // Under the root, glob and grep look in the chat's own level only.
    for (const hit of md) expect(hit.level).toBe("chat");

    const global = mountOf(layers, "global");
    const globalMd = hitsOf(await ctx.env.files.find(ctx.scope, { by: "glob", pattern: "**/*.md", path: global }));
    const seededGlobal = ctx.seed.files.filter((f) => f.level === "global" && f.path.endsWith(".md")).map((f) => global + f.path);
    expect(globalMd.map((h) => h.path)).toEqual(expect.arrayContaining(seededGlobal));
    for (const hit of globalMd) expect(hit).toMatchObject({ level: "global", kind: "yours", type: "file" });

    const grep = hitsOf(await ctx.env.files.find(ctx.scope, { by: "grep", pattern: "WHALE OIL", ignoreCase: true }));
    expect(grep).toEqual([expect.objectContaining({ path: "WORLD.md", line: 3, text: "The lighthouse burns whale oil." })]);
    const literal = hitsOf(await ctx.env.files.find(ctx.scope, { by: "grep", pattern: "forty years.", literal: true }));
    expect(literal.map((h) => h.path)).toEqual(["persistent-workspace/story/threads.md"]);
    expect(hitsOf(await ctx.env.files.find(ctx.scope, { by: "grep", pattern: "harbor", glob: "persistent-workspace/**" }))).toEqual([]);
    expect(hitsOf(await ctx.env.files.find(ctx.scope, { by: "glob", pattern: "**/*.md", limit: 1 }))).toHaveLength(1);
  });

  test("the three kinds of file", async () => {
    const layers = await ctx.env.files.layers(ctx.scope);
    expect(await ctx.env.files.read(ctx.scope, "AGENTS.md")).toMatchObject({ kind: "yours" });
    expect(await ctx.env.files.read(ctx.scope, "persistent-workspace/story/threads.md")).toMatchObject({ kind: "notes" });
    expect(await ctx.env.files.read(ctx.scope, `${mountOf(layers, "global")}ALL-AGENTS.md`)).toMatchObject({ kind: "yours", level: "global" });
    const places = await ctx.env.files.places(ctx.scope);
    const briefing = `${places.turn}briefing.md`;
    expect(await ctx.env.files.write(ctx.scope, briefing, { op: "write", text: "What the lead was told.\n" }, "harness")).toMatchObject({ status: "written", kind: "generated" });
    expect(await ctx.env.files.read(ctx.scope, briefing)).toMatchObject({ status: "read", kind: "generated" });
  });

  test("the places: notes, the session, this turn, and where agents may write", async () => {
    const places = await ctx.env.files.places(ctx.scope);
    for (const p of [places.notes, places.session, places.turn ?? ""]) expect(p.endsWith("/")).toBe(true);
    expect(places.turn?.startsWith(places.session)).toBe(true);
    const turn = places.turn ?? "";
    expect([...places.writable].sort()).toEqual([places.notes, ...["queries", "scratch", "output", "cache"].map((f) => `${turn}${f}/`)].sort());
    const noTurn = await ctx.env.files.places({ user: ctx.scope.user, chat: ctx.scope.chat, session: ctx.scope.session });
    expect(noTurn.turn).toBeUndefined();
    expect(noTurn.writable).toEqual([noTurn.notes]);
  });

  test("an agent writes where agents may write, and every change reads back", async () => {
    const places = await ctx.env.files.places(ctx.scope);
    const note = `${places.notes}kit/ledger.md`;
    const write = (op: FileOp) => ctx.env.files.write(ctx.scope, note, op, KIT_AGENT);

    expect(await write({ op: "write", text: "Lamp oil: two barrels.\n" })).toEqual({ status: "written", path: note, kind: "notes", op: "write", bytes: 23, hash: sha256("Lamp oil: two barrels.\n"), before: null });
    expect(await write({ op: "append", text: "Rope: one coil.\n" })).toMatchObject({ status: "written", op: "append", before: sha256("Lamp oil: two barrels.\n") });
    expect(await write({ op: "edit", old: "two", new: "three" })).toMatchObject({ status: "written", op: "edit" });
    expect(await ctx.env.files.read(ctx.scope, note)).toMatchObject({ text: "Lamp oil: three barrels.\nRope: one coil.\n", kind: "notes" });
    expect(await write({ op: "edit", old: "anchor", new: "chain" })).toEqual({ status: "unapplied", path: note, reason: "no-match" });
    expect(await write({ op: "edit", old: "", new: "x" })).toEqual({ status: "unapplied", path: note, reason: "no-match" });
    expect(await write({ op: "edit", old: "o", new: "0" })).toMatchObject({ status: "unapplied", reason: "several" });
    expect(await write({ op: "edit", old: "one", new: "1", all: true })).toMatchObject({ status: "written" });
    expect(await ctx.env.files.read(ctx.scope, note)).toMatchObject({ text: "Lamp oil: three barrels.\nRope: 1 coil.\n" });
    expect(await write({ op: "delete" })).toMatchObject({ status: "written", op: "delete", bytes: 0, hash: null });
    expect(await ctx.env.files.read(ctx.scope, note)).toMatchObject({ status: "missing" });
    expect(await write({ op: "delete" })).toEqual({ status: "unapplied", path: note, reason: "missing" });
    expect(await ctx.env.files.write(ctx.scope, places.notes.slice(0, -1), { op: "write", text: "x" }, KIT_AGENT)).toMatchObject({ status: "refused" });
    expect(await ctx.env.files.write(ctx.scope, `${places.notes}story`, { op: "write", text: "x" }, KIT_AGENT)).toEqual({ status: "unapplied", path: `${places.notes}story`, reason: "folder" });

    for (const folder of places.writable.filter((w) => w !== places.notes)) {
      const path = `${folder}kit-${folder.split("/").at(-2) ?? ""}.md`;
      expect(await ctx.env.files.write(ctx.scope, path, { op: "write", text: "kept\n" }, KIT_AGENT)).toMatchObject({ status: "written", kind: "generated" });
      expect(await ctx.env.files.read(ctx.scope, path)).toMatchObject({ status: "read", text: "kept\n" });
    }
    expect(await ctx.env.files.write(ctx.scope, `${places.session}${ctx.scope.session}.jsonl`, { op: "append", text: "{}\n" }, "harness")).toMatchObject({ status: "written", kind: "generated" });
  });

  test("a write outside where agents may write is refused, and changes nothing", async () => {
    const layers = await ctx.env.files.layers(ctx.scope);
    const places = await ctx.env.files.places(ctx.scope);
    const before = await viewPicture(ctx.env.files, ctx.scope);
    const cases: { path: string; reason: string; by?: "harness" }[] = [
      { path: "AGENTS.md", reason: "yours" },
      { path: "WORLD.md", reason: "yours" },
      { path: "kit-new.md", reason: "yours" },
      { path: "agents/kit-scribe.md", reason: "yours" },
      { path: `${mountOf(layers, "global")}ALL-AGENTS.md`, reason: "mounted" },
      { path: `${mountOf(layers, "global")}.rules/kit-new.md`, reason: "mounted" },
      { path: `${mountOf(layers, "character")}AGENTS.md`, reason: "mounted" },
      { path: `${mountOf(layers, "shipped")}TURN.md`, reason: "mounted" },
      { path: `${places.turn}briefing.md`, reason: "generated" },
      { path: `${places.turn}transcripts/kit.md`, reason: "generated" },
      { path: `${places.session}${ctx.scope.session}.jsonl`, reason: "generated" },
      { path: `${mountOf(layers, "global")}ALL-AGENTS.md`, reason: "mounted", by: "harness" },
      { path: "AGENTS.md", reason: "yours", by: "harness" },
    ];
    const ops: FileOp[] = [{ op: "write", text: "overwritten\n" }, { op: "append", text: "added\n" }, { op: "edit", old: "e", new: "E", all: true }, { op: "delete" }];
    for (const c of cases) {
      for (const op of ops) {
        const result = await ctx.env.files.write(ctx.scope, c.path, op, c.by ?? KIT_AGENT);
        expect({ path: c.path, op: op.op, result }).toMatchObject({ result: { status: "refused", reason: c.reason } });
        if (result.status === "refused") expect(result.writable).toEqual(c.by === "harness" ? [...places.writable, places.session] : places.writable);
      }
    }
    expect(await viewPicture(ctx.env.files, ctx.scope)).toEqual(before);
  });

  test("a path that leaves the view is refused, for reads, finds and writes, and nothing lands outside", async () => {
    const layers = await ctx.env.files.layers(ctx.scope);
    const sentinel = `kit-escape-${randomUUID()}`;
    const escapes = [
      `../${sentinel}`,
      `../../${sentinel}`,
      `/../${sentinel}`,
      `persistent-workspace/../../${sentinel}`,
      `persistent-workspace/../../../../../../../../../../${sentinel}`,
      `${mountOf(layers, "global")}../../${sentinel}`,
      `${mountOf(layers, "character")}../../../${sentinel}`,
    ];
    const invalid = [`persistent-workspace/kit\0${sentinel}`, `persistent-workspace\\..\\..\\${sentinel}`];
    for (const path of escapes) {
      expect({ path, result: await ctx.env.files.write(ctx.scope, path, { op: "write", text: "out\n" }, KIT_AGENT) }).toMatchObject({ result: { status: "refused", reason: "outside" } });
      expect({ path, result: await ctx.env.files.write(ctx.scope, path, { op: "append", text: "out\n" }, "harness") }).toMatchObject({ result: { status: "refused", reason: "outside" } });
      expect({ path, result: await ctx.env.files.read(ctx.scope, path) }).toMatchObject({ result: { status: "refused", reason: "outside" } });
      expect({ path, result: await ctx.env.files.find(ctx.scope, { by: "list", path }) }).toMatchObject({ result: { status: "refused", reason: "outside" } });
    }
    for (const path of invalid) {
      expect({ path, result: await ctx.env.files.write(ctx.scope, path, { op: "write", text: "out\n" }, KIT_AGENT) }).toMatchObject({ result: { status: "refused", reason: "invalid" } });
      expect({ path, result: await ctx.env.files.read(ctx.scope, path) }).toMatchObject({ result: { status: "refused", reason: "invalid" } });
    }
    // Nothing named for this run appears anywhere the host keeps things, nor beside it.
    expect(await landed(ctx.place, sentinel)).toEqual([]);
  });
}
