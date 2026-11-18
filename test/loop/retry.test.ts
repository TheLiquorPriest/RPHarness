// A model call that failed is made again where trying again can help, whenever in the call it broke
// (the owner's word of 18 Nov): what the broken call produced leaves the transcript (no tool runs
// from a call that did not end whole), a reply some of which was shown goes on from where it ends as
// one reply with nothing twice, the broken call is booked, each try is a call against the limits, and
// a failure no try can help is never made again.
import { describe, expect, test } from "bun:test";
import { callTerms, DEFAULT_SETTINGS, type Settings } from "../../src/harness/settings";
import { TagReply } from "../../src/reply";
import { type Reply, replyMissing, rigAgent, said, SinkRecorder, textOf, tool, user } from "./support";

const author = { id: "author", definition: "author" };
const tags = { reply: "reply", intent: "intent" };
const RESET = "The connection was closed or reset: The socket connection was closed unexpectedly.";

describe("a call that broke off", () => {
  test("after some of the reply was shown: the next try goes on from where it ends, one reply with nothing twice, released, the broken call booked", async () => {
    const sink = new SinkRecorder();
    const reply = new TagReply({ tags, sink, heldSentences: 0, tailSentences: DEFAULT_SETTINGS.tailSentences });
    const missing = replyMissing(() => reply.released, "Fixture rule: the turn is ending with no reply. Write it now.");
    const lines: unknown[] = [];
    const broke: Reply = { pieces: [{ thinking: "She is afraid." }, { text: "<reply>The hall is dark. Her candle gutters. " }, { wait: 10 }], end: { error: RESET } };
    const again: Reply = { pieces: [{ text: "<reply>Her candle gutters. Something moves; the cold reaches her first.</reply>" }] };
    const texts = { continueAfterRule: () => "", continueAfterBreak: (fields: object) => (lines.push(fields), "[Go on from the break]") };
    const { runner, recorder, clock, scripted } = rigAgent(author, [broke, again], { channel: reply, runEnd: missing, texts });

    const outcome = await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);

    expect(outcome.status).toBe("done");
    expect(sink.text).toBe("The hall is dark. Her candle gutters. Something moves; the cold reaches her first.");
    expect(reply.released).toBe(true);
    expect(missing.fired).toBe(0);
    expect(lines).toEqual([{ shown: "The hall is dark. Her candle gutters. ", form: { tags: true }, tags }]);
    // Nothing of the broken call went out again: its thinking and its text left the transcript.
    const second = scripted.requests[1];
    expect(second?.messages.map((message) => textOf(message)).slice(-2)).toEqual(["She enters the hall.", "[Go on from the break]"]);
    expect(second?.messages.some((message) => message.role === "assistant")).toBe(false);
    // After the first wait, a second.
    expect((second?.at ?? 0) - 10).toBe(1_000);
    const [first] = recorder.of("call_ended").map((record) => record.event);
    expect([first?.stop, first?.error]).toEqual(["error", RESET]);
    expect(first?.usage.input).toBeGreaterThan(0);
    expect(first?.usage.output).toBeGreaterThan(0);
    expect(outcome.usage.calls).toBe(2);
  });

  test("in the middle of a tool call's arguments: no tool runs from it, and the call is made again as it was", async () => {
    let runs = 0;
    const lookup = tool("lookup", async () => {
      runs += 1;
      return said("The hall is north.");
    });
    const broke: Reply = { pieces: [{ thinking: "Where is it?" }, { callBegun: "lookup", written: '{"note":"the ha' }], end: "cut" };
    const { runner, clock, scripted } = rigAgent(author, [broke, { pieces: [{ call: "lookup", args: { note: "hall" } }] }, { pieces: [{ text: "North." }] }], { tools: [lookup] });

    const outcome = await clock.settle(runner.start({ messages: [user("Where is the hall?")] }).done);

    expect([outcome.status, outcome.text, runs]).toEqual(["done", "North.", 1]);
    expect(scripted.requests[1]?.messages).toEqual(scripted.requests[0]?.messages ?? []);
  });

  test("each time, until its tries are used up: the work fails in the last failure's words, each wait twice the last", async () => {
    const cut: Reply = { pieces: [{ text: "The hall" }], end: "cut" };
    const { runner, clock, scripted } = rigAgent(author, [cut, cut, cut]);

    const outcome = await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);

    expect([outcome.status, outcome.error, outcome.failure]).toEqual(["failed", "The stream ended before the answer did.", "model"]);
    expect(scripted.requests.map((request) => request.at)).toEqual([0, 1_000, 3_000]);
    expect(outcome.usage.calls).toBe(3);
  });

  test("each try is a call against the limits: at a limit, the work ends there", async () => {
    const { runner, clock, scripted } = rigAgent(author, [{ pieces: [], end: { error: "529: Overloaded (overloaded_error)" } }, { pieces: [{ text: "Never." }] }], { limits: { calls: 1 } });

    const outcome = await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);

    expect([outcome.status, outcome.limit?.limit, scripted.requests.length]).toEqual(["limit", "calls", 1]);
  });

  test("a failure no try can help is never made again", async () => {
    for (const error of ["401: invalid x-api-key (authentication_error)", "402: Insufficient Balance", "429: You exceeded your current quota, please check your plan and billing details. (insufficient_quota)", "400: tools.0.name: String should match pattern (invalid_request_error)"]) {
      const { runner, clock, scripted } = rigAgent(author, [{ pieces: [], end: { error } }, { pieces: [{ text: "Never." }] }]);
      const outcome = await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);
      expect([outcome.status, outcome.error, scripted.requests.length]).toEqual(["failed", error, 1]);
    }
  });
});

describe("as the settings say", () => {
  const terms = (model: Partial<Settings["model"]>) => callTerms({ ...DEFAULT_SETTINGS, model: { ...DEFAULT_SETTINGS.model, ...model } });
  const cut: Reply = { pieces: [], end: "cut" };

  test("the waits grow as set and never pass the longest; a provider's asked wait is kept to; a kind switched off is never made again", async () => {
    const grown = rigAgent(author, [cut, cut, cut, cut], { terms: terms({ retries: 3, retryWait: 1_000, retryGrowth: 3, retryMost: 5_000 }) });
    await grown.clock.settle(grown.runner.start({ messages: [user("Go.")] }).done);
    expect(grown.scripted.requests.map((request) => request.at)).toEqual([0, 1_000, 4_000, 9_000]);

    const busy: Reply = { pieces: [], end: { error: "429: Rate limit reached for requests. Please try again in 6.5s. (rate_limit_error)" } };
    const asked = rigAgent(author, [busy, { pieces: [{ text: "Here." }] }]);
    const answered = await asked.clock.settle(asked.runner.start({ messages: [user("Go.")] }).done);
    expect([answered.status, asked.scripted.requests.map((request) => request.at)]).toEqual(["done", [0, 6_500]]);

    const off = rigAgent(author, [cut, { pieces: [{ text: "Never." }] }], { terms: terms({ retryOn: { ...DEFAULT_SETTINGS.model.retryOn, connection: false } }) });
    const failed = await off.clock.settle(off.runner.start({ messages: [user("Go.")] }).done);
    expect([failed.status, off.scripted.requests.length]).toEqual(["failed", 1]);
  });
});
