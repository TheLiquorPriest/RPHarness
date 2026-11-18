// A turn whose model call failed (the owner's word of 18 Nov): made again, the player sees one reply
// with nothing twice and a progress line that says the call is tried again; the trace shows each
// failed try; with its tries used up, the failure says how many tries were made and the last cause.
import { expect, test } from "bun:test";
import { gate, request, stage, WatchedSink } from "./support";

/** No wait between tries, so the turn needs no clock moved. */
const NO_WAIT = "calls:\n  retryWaitSeconds: 0\n";
const RESET = "The connection was closed or reset: The socket connection was closed unexpectedly.";

test("a call reset part-way through the reply: one reply, nothing twice, a progress line saying it is tried again, and the failed try in the trace", async () => {
  const s = await stage({
    config: NO_WAIT,
    answers: [
      { pieces: [{ text: "<intent>Calm first.</intent><reply>The hall is dark. Her candle gutters. " }], end: { error: RESET } },
      { pieces: [{ text: "<reply>Her candle gutters. Something moves.</reply>" }] },
    ],
  });

  const { outcome, sink } = await s.turn(request("t1", { lead: "lead" }));

  expect(outcome).toMatchObject({ status: "released", reply: "The hall is dark. Her candle gutters. Something moves." });
  expect(sink.text).toBe("The hall is dark. Her candle gutters. Something moves.");
  expect(sink.lines.map((line) => line.line)).toContain("A call to the model failed (the connection was lost). Trying again at once, try 2 of 3.");
  expect(s.trace.of("call_failed").map((record) => record.event)).toEqual([{ kind: "call_failed", call: 1, failure: "connection", words: RESET, at: "shown", tries: 1, retries: 2, retried: true, wait: 0 }]);
});

test("with its tries used up, the turn fails naming how many tries were made and what broke the last", async () => {
  const s = await stage({ config: NO_WAIT, answers: [0, 1, 2].map(() => ({ pieces: [], end: { error: "529: Overloaded (overloaded_error)" } })) });

  const { outcome } = await s.turn(request("t1", { lead: "lead" }));

  expect(outcome).toMatchObject({ status: "failed", error: { code: "provider", detail: "529: Overloaded (overloaded_error)", broke: { failure: "overloaded", tries: 3 } } });
  expect(s.trace.of("call_failed").map((record) => [record.event.tries, record.event.retried, record.event.at])).toEqual([
    [1, true, "before"],
    [2, true, "before"],
    [3, false, "before"],
  ]);
});

test("the wait before a call is made again is said in words, never as a count of seconds", async () => {
  const s = await stage({ config: "calls:\n  retryWaitSeconds: 5\n", answers: [{ pieces: [], end: { error: "529: Overloaded (overloaded_error)" } }, { pieces: [{ text: "<intent>Calm.</intent><reply>The hall is dark.</reply>" }] }] });
  const sink = new WatchedSink(s.clock);

  const turn = s.turn(request("t1", { lead: "lead" }), sink);
  await s.trace.seen((record) => record.event.kind === "call_failed");
  await s.clock.idle();
  s.clock.advance(5_000);

  expect((await turn).outcome.status).toBe("released");
  expect(sink.lines.map((line) => line.line)).toContain("A call to the model failed (the provider is busy). Trying again in 5 seconds, try 2 of 3.");
});

test("while a call has been sent and nothing of its answer has come, the chat is told the turn still works, once a minute", async () => {
  const held = gate();
  const s = await stage({ answers: [{ pieces: [{ hold: held }, { text: "<intent>Calm.</intent><reply>The hall is dark.</reply>" }] }] });
  const sink = new WatchedSink(s.clock);

  const turn = s.turn(request("t1", { lead: "lead" }), sink);
  await s.trace.seen((record) => record.event.kind === "call_started");
  await s.clock.idle();
  for (const _minute of [1, 2]) {
    s.clock.advance(60_000);
    await s.clock.idle();
  }
  expect(sink.lines.map((line) => line.line).filter((line) => line.startsWith("Still working"))).toEqual(["Still working (1:00).", "Still working (2:00)."]);
  held.open();
  expect((await turn).outcome).toMatchObject({ status: "released", reply: "The hall is dark." });
});
