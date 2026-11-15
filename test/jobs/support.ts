// What the tests of jobs and judges share when they run a harness of their own over a stage: its
// folder host, its trace and what its host is told, with models scripted for one user that keep
// every choice they were asked for, so a test fails where a choice names another user. Everything
// here is invented.
import type { Environment, Harness, JobRefusal, JobView, TurnOutcome, TurnRequest } from "../../src/contract";
import { createHarness } from "../../src/index";
import { type ScriptedModel, type ScriptedSource, scriptedSource } from "../../src/testing/rig";
import { type Stage, USER, WatchedSink } from "../harness/support";

/** A harness over the stage's host, its models the rig's for `USER` alone, each by its name (the empty name is the default connection's), under a counted id of its own. */
export function userHarness(s: Stage, models: Readonly<Record<string, ScriptedModel>>, env: Partial<Environment> = {}): { harness: Harness; source: ScriptedSource } {
  const source = scriptedSource(models, USER);
  let next = 0;
  const harness = createHarness({ ...s.env, ...env }, { models: source, ids: () => `own-${(next += 1)}` });
  return { harness, source };
}

/** One turn on `harness`, given its prompt as the stage gives it, and run to its end. */
export async function turnOn(s: Stage, harness: Harness, req: TurnRequest, signal: AbortSignal = new AbortController().signal): Promise<{ outcome: TurnOutcome; sink: WatchedSink }> {
  await s.host.givePrompt(req.scope, { messages: req.prompt });
  const sink = new WatchedSink(s.clock);
  const outcome = await harness.answer(req, sink, signal);
  return { outcome, sink };
}

/** The job a start made: a test whose start was refused fails here, with the refusal as it was given. */
export function jobOf(answer: JobView | JobRefusal): JobView {
  if ("refused" in answer) throw new Error(`The start was refused: ${JSON.stringify(answer)}`);
  return answer;
}
