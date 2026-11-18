// An agent's opening block (§5.2, §10.2), made by one builder for every agent and listed whole by
// `definitions.stack`: the stack's opening parts, the reply contract for a lead, each family guide,
// each held tool's description, the skills' index for an agent that can call `skill_load` (by holding
// it or by reaching it through `tool_use`, §6.8, R-65), what the definition's `opening:` names, and
// the briefing's parts with the situations that add them. A file of part 7 is the briefing's alone. A
// pin is handed at each run's start, told to the host as a pin. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { joined } from "../../src/agents/attachments";
import type { AttachmentRef, StackPart } from "../../src/contract";
import { request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const SKILL = "---\nname: fixture-tides\ndescription: Fixture - load it when the tide matters.\n---\nFixture body of fixture-tides.\n";
const lead = (outOfReach: string) => `---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [tool_use]\n${outOfReach}given: [prompt:*]\n---\nFixture chief: you run the turn.\n`;

/** The lead's opening block on its first call, under a definition with the given `out_of_reach:` line. */
async function openingWith(outOfReach: string): Promise<string> {
  const s = (open = await stage({ files: { ".agents/chief.md": lead(outOfReach), ".skills/fixture-tides/SKILL.md": SKILL }, answers: [{ pieces: [{ text: "<reply>The tide turns.</reply>" }] }] }));
  expect((await s.turn(request("t1", { lead: "chief" }))).outcome.status).toBe("released");
  const text = textOf(s.model.requests[0]!.messages[0]!);
  await s.close();
  open = undefined;
  return text;
}

test("a definition holding tool_use and not skill_load is given the skills' index; with skills out of its reach it is not", async () => {
  expect(await openingWith("")).toContain("fixture-tides");
  expect(await openingWith("out_of_reach: [skills]\n")).not.toContain("fixture-tides");
});

const CHAT = "chats/wren-hale/lighthouse/";
const ALL = "Fixture rule for all: keep to the log.";
const SWIPE = "Fixture swipe: play the moment another way.";
const FILES_GUIDE = "Fixture files guide: read a file before you write it.";
const AGENTS_GUIDE = "Fixture agents guide: brief whom you start.";
const PLAN = "Fixture plan: the boat is two days late.";
const STYLE = "Fixture style: short sentences.";
const CHIEF = (extra = "") => `---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [file_read, delegate, skill_load]\nreads: [ALL-AGENTS, SWIPE]\ngiven: [prompt:*, briefing]\n${extra}---\nFixture chief: you run the turn.\n`;
const KEEPER = "---\nname: keeper\ndescription: Fixture keeper.\nmodel: default\ntools: [file_read]\nreads: [ALL-AGENTS]\n---\nFixture keeper: keep the books.\n";
const TREE = {
  ".agents/chief.md": CHIEF(),
  ".agents/keeper.md": KEEPER,
  "ALL-AGENTS.md": `${ALL}\n`,
  "SWIPE.md": `${SWIPE}\n`,
  "config.yml": "stack:\n  added:\n    swipe: [SWIPE]\n    regenerate: [SWIPE]\n",
  ".tools/files.md": `---\ndescription: Fixture guide to the file tools.\n---\n${FILES_GUIDE}\n`,
  ".tools/agents.md": `---\ndescription: Fixture guide to the team.\n---\n${AGENTS_GUIDE}\n`,
  ".skills/fixture-tides/SKILL.md": SKILL,
};
const RELEASE = { pieces: [{ text: "<reply>Wren counts the candles.</reply>" }] };

/** The text of an opening block as `definitions.stack` lists its parts: every part in the opening that is given, but the tools' descriptions. */
const openingText = (parts: readonly StackPart[]): string => joined(parts.flatMap((part) => (part.where === "opening" && part.kind !== "description" && part.left === undefined && part.text !== undefined ? [part.text] : [])));

test("the Author's stack lists the reply contract, each family guide, each held tool's description and the skills list with their files, and SWIPE.md with the situations that add it", async () => {
  const s = (open = await stage({ files: TREE, answers: [] }));
  const parts = await s.harness.definitions.stack(request("t1").scope, "chief");
  expect(parts.map((part) => [part.where, part.kind, part.part, part.path])).toEqual([
    ["opening", "instruction", "ALL-AGENTS", "@global/ALL-AGENTS.md"],
    ["opening", "definition", "agents/chief", "@global/.agents/chief.md"],
    ["opening", "contract", "prompts/reply-contract", "@shipped/.prompts/reply-contract.md"],
    ["opening", "guide", "tools/files", "@global/.tools/files.md"],
    ["opening", "guide", "tools/agents", "@global/.tools/agents.md"],
    ["opening", "guide", "tools/skills", "@shipped/.tools/skills.md"],
    ["opening", "description", "tools/file_read", "@shipped/.tools/file_read.md"],
    ["opening", "description", "tools/delegate", "@shipped/.tools/delegate.md"],
    ["opening", "description", "tools/skill_load", "@shipped/.tools/skill_load.md"],
    ["opening", "skills", "prompts/skills", "@shipped/.prompts/skills.md"],
    ["briefing", "instruction", "SWIPE", "@global/SWIPE.md"],
  ]);
  for (const part of parts) expect(part.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(parts.find((part) => part.part === "tools/files")?.text).toBe(FILES_GUIDE);
  expect(parts.find((part) => part.kind === "skills")?.text).toContain("fixture-tides");
  expect(parts.find((part) => part.part === "tools/file_read")?.text).toStartWith("Reads a file, or some of its lines.");
  expect(parts.find((part) => part.part === "SWIPE")).toMatchObject({ text: SWIPE, situations: ["swipe", "regenerate"] });
});

test("the lead's first request and a sub-agent's first request hold exactly the parts their definitions.stack lists, in that order", async () => {
  const s = (open = await stage({
    files: TREE,
    answers: [{ pieces: [{ call: "delegate", args: { agent: "keeper", brief: "Keep the books for this turn." }, id: "d-1" }] }, { pieces: [{ text: "The books are kept." }] }, RELEASE],
  }));
  expect((await s.turn(request("t1", { lead: "chief" }))).outcome.status).toBe("released");
  const scope = request("t1").scope;
  const [lead, keeper] = s.model.requests;
  const chief = await s.harness.definitions.stack(scope, "chief");
  expect(textOf(lead!.messages[0]!)).toBe(openingText(chief));
  // Each held tool's description is what its declaration carries.
  for (const part of chief.filter((p) => p.kind === "description")) expect(lead!.tools.find((tool) => `tools/${tool.name}` === part.part)?.description).toBe(part.text!);
  const kept = await s.harness.definitions.stack(scope, "keeper");
  expect(kept.map((part) => part.kind)).toEqual(["instruction", "definition", "guide", "description"]);
  expect(textOf(keeper!.messages[0]!)).toBe(openingText(kept));
});

test("a definition whose reads: names SWIPE: its opening block holds no SWIPE.md, and a swipe's briefing holds it once", async () => {
  const s = (open = await stage({ files: TREE, answers: [RELEASE] }));
  expect((await s.turn(request("t1", { lead: "chief", kind: "swipe" }))).outcome.status).toBe("released");
  const sent = s.model.requests[0]!.messages.map((message) => textOf(message));
  expect(sent[0]).not.toContain(SWIPE);
  expect(sent.join("\n").split(SWIPE)).toHaveLength(2);
  expect(sent.find((text) => text.includes(SWIPE))).toStartWith("# Briefing for this turn");
});

test("a given item marked for the opening is in the Author's opening block once; later turns do not ask the host for it again", async () => {
  const drawn = "Fixture drawn layer: three rooms and a stair.";
  const s = (open = await stage({
    files: { ...TREE, ".agents/chief.md": CHIEF("opening: [map:drawn]\n") },
    events: (inner) => ({
      ...inner,
      attachments: async (scope, agent, refs, moment) => [...(await inner.attachments(scope, agent, refs, moment)), ...refs.filter((ref) => ref.ref === "map:drawn").map((ref) => ({ name: ref.ref, text: drawn }))],
    }),
    answers: [RELEASE, RELEASE],
  }));
  expect((await s.turn(request("t1", { lead: "chief" }))).outcome.status).toBe("released");
  expect((await s.turn(request("t2", { lead: "chief" }))).outcome.status).toBe("released");
  for (const call of s.model.requests) {
    const sent = call.messages.map((message) => textOf(message));
    expect(sent[0]!.split(drawn)).toHaveLength(2);
    expect(sent.slice(1).join("\n")).not.toContain(drawn);
  }
  const told = s.told.filter((told) => told.kind === "attachments").flatMap((told) => (told.payload as AttachmentRef[]).filter((ref) => ref.ref === "map:drawn").map((ref) => ref.from));
  expect(told).toEqual(["opening"]);
  const parts = await s.harness.definitions.stack(request("t2").scope, "chief");
  expect(parts.find((part) => part.kind === "given")).toEqual({ kind: "given", part: "map:drawn", path: "@global/.agents/chief.md", level: "global", where: "opening" });
});

test("a pinned file is told to the host with from pin, and the definition view's given holds no pin; deleted in the middle of a session, the lead's next run logs it as a file pinned for the lead and is handed nothing for it", async () => {
  const s = (open = await stage({
    files: { ...TREE, [`${CHAT}config.yml`]: "stack:\n  pins:\n    - { file: persistent-workspace/plan.md, agent: chief }\n", [`${CHAT}persistent-workspace/plan.md`]: `${PLAN}\n` },
    answers: [RELEASE, RELEASE],
  }));
  expect((await s.turn(request("t1", { lead: "chief" }))).outcome.status).toBe("released");
  expect(s.model.requests[0]!.messages.map((message) => textOf(message)).at(-1)).toContain(PLAN);
  const told = s.told.filter((told) => told.kind === "attachments").flatMap((told) => (told.payload as AttachmentRef[]).map((ref) => [ref.ref, ref.from]));
  expect(told).toEqual([["file:persistent-workspace/plan.md", "pin"]]);
  expect(s.trace.of("agent_started")[0]?.event.given).toEqual(["prompt:*", "briefing", "file:persistent-workspace/plan.md"]);
  expect((await s.harness.definitions.list(request("t1").scope)).find((view) => view.name === "chief")?.given).toEqual(["prompt:*", "briefing"]);

  await rm(join(s.dir, "files", CHAT, "persistent-workspace/plan.md"));
  expect((await s.turn(request("t2", { lead: "chief" }))).outcome.status).toBe("released");
  expect(s.model.requests[1]!.messages.map((message) => textOf(message)).join("\n")).not.toContain(PLAN);
  expect(s.logged).toContainEqual(expect.objectContaining({ message: "A file pinned for an agent cannot be handed.", fields: expect.objectContaining({ agent: "chief", file: "persistent-workspace/plan.md" }) }));
  expect(s.trace.of("agent_started")[1]?.event.given).toEqual(["prompt:*", "briefing"]);
});

test("the writer write_reply starts is handed whole a file pinned for it and a file its definition's given: names; its system text is the block definitions.stack lists for it; its agent_started record names exactly what its request holds", async () => {
  const narrator = "---\nname: narrator\ndescription: Fixture narrator.\nmodel: default\ntools: []\nreads: [ALL-AGENTS]\ngiven: [prompt:*, brief, file:persistent-workspace/style.md]\n---\nFixture narrator: write the reply from the brief.\n";
  const s = (open = await stage({
    files: {
      ...TREE,
      ".agents/chief.md": "---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [write_reply, reply_release]\ngiven: [prompt:*, briefing]\nwriter: narrator\n---\nFixture chief: you run the turn.\n",
      ".agents/narrator.md": narrator,
      [`${CHAT}config.yml`]: "stack:\n  pins:\n    - { file: persistent-workspace/plan.md, agent: narrator }\n",
      [`${CHAT}persistent-workspace/plan.md`]: `${PLAN}\n`,
      [`${CHAT}persistent-workspace/style.md`]: `${STYLE}\n`,
    },
    answers: [{ pieces: [{ call: "write_reply", args: { brief: "Fixture brief: the boat is late." } }] }, { pieces: [{ text: "The boat has not come." }] }, { pieces: [{ call: "reply_release", args: {} }] }, { pieces: [{ text: "Released." }] }],
  }));
  expect((await s.turn(request("t1", { lead: "chief" }))).outcome.status).toBe("released");
  const writer = s.model.requests[1]!.messages.map((message) => textOf(message));
  const parts = await s.harness.definitions.stack(request("t1").scope, "narrator");
  expect(writer).toContain(openingText(parts));
  const given = writer.find((text) => text.includes(PLAN));
  expect(given).toContain(STYLE);
  const started = s.trace.of("agent_started").find((record) => record.agent?.definition === "narrator");
  expect(started?.event.given).toEqual(["prompt:*", "file:persistent-workspace/style.md", "file:persistent-workspace/plan.md", "brief"]);
  const told = s.told.filter((told) => told.kind === "attachments").flatMap((told) => (told.payload as AttachmentRef[]).map((ref) => [ref.ref, ref.from]));
  expect(told).toEqual([
    ["file:persistent-workspace/style.md", "definition"],
    ["file:persistent-workspace/plan.md", "pin"],
  ]);
});
