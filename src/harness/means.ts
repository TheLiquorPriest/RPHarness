// What a turn's run and a job's run (§13.5) both make their agents with: a part of a given
// format, a tool's file as the tool takes it, the texts the runners send a model from the tool
// answers' file, and the connection a definition names.
import { joined } from "../agents/attachments";
import type { Log, ModelsApi, Scope } from "../contract";
import type { AgentDefinition, LinesPart, PromptPart, TemplatePart } from "../files/api";
import type { RunnerTexts } from "../loop";
import { connectionNamed } from "../model/runs-on";
import type { UserChoice } from "../model/source";
import { invalidFields, type ToolText, type Words } from "../tools";

export function template(part: PromptPart | undefined): TemplatePart | undefined {
  return part?.format === "template" ? part : undefined;
}

export function lines(part: PromptPart | undefined): LinesPart | undefined {
  return part?.format === "lines" ? part : undefined;
}

/** A tool's file as the tool takes it: its body for the model, and its header's `arguments`. */
export function toolTextOf(part: PromptPart | undefined): ToolText | undefined {
  const body = template(part);
  if (body === undefined) return undefined;
  const given = body.header["arguments"];
  const args: Record<string, string> = {};
  if (typeof given === "object" && given !== null && !Array.isArray(given)) {
    for (const [name, text] of Object.entries(given)) if (typeof text === "string") args[name] = text;
  }
  return { description: joined([body.render().text]), arguments: args };
}

/**
 * The texts a run's runners send a model, each from a file: the line an agent goes on under after a
 * rule stopped its call (`continue-after-rule`), how the `closing` argument is described, and the
 * tool answers' lines for a call that could not run or whose tool failed; a call that does not fit
 * its tool is given its tool's whole schema only where it is no longer than `schemaShown`.
 */
export function runnerTexts(words: Words, goOn: TemplatePart | undefined, closing: string | undefined, schemaShown: number): RunnerTexts {
  return {
    continueAfterRule: (fields) => joined([goOn?.render(fields).text ?? ""]),
    ...(closing !== undefined && closing !== "" ? { closing } : {}),
    notFound: (fields) => words("not_held", fields),
    invalid: (fields) => words("invalid", invalidFields(fields, schemaShown)),
    cutShort: (fields) => words("cut_short", fields),
    failed: (fields) => words("failed", fields),
    unfinished: (fields) => words("unfinished", fields),
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

/** The connection a definition (or a rule's `judge:`) names among the scope's user's connections (`connectionNamed`): `default` (or none) is his default connection; any other name is a connection's name or id. The choice carries the run's scope, so its calls read the model layer's settings at its chat's levels. The effort is the definition's alone (READINGS N-7): where it names none, the connection's own. */
export async function connectionOf(connections: ModelsApi, scope: Scope, definition: Pick<AgentDefinition, "model" | "effort">, log: Log): Promise<Connection> {
  const named = definition.model === undefined || definition.model === "default" ? null : definition.model;
  const list = await connections.list(scope.user).catch((error: unknown) => {
    log.warn("The connections could not be listed.", { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  });
  const view = list === undefined ? undefined : connectionNamed(list, definition.model);
  const id = view?.id ?? named;
  const name = view?.name ?? named;
  return {
    choice: { user: scope.user, scope, connectionId: named === null ? null : id, model: null, ...(definition.effort !== undefined ? { effort: definition.effort } : {}) },
    id: id ?? null,
    name,
    label: name ?? "default",
  };
}
