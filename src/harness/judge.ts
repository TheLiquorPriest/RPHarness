// The judging model of the `question:` rules (§5.4, Appendix D.1): after each message an agent
// finishes, each question rule due on it is put to a model in one call under the run's budget,
// written from `.prompts/judge.md`, whose `yes:` names the answer that fires the rule. The model is
// reached through the connection the rule's own `judge:` names, else the `rules.judge` setting's,
// else the asking agent's own. What fires goes in front of the agent as every rule's text does
// (the runner's work); the rules keep to their `repeat:`. The run waits for judgments still running
// before it keeps what the rules remembered.
import { joined } from "../agents/attachments";
import type { AgentRef, Environment, ModelsApi } from "../contract";
import type { Guidance, Question, RuleRun, TemplatePart } from "../files/api";
import { AgentRunner, type Budget, type Finished, type Judged, type Judgment, type QuestionRules, type RunTrace, type Work } from "../loop";
import type { AgentModel, ModelSource } from "../model/source";
import { type Connection, connectionOf, template } from "./means";
import { userMessage } from "./prompt";
import type { Settings } from "./settings";

/** The prompt part the judging model is sent (`.prompts/judge.md`). */
const JUDGE_PART = "judge";

export interface JudgeDeps {
  env: Pick<Environment, "log" | "clock">;
  /** The run's trace: a judge's call is shown and counted as an agent of the run. */
  trace: RunTrace;
  guidance: Guidance;
  rules: RuleRun;
  ids(): string;
  models: ModelSource;
  connections: ModelsApi;
  settings: Settings;
  /** The run's limits, which a judge's call counts against. */
  budget: Budget;
  /** The connection an agent's own model is reached through. */
  own(agent: AgentRef): Promise<Connection>;
  /** The reply `agent` released and was not yet asked about, once: what a question about the reply is put about. */
  reply?(agent: AgentRef): string | undefined;
  /** A judge's work began: the run stops it with the rest. Gives what forgets it once it ends. */
  track(entry: { runner: AgentRunner; work: Work }): () => void;
  /** A rule that fired once its agent's work had ended. */
  late(agent: AgentRef, judged: Judged): void;
}

/** Whether an answer gives the word that fires the rule: as its first word, whatever the case of its letters. */
function saysYes(answer: string, yes: string): boolean {
  const said = answer.trim().toLowerCase();
  const word = yes.trim().toLowerCase();
  return said.startsWith(word) && !/[\p{L}\p{N}]/u.test(said.charAt(word.length));
}

export class Judges implements QuestionRules {
  readonly #d: JudgeDeps;
  /** Judgments still running. */
  readonly #pending = new Set<Promise<unknown>>();
  #part: Promise<TemplatePart | undefined> | undefined;

  constructor(deps: JudgeDeps) {
    this.#d = deps;
  }

  ask(message: Finished): Judgment[] {
    const d = this.#d;
    const reply = d.reply?.(message.agent);
    const questions = d.rules.questions(message.agent, { text: message.text, ...(message.thinking !== "" ? { thinking: message.thinking } : {}), ...(reply !== undefined ? { reply } : {}) });
    return questions.map((question) => {
      const answer = this.#judge(question).then((yes) => d.rules.answered(question, yes));
      const pending = answer.catch(() => undefined);
      this.#pending.add(pending);
      void pending.finally(() => this.#pending.delete(pending));
      return { wait: question.interrupt, answer };
    });
  }

  late(agent: AgentRef, judged: Judged): void {
    this.#d.late(agent, judged);
  }

  /** Waits for every judgment still running. */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  /** One call to the judging model about the question: whether its answer gives the part's `yes:`. */
  async #judge(question: Question): Promise<boolean> {
    const d = this.#d;
    const part = await (this.#part ??= d.guidance.part(JUDGE_PART).then(template));
    const yes = part?.header["yes"];
    if (part === undefined || typeof yes !== "string" || yes.trim() === "") {
      d.env.log.warn("A rule's question cannot be put: the judging model's part, or the answer its `yes:` names, is missing.", { rule: question.rule });
      return false;
    }
    const text = joined([part.render({ question: question.question, text: question.text, about: { [question.watched]: true }, rule: question.rule }).text]);
    const named = question.judge ?? d.settings.judge;
    const connection = named !== undefined ? await connectionOf(d.connections, d.trace.scope.user, d.settings, { model: named }, d.env.log) : await d.own(question.agent);
    let model: AgentModel;
    try {
      model = await d.models.agentModel(connection.choice);
    } catch (error) {
      d.env.log.warn("A rule's question has no model to be put to.", { rule: question.rule, connection: connection.label, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    const runner = new AgentRunner({
      agent: { id: d.ids(), definition: question.agent.definition, parent: question.agent.id },
      trace: d.trace,
      model: model.model,
      streamFn: model.streamFn,
      connection: connection.label,
      session: d.trace.scope.session,
      thinkingLevel: model.thinkingLevel,
      texts: { continueAfterRule: () => "" },
      turn: d.budget,
    });
    const work = runner.start({ messages: [userMessage(text, d.env.clock.now())] });
    const untrack = d.track({ runner, work });
    const outcome = await work.done.finally(untrack);
    return outcome.status === "done" && saysYes(outcome.text, yes);
  }
}
