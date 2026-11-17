// The rule engine (§5.4) over the drafted rules: each kind of trigger fires on its condition and not
// otherwise; `repeat:` holds a rule to once per turn unless the file says otherwise; a rule's text is
// filled from the fact's fields, counting only the groups its header picks; a reminder tied by
// `needs:` to a file stops the moment that file is switched off; a pattern that could take time
// without end is not in force, and the others look at bounded stretches of text; and a question,
// which no model is asked, is not in force.

import { afterEach, describe, expect, test } from "bun:test";
import type { FactValue } from "../../src/contract/index";
import { createRuleRun } from "../../src/files/engine";
import type { OwnFactValues, RuleMemory, RuleRun } from "../../src/files/index";
import { createFacts, loadGuidance } from "../../src/files/index";
import { parseRule } from "../../src/files/rules";
import type { Bench } from "./support";
import { author, bench, drafted, draftedFile, gm, PLAN_FACTS, scope } from "./support";

let b: Bench | undefined;
afterEach(async () => {
  await b?.close();
  b = undefined;
});

/** RPH's own facts as the harness would give them. */
let own: OwnFactValues = {};

async function drafts(): Promise<Bench> {
  own = { "reply.released": { count: 1 } };
  return bench({ shipped: await drafted() }, PLAN_FACTS);
}

async function run(memory?: RuleMemory, window?: number): Promise<RuleRun> {
  if (b === undefined) throw new Error("No bench.");
  const facts = createFacts(b.host.facts, () => own);
  return loadGuidance(b.host.files, scope).ruleRun({ facts, patternTime: 50, ...(memory !== undefined ? { memory } : {}), ...(window !== undefined ? { window } : {}) });
}

const STAGE: FactValue = {
  count: 3,
  names: ["Wren Hale", "Old Tam", "a gull"],
  by: { principal: 1, supporting: 1, extra: 1 },
  namesBy: { principal: ["Wren Hale"], supporting: ["Old Tam"], extra: ["a gull"] },
};

describe("at a run's end", () => {
  test("a fact that holds fires the rule for the agents it names, with its text filled from the fact's fields, once per turn", async () => {
    b = await drafts();
    await b.facts({ "stage.unperceived": STAGE });
    const first = await run();
    const due = await first.runEnd.due({ agent: author, call: 3 });
    expect(due).toEqual([
      {
        firing: { rule: "perceptions-owed", path: "@shipped/.rules/perceptions-owed.md", level: "shipped", moment: "run-end", fact: { name: "stage.unperceived", value: STAGE } },
        // The header picks principals and supporting characters; the extra counted by the fact is not named.
        text: "These characters were on stage this turn and have no perception recorded for it: Wren Hale, Old Tam.\nWrite them now, or start a job that will. See the perceptions rule.\n",
      },
    ]);
    expect(await first.runEnd.due({ agent: author, call: 4 })).toEqual([]);
    expect(await first.runEnd.due({ agent: gm, call: 2 })).toEqual([]);

    // The next turn, it may fire again.
    const next = await run(first.memory());
    expect((await next.runEnd.due({ agent: author, call: 1 })).map((f) => f.firing.rule)).toEqual(["perceptions-owed"]);
  });

  test("a fact that does not hold, counted only in the groups the rule picks, does not fire", async () => {
    b = await drafts();
    await b.facts({ "stage.unperceived": { count: 2, names: ["a gull", "a fisher"], by: { principal: 0, supporting: 0, extra: 2 } } });
    expect(await (await run()).runEnd.due({ agent: author, call: 1 })).toEqual([]);
  });

  test("a reply not released is caught by RPH's own fact, and not once it is", async () => {
    b = await drafts();
    own = { "reply.released": { count: 0 } };
    expect((await (await run()).runEnd.due({ agent: author, call: 1 })).map((f) => [f.firing.rule, f.text])).toEqual([
      ["reply-missing", "You are about to end the turn and the player has no reply. Write it now, marked the way the reply contract says.\n"],
    ]);
    own = {};
    expect(await (await run()).runEnd.due({ agent: author, call: 1 })).toEqual([]);
  });
});

describe("at a turn's start", () => {
  test("a fact rule fires when it holds, and `after 6 turns` keeps it quiet until six more turns have begun", async () => {
    b = await drafts();
    await b.facts({ "turns.since.engine.change": { count: 6 } });
    let memory: RuleMemory | undefined;
    const fired: string[][] = [];
    for (let turn = 1; turn <= 8; turn++) {
      const r = await run(memory);
      fired.push((await r.turnStart(author)).map((f) => f.firing.rule));
      memory = r.memory();
    }
    expect(fired).toEqual([["engine-silent"], [], [], [], [], [], ["engine-silent"], []]);
    expect(memory?.turns).toBe(8);

    await b.facts({ "turns.since.engine.change": { count: 5 } });
    expect(await (await run()).turnStart(author)).toEqual([]);
  });

  test("its text is filled from the fact", async () => {
    b = await drafts();
    await b.facts({ "turns.since.engine.change": { count: 7 }, "history.leaving.uncovered": { count: 0 } });
    const [silent] = await (await run()).turnStart(author);
    expect(silent?.text).toBe("Nothing has been recorded in the engine lane for 7 turns. Time, position, belongings and condition rarely stand still that long. Check what the last turns changed and record it, or say that nothing did.\n");
    expect(silent?.firing).toMatchObject({ moment: "turn-start", fact: { name: "turns.since.engine.change", value: { count: 7 } } });
  });

  test("`every:` fires when the count of turns comes round", async () => {
    b = await bench({ chat: { "rules/memory-nudge.md": await draftedFile(".rules/examples/memory-nudge.md") } });
    const r9 = await run({ turns: 8, fired: {}, held: [] });
    expect(await r9.turnStart(author)).toEqual([]);
    const r10 = await run(r9.memory());
    expect((await r10.turnStart(author)).map((f) => [f.firing.rule, f.firing.moment])).toEqual([["memory-nudge", "interval"]]);
    const r11 = await run(r10.memory());
    expect(await r11.turnStart(author)).toEqual([]);
  });
});

describe("before a compaction", () => {
  test("`repeat: always` fires every time the moment comes", async () => {
    b = await drafts();
    const r = await run();
    for (let i = 0; i < 2; i++) expect((await r.beforeCompaction(author)).map((f) => f.firing.rule)).toEqual(["save-before-compaction"]);
    expect(await r.beforeCompaction(gm)).toEqual([]);
  });
});

describe("a pattern", () => {
  test("on a tool's result fires on its marks, for any agent, once per turn each", async () => {
    b = await drafts();
    const r = await run();
    const clean = { content: [{ type: "text" as const, text: "Wren stands at the lamp." }] };
    const marked = { ...clean, marks: ["unsourced"] };
    expect(await r.toolResult(gm, { id: "c1", tool: "world_apply" }, clean)).toEqual([]);
    const fired = await r.toolResult(gm, { id: "c2", tool: "world_apply" }, marked);
    expect(fired.map((f) => f.firing)).toEqual([{ rule: "unsourced", path: "@shipped/.rules/unsourced.md", level: "shipped", moment: "tool-result", watched: "result", callId: "c2", tool: "world_apply", matched: "marked unsourced" }]);
    expect(fired[0]?.text).toStartWith("Something you just recorded has no source.");
    expect(await r.toolResult(gm, { id: "c3", tool: "cast_update" }, marked)).toEqual([]);
    expect((await r.toolResult(author, { id: "c4", tool: "world_apply" }, marked)).map((f) => f.firing.rule)).toEqual(["unsourced"]);

    // Two calls answered side by side in the next turn still fire it once.
    const next = await run(r.memory());
    const both = await Promise.all([next.toolResult(gm, { id: "c5", tool: "world_apply" }, marked), next.toolResult(gm, { id: "c6", tool: "map_place" }, marked)]);
    expect(both.flat().map((f) => f.firing.callId)).toEqual(["c5"]);
  });

  test("on the reply stops the call at the match, and covers the reply only while it is in force", async () => {
    b = await drafts();
    expect((await run()).stream(author).coverReply).toBe(false);
    await b.put("chat", "rules/banned-phrases.md", await draftedFile(".rules/examples/banned-phrases.md"));
    const r = await run();
    const rules = r.stream(author);
    expect(rules.coverReply).toBe(true);
    expect(r.stream(gm).coverReply).toBe(false);
    const written = { agent: author, call: 1, piece: "text" as const, text: "<reply>A shiver ran", thinking: "", reply: "A shiver ran" };
    expect(rules.check(written)).toBeUndefined();
    expect(rules.check({ ...written, piece: "thinking", thinking: "shivers down her spine" })).toBeUndefined();
    const fired = rules.check({ ...written, text: "<reply>A shiver ran; shivers down her spine", reply: "A shiver ran; shivers down her spine" });
    expect(fired).toMatchObject({ interrupt: true, firing: { rule: "banned-phrases", moment: "stream", watched: "reply", matched: "shivers down her spine" } });
    expect(fired?.text).toBe("You were about to write a phrase this player never wants to read. Say it another way, in plain words, and go on.\n");
    // Never twice on one call; `repeat: always` lets it fire on the next.
    expect(rules.check({ ...written, reply: "shivers down her spine, again" })).toBeUndefined();
    expect(rules.check({ ...written, call: 2, reply: "a testament to it" })?.firing.matched).toBe("a testament to");
  });

  test("on the text or the thinking, with `interrupt: never`, reminds after the message instead of stopping it", async () => {
    b = await bench({ chat: { "rules/hedging.md": "---\ndescription: Hedging.\nagents: [author]\nscope: [thinking]\ncondition: 'I (?:might|could) guess'\ninterrupt: never\n---\nYou were about to guess at {{matched}}.\n" } });
    const rules = (await run()).stream(author);
    expect(rules.coverReply).toBe(false);
    const base = { agent: author, call: 1, text: "I could guess the name", thinking: "" };
    expect(rules.check({ ...base, piece: "text" })).toBeUndefined();
    expect(rules.check({ ...base, piece: "thinking", thinking: "I might guess the name" })).toMatchObject({ interrupt: false, text: "You were about to guess at I might guess.\n", firing: { watched: "thinking" } });
  });

  test("on a tool's arguments holds that tool, and lets every other tool run", async () => {
    b = await bench({ chat: { "rules/no-delete.md": "---\ndescription: Deleting notes.\nagents: all\nscope: [arguments:file_write]\ncondition: '\"op\":\"delete\"'\nhold: true\n---\nNotes are not deleted here: {{tool}} was not run.\n" } });
    const r = await run();
    expect(await r.toolCall(author, { id: "c1", tool: "file_write", args: { path: "notes/a.md", op: "write" } })).toEqual({ remind: [] });
    expect(await r.toolCall(author, { id: "c2", tool: "file_find", args: { op: "delete" } })).toEqual({ remind: [] });
    const held = await r.toolCall(author, { id: "c3", tool: "file_write", args: { path: "notes/a.md", op: "delete" } });
    expect(held).toEqual({ hold: { firing: { rule: "no-delete", path: "rules/no-delete.md", level: "chat", moment: "tool-call", watched: "arguments", callId: "c3", tool: "file_write", matched: '"op":"delete"' }, text: "Notes are not deleted here: file_write was not run.\n" }, remind: [] });
  });
});

describe("a pattern's cost", () => {
  test("a pattern that could take time without end on some text is in force; only one that cannot be parsed is broken", async () => {
    const rule = (condition: string) => `---\ndescription: Fixture.\nagents: all\nscope: [reply]\ncondition: '${condition}'\n---\nText.\n`;
    b = await bench({
      chat: {
        "rules/nested.md": rule("(a+)+$"),
        "rules/backwards.md": rule("(\\w+) \\1"),
        "rules/unread.md": rule("(a"),
      },
    });
    const g = loadGuidance(b.host.files, scope);
    expect((await g.rules()).map((r) => [r.name, r.inForce, r.why])).toEqual([
      ["backwards", true, undefined],
      ["nested", true, undefined],
      ["unread", false, "broken"],
    ]);
  });

  test("it looks at the newest stretch of what is written, and at a tool's text a stretch at a time, so a long text costs no more than its stretches", async () => {
    b = await bench({
      chat: {
        "rules/slow.md": "---\ndescription: Fixture.\nagents: all\nscope: [reply]\ncondition: '.*.*z'\n---\nText.\n",
        "rules/sourced.md": "---\ndescription: Fixture.\nagents: all\nscope: [result:*]\ncondition: 'the rail is rotten'\n---\nText.\n",
      },
    });
    const r = await run(undefined, 500);
    const rules = r.stream(author);
    const long = "a".repeat(4_000);
    const started = performance.now();
    expect(rules.check({ agent: author, call: 1, piece: "text", text: long, thinking: "", reply: long })).toBeUndefined();
    // Over the whole text this pattern takes some seconds; over the newest 500 characters, tens of milliseconds.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(rules.check({ agent: author, call: 1, piece: "text", text: `${long}z`, thinking: "", reply: `${long}z` })?.firing.rule).toBe("slow");
    // Within a long result, a phrase anywhere is found.
    const result = { content: [{ type: "text" as const, text: `${"b".repeat(1_234)} the rail is rotten ${"b".repeat(3_000)}` }] };
    expect((await r.toolResult(gm, { id: "c1", tool: "world_query" }, result)).map((f) => f.firing.matched)).toEqual(["the rail is rotten"]);
  });

  test("`case: ignore` finds a phrase whatever the case of its letters, as at a sentence's start; left out, the case counts", async () => {
    const rule = (name: string, extra: string) => `---\ndescription: Fixture ${name}.\nagents: all\nscope: [reply]\ncondition: 'a testament to'\n${extra}---\nText.\n`;
    b = await bench({ chat: { "rules/exact.md": rule("exact", ""), "rules/any-case.md": rule("any case", "case: ignore\n"), "rules/wrong.md": rule("wrong", "case: loose\n") } });
    const rules = (await run()).stream(author);
    const reply = "The tower stands. A testament to the keepers.";
    expect(rules.check({ agent: author, call: 1, piece: "text", text: reply, thinking: "", reply })?.firing).toMatchObject({ rule: "any-case", matched: "A testament to" });
    expect(rules.check({ agent: author, call: 1, piece: "text", text: reply, thinking: "", reply })).toBeUndefined();
    const views = Object.fromEntries((await loadGuidance(b.host.files, scope).rules()).map((r) => [r.name, r.why]));
    expect(views).toEqual({ "any-case": undefined, exact: undefined, wrong: "broken" });
  });
});

describe("a question", () => {
  test("is in force, and the run puts it to the judging model about what it looks at; `interrupt:` and `judge:` are read from its header", async () => {
    const waits = "---\ndescription: Fixture - waits for its answer.\nagents: [author]\nscope: [text]\nquestion: Does it promise a reward?\ninterrupt: always\njudge: fixture-judge\n---\nFixture text.\n";
    const wrong = "---\ndescription: Fixture - a wrong interrupt.\nagents: [author]\nscope: [text]\nquestion: Does it promise a reward?\ninterrupt: sometimes\n---\nFixture text.\n";
    b = await bench({ chat: { "rules/no-player-voice.md": await draftedFile(".rules/examples/no-player-voice.md"), "rules/waits.md": waits, "rules/wrong.md": wrong } });
    const g = loadGuidance(b.host.files, scope);
    expect((await g.rules()).map((r) => [r.name, r.trigger, r.inForce])).toEqual([
      ["no-player-voice", "question", true],
      ["waits", "question", true],
      ["wrong", "question", false],
    ]);
    expect((await g.problems()).filter((p) => p.path !== "rules/wrong.md")).toEqual([]);
    const asked = (await run()).questions(author, { text: "A reward awaits.", reply: "Wren nods, and you agree." });
    expect(asked.map((q) => [q.rule, q.watched, q.interrupt, q.judge])).toEqual([
      ["no-player-voice", "reply", false, undefined],
      ["waits", "text", true, "fixture-judge"],
    ]);
  });

  test("in the engine: asked about what the rule looks at, it fires on yes alone, and about a reply already shown goes into the next briefing", async () => {
    b = await bench({ chat: { "rules/no-player-voice.md": await draftedFile(".rules/examples/no-player-voice.md") } });
    const file = await b.host.files.read(scope, "rules/no-player-voice.md");
    const rule = file.status === "read" ? parseRule(file, "no-player-voice", []).rule : undefined;
    if (rule === undefined) throw new Error("The rule does not read.");
    const facts = createFacts(b.host.facts, () => own);
    const runOf = (memory?: RuleMemory): RuleRun => createRuleRun({ scope, rules: [rule], read: async () => [rule], facts, patternTime: 50, ...(memory !== undefined ? { memory } : {}) });
    const r = runOf();
    expect(r.questions(gm, { text: "Rolled.", reply: "x" })).toEqual([]);
    const [q] = r.questions(author, { text: "<reply>Wren nods.</reply>", reply: "Wren nods." });
    expect(q).toMatchObject({ rule: "no-player-voice", watched: "reply", text: "Wren nods.", question: expect.stringContaining("Does this passage decide") });
    if (q === undefined) throw new Error("No question.");
    expect(await r.answered(q, false)).toBeUndefined();

    const [again] = r.questions(author, { text: "", reply: "Wren nods, and you agree." });
    if (again === undefined) throw new Error("No question.");
    const answered = await r.answered(again, true);
    if (answered === undefined) throw new Error("A yes did not fire the rule.");
    expect(answered.deliver).toBe("briefing");
    expect(answered.fired.firing).toMatchObject({ rule: "no-player-voice", moment: "after-message", matched: "yes" });
    expect(r.questions(author, { text: "", reply: "More." })).toEqual([]);

    const next = runOf(r.memory());
    const due = await next.turnStart(author);
    expect(due).toEqual([{ carried: true, firing: answered.fired.firing, text: answered.fired.text }]);
    expect(await runOf(next.memory()).turnStart(author)).toEqual([]);
  });
});

describe("`repeat:`", () => {
  test("once per session holds across the session's turns; always fires on every moment", async () => {
    b = await bench({
      chat: {
        "rules/once.md": "---\ndescription: Once.\nagents: all\nat: run-end\nrepeat: once per session\n---\nOnce.\n",
        "rules/each.md": "---\ndescription: Each.\nagents: all\nat: run-end\nrepeat: always\n---\nEach.\n",
      },
    });
    const first = await run();
    expect((await first.runEnd.due({ agent: author, call: 1 })).map((f) => f.firing.rule)).toEqual(["each", "once"]);
    expect((await first.runEnd.due({ agent: author, call: 2 })).map((f) => f.firing.rule)).toEqual(["each"]);
    const second = await run(first.memory());
    expect((await second.runEnd.due({ agent: author, call: 1 })).map((f) => f.firing.rule)).toEqual(["each"]);
    expect((await (await run()).runEnd.due({ agent: author, call: 1 })).map((f) => f.firing.rule)).toEqual(["each", "once"]);
  });
});

describe("`needs:`", () => {
  test("a reminder stops the moment the file it needs is switched off, within one run", async () => {
    b = await drafts();
    own = { "reply.released": { count: 0 } };
    await b.facts({ "stage.unperceived": STAGE, "turns.since.engine.change": { count: 9 } });
    // The run begins with every rule in force; the files go off before its first moment.
    const r = await run();
    await b.put("chat", "config.yml", "stack: { off: [rules/perceptions, TURN] }\n");
    expect((await r.runEnd.due({ agent: author, call: 1 })).map((f) => f.firing.rule)).toEqual(["reply-missing"]);
    expect(await r.turnStart(author)).toEqual([]);
    const rules = Object.fromEntries((await loadGuidance(b.host.files, scope).rules()).map((r) => [r.name, r]));
    for (const name of ["perceptions-owed", "perceptions-missing", "engine-silent", "history-leaving"]) expect(rules[name]).toMatchObject({ inForce: false, why: "needs" });
    expect(rules.perceptions).toMatchObject({ inForce: false, why: "off" });

    // Back on: the same run's next moment fires it.
    await b.put("chat", "config.yml", "stack: { off: [] }\n");
    expect((await r.runEnd.due({ agent: author, call: 2 })).map((f) => f.firing.rule)).toContain("perceptions-owed");
  });

  test("a rule edited in the middle of a run fires as it now reads, and one added starts firing", async () => {
    b = await bench({ chat: { "rules/each.md": "---\ndescription: Each.\nagents: all\nat: run-end\nrepeat: always\n---\nAs first written.\n" } });
    const r = await run();
    expect((await r.runEnd.due({ agent: author, call: 1 })).map((f) => f.text.trim())).toEqual(["As first written."]);
    await b.put("chat", "rules/each.md", "---\ndescription: Each.\nagents: all\nat: run-end\nrepeat: always\n---\nAs edited.\n");
    await b.put("chat", "rules/added.md", "---\ndescription: Added.\nagents: all\nat: run-end\nrepeat: always\n---\nAdded.\n");
    expect((await r.runEnd.due({ agent: author, call: 2 })).map((f) => f.text.trim())).toEqual(["Added.", "As edited."]);
  });

  test("a name nothing has, or a circle of rules, is reported, and holds the rule out of force", async () => {
    b = await bench({
      chat: {
        "rules/typo.md": "---\ndescription: Typo.\nagents: all\nneeds: TRUN\nat: run-end\n---\nText.\n",
        "rules/one.md": "---\ndescription: One.\nagents: all\nneeds: two\nat: run-end\n---\nText.\n",
        "rules/two.md": "---\ndescription: Two.\nagents: all\nneeds: rules/one\nat: run-end\n---\nText.\n",
      },
    });
    const g = loadGuidance(b.host.files, scope);
    expect((await g.rules()).map((r) => [r.name, r.why])).toEqual([
      ["one", "needs"],
      ["two", "needs"],
      ["typo", "needs"],
    ]);
    const problems = await g.problems();
    expect(problems).toContainEqual(expect.objectContaining({ path: "rules/typo.md", line: 4, message: expect.stringContaining("names TRUN, and no rule or instruction file has that name") }));
    expect(problems).toContainEqual(expect.objectContaining({ message: expect.stringContaining("goes round in a circle (one, then two, then one)") }));
  });
});

describe("when a run begins", () => {
  test("a fact or a field the drafted rules name that the plan's facts do not give is reported", async () => {
    b = await drafts();
    const problems = (await run()).problems;
    expect(problems.map((p) => [p.path, p.line, p.message])).toEqual([
      ["@shipped/.rules/history-leaving.md", 9, "The text shows {{history.leaving.range}}, and no fact gives it, so it stays empty."],
      ["@shipped/.rules/perceptions-missing.md", 9, "The text shows {{path.unperceived.list}}, and path.unperceived has no `list`: it gives its count, `names`, `by`. It stays empty."],
    ]);
  });
});
