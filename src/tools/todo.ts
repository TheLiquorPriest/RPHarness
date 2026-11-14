// `todo` (§6.8): the agent's own list of the steps it set itself for this turn, ticked as it goes.
// Nothing in code waits on it. The list is shown in the live view, and its open items are a fact a
// rule can test (`todo.open`).
import type { AgentRef, TodoItem } from "../contract";
import { answer, argumentsOf, fieldsOf, type OwnTool, type ToolText, type Words } from "./kit";

/** Each agent's list in one run, by the agent's handle. */
export class TodoLists {
  readonly #lists = new Map<string, TodoItem[]>();

  get(agent: string): readonly TodoItem[] {
    return this.#lists.get(agent) ?? [];
  }

  set(agent: string, items: TodoItem[]): void {
    this.#lists.set(agent, items);
  }
}

export interface TodoDeps {
  lists: TodoLists;
  words: Words;
  text: ToolText | undefined;
  /** The list changed: for the live view. */
  changed(agent: AgentRef, items: readonly TodoItem[]): void;
}

export function todo(deps: TodoDeps): OwnTool {
  return {
    name: "todo",
    family: "todo",
    tier: "read",
    description: deps.text?.description ?? "",
    parameters: argumentsOf(
      {
        items: {
          type: "array",
          items: { type: "object", properties: { text: { type: "string" }, done: { type: "boolean" } }, required: ["text"] },
        },
      },
      ["items"],
      deps.text,
    ),
    async run(args, ctx) {
      const given = fieldsOf(args)["items"];
      const items: TodoItem[] = (Array.isArray(given) ? given : []).flatMap((item) => {
        const fields = fieldsOf(item);
        const itemText = fields["text"];
        return typeof itemText === "string" ? [{ text: itemText, done: fields["done"] === true }] : [];
      });
      deps.lists.set(ctx.agent.id, items);
      deps.changed(ctx.agent, items);
      const open = items.filter((item) => !item.done).length;
      return answer(deps.words("todo", { open, done: items.length - open }));
    },
  };
}
