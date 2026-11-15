// Whose session a request carries (§11: each agent's session its own; §10.2: the cached front is the
// lead's). Only the lead's own calls carry the scene's session id, the save call before a compaction
// among them; the judging model's question, the compaction's summary call and the writer each send
// an id of their own, made when the call or the agent starts, and each is let go when its run ends.
// Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { RecordedRequest } from "../../src/testing/rig";
import { S1, SAVE, SAVE_RULE, SAVE_TEXT, played, turn } from "../sessions/support";
import { type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const QUESTION = "Does the lead promise a reward?";
const RULE = `---\ndescription: Fixture - a reward promised.\nagents: [lead]\nscope: [text]\nquestion: ${QUESTION}\n---\nFixture rule: promise nothing.\n`;
const LEAD = "---\nname: lead\ndescription: Fixture lead that hands the prose to a writer.\nmodel: default\ntools: [todo, write_reply, reply_release]\nwriter: narrator\ngiven:\n  - prompt:*\n  - session:carry\n  - briefing\n---\nFixture lead: you run the turn.\n";
const NARRATOR_MARK = "Fixture narrator: write from the brief.";
const NARRATOR = `---\nname: narrator\ndescription: Fixture writer.\nmodel: default\ntools: []\n---\n${NARRATOR_MARK}\n`;

/** Whose call a request is. */
type RequestKind = "judge" | "save" | "writer" | "summary" | "lead";

/** What a request is, by what it carries. */
function kindOf(req: RecordedRequest): RequestKind {
  const texts = req.messages.map((message) => textOf(message));
  if (texts.some((text) => text.includes(QUESTION))) return "judge";
  if (texts.some((text) => text.includes(SAVE_TEXT))) return "save";
  if (texts.some((text) => text.includes(NARRATOR_MARK))) return "writer";
  return req.tools.length === 0 ? "summary" : "lead";
}

test("a turn with a question rule, a compaction and a writer: the judge's, the summarizer's and the writer's requests carry ids that are not the lead's session id, each let go when its call ends; the save call's request carries the lead's", async () => {
  let leadCalls = 0;
  const respond = (req: RecordedRequest) => {
    switch (kindOf(req)) {
      case "judge":
        return { pieces: [{ text: "No." }] };
      case "save":
        return { pieces: [{ call: "todo", args: { items: [{ text: "keep the tide" }] } }] };
      case "writer":
        return { pieces: [{ text: "The tide turns at nine." }] };
      case "summary":
        return { pieces: [{ text: "Fixture summary." }] };
      case "lead":
        leadCalls += 1;
        if (leadCalls <= 3) return played(leadCalls);
        return leadCalls === 4 ? { pieces: [{ call: "write_reply", args: { brief: "Tell the tide." } }] } : { pieces: [{ call: "reply_release", args: { closing: true } }] };
    }
  };
  // Each session let go, with how many trace records had come by then.
  const ended: { session: string; records: number }[] = [];
  const s = (open = await stage({
    config: "compaction:\n  keepTurns: 2\n",
    files: { ".agents/lead.md": LEAD, ".agents/narrator.md": NARRATOR, [SAVE_RULE]: SAVE, ".rules/fixture-reward.md": RULE },
    answers: Array.from({ length: 20 }, () => respond),
    ended: (session) => ended.push({ session, records: s.trace.records.length }),
  }));

  for (const [id, parent] of [["t1"], ["t2", "t1"], ["t3", "t2"]] as const) expect((await s.turn(turn(id, parent !== undefined ? { parent } : {}))).outcome.status).toBe("released");
  await s.harness.sessions!.compact(S1);
  const { outcome } = await s.turn(turn("t4", { parent: "t3" }));
  expect(outcome).toMatchObject({ status: "released", form: "narrator", reply: "The tide turns at nine." });
  expect(s.trace.of("compacted").map((record) => record.scope.turn)).toEqual(["t4"]);

  const sessions = (kind: RequestKind): (string | undefined)[] => s.model.requests.filter((req) => kindOf(req) === kind).map((req) => req.options.sessionId);
  // The lead's own calls, the save call among them, carry the scene's session id.
  expect(sessions("lead")).toHaveLength(5);
  expect(new Set(sessions("lead"))).toEqual(new Set([S1.session]));
  expect(sessions("save")).toEqual([S1.session]);
  // The others each carry one of their own: one per judge's question, one per summary call, one for the writer.
  const others = [...sessions("judge"), ...sessions("summary"), ...sessions("writer")];
  expect(sessions("judge")).toHaveLength(3);
  expect(sessions("summary")).toHaveLength(1);
  expect(sessions("writer")).toHaveLength(1);
  for (const id of others) {
    expect(id).toBeDefined();
    expect(id).not.toBe(S1.session);
  }
  expect(new Set(others).size).toBe(others.length);

  // Each is let go once its run has ended, and the lead's never is.
  expect(ended.map((entry) => entry.session).sort()).toEqual([...others].sort() as string[]);
  for (const { session, records } of ended) {
    const agent = s.trace.of("agent_started").find((record) => record.event.session === session)?.agent.id;
    const over = s.trace.records.findIndex((record) => record.agent.id === agent && record.event.kind === "agent_ended");
    expect(over).toBeGreaterThanOrEqual(0);
    expect(over).toBeLessThan(records);
  }
});
