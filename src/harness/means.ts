// What a turn's run and a job's run (§13.5) both make their agents with: a part of a given
// format, a tool's file as the tool takes it, the texts the runners send a model from the tool
// answers' file, and the connection a definition names.
import { joined } from "../agents/attachments";
import type { Log, ModelsApi, RunScope } from "../contract";
import type { AgentDefinition, LinesPart, PromptPart, TemplatePart } from "../files/api";
import type { RunnerTexts } from "../loop";
import { connectionNamed } from "../model/runs-on";
import type { UserChoice } from "../model/source";
import { invalidFields, type ToolText, type Words } from "../tools";
import { agentEffort, type Settings } from "./settings";

export function template(part: PromptPart | undefined): TemplatePart | undefined {
  return part?.format === "template" ? part : undefined;
}

export function lines(part: PromptPart | undefined): LinesPart | undefined {
  return part?.format === "lines" ? part : undefined;
}

/** A tool's file as the tool takes it: its body for the model, its header's `arguments`, and its header's `doing` for a person. */
export function toolTextOf(part: PromptPart | undefined): ToolText | undefined {
  const body = template(part);
  if (body === undefined) return undefined;
  const given = body.header["arguments"];
  const args: Record<string, string> = {};
  if (typeof given === "object" && given !== null && !Array.isArray(given)) {
    for (const [name, text] of Object.entries(given)) if (typeof text === "string") args[name] = text;
  }
  const doing = body.header["doing"];
  return { description: joined([body.render().text]), arguments: args, ...(typeof doing === "string" && doing.trim() !== "" ? { doing: doing.trim() } : {}) };
}

/**
 * The texts a run's runners send a model, each from a file: the line an agent goes on under after a
 * rule stopped its call (`continue-after-rule`) and after its call broke off and is made again
 * (`continue-after-break`), and the tool answers' lines for a call that could not run or whose tool
 * failed; a call that does not fit its tool is given its tool's whole schema only where it is no
 * longer than `schemaShown`.
 */
export function runnerTexts(words: Words, goOn: TemplatePart | undefined, broke: TemplatePart | undefined, schemaShown: number): RunnerTexts {
  return {
    continueAfterRule: (fields) => joined([goOn?.render(fields).text ?? ""]),
    continueAfterBreak: (fields) => joined([broke?.render(fields).text ?? ""]),
    notFound: (fields) => words("not_held", fields),
    invalid: (fields) => words("invalid", invalidFields(fields, schemaShown)),
    cutShort: (fields) => words("cut_short", fields),
    failed: (fields) => words("failed", fields),
    unfinished: (fields) => words("unfinished", fields),
    notStarted: (fields) => words("not_started", fields),
    pastAnswerCount: (fields) => words("past_answer_count", fields),
    pastMessageCount: (fields) => words("past_message_count", fields),
    said: (fields) => words("said", fields),
  };
}

/** A definition's connection, as its header names it among the user's connections: the choice for the model layer, and the connection's id and name where they are known. */
export interface Connection {
  choice: UserChoice;
  id: string | null;
  name: string | null;
  /** How the trace names it. */
  label: string;
}

/**
 * The connection a definition (or a rule's `judge:`) names among the scope's user's connections
 * (`connectionNamed`): `default` (or none) is his default connection; any other name is a
 * connection's name or id. The choice carries the run's scope, so its calls read the model layer's
 * settings at its chat's levels. The effort is the one the settings and its header give an agent of
 * the definition (`agentEffort`); where they give none, the connection's own. A judging call is no
 * agent's (`settings` undefined): the definition's effort alone.
 */
export async function connectionOf(connections: ModelsApi, scope: RunScope, definition: Pick<AgentDefinition, "model" | "effort" | "toolsAs"> & { name?: string }, log: Log, settings: Pick<Settings, "agents" | "efforts"> | undefined): Promise<Connection> {
  const named = definition.model === undefined || definition.model === "default" ? null : definition.model;
  const list = await connections.list(scope.user).catch((error: unknown) => {
    log.warn("The connections could not be listed.", { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  });
  const view = list === undefined ? undefined : connectionNamed(list, definition.model);
  const id = view?.id ?? named;
  const name = view?.name ?? named;
  const effort = settings === undefined ? definition.effort : agentEffort(settings, definition, { id: id ?? null, name });
  return {
    choice: { user: scope.user, scope, connectionId: named === null ? null : id, model: null, ...(effort !== undefined ? { effort } : {}), ...(definition.toolsAs !== undefined ? { toolsAs: definition.toolsAs } : {}) },
    id: id ?? null,
    name,
    label: name ?? "default",
  };
}
