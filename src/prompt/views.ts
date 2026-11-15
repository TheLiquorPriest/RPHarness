// The turn folder's views of the prompt (§5.3), built from the same map and the same names as the
// `prompt` tool (§4.8): the whole prompt in order with its roles and markers, the history it holds,
// every instruction slice, the persona, the character. Which file holds which part is the `views`
// list in the header of `.prompts/prompt-map.md`, so the files written follow that list. RPH is their
// one writer, from a chat's first turn, and writes them alongside the lead's run, never before it
// (§10.1): a read of a view waits for its write instead.
import type { AgentRef, FilesPort, HistoryRange, Log, Scope } from "../contract";
import type { Guidance } from "../files/api";
import { findName } from "./names";
import type { TurnPrompt } from "./prompt";
import { laid, PROMPT_PART, promptWords } from "./words";

/** One view: the file's name in the turn's folder, and its text. */
export interface PromptView {
  file: string;
  text: string;
}

/** The files the part's header names, each with the name of the part of the prompt it holds. */
async function listed(guidance: Pick<Guidance, "part">): Promise<[string, string][]> {
  const part = await guidance.part(PROMPT_PART);
  const views = part?.header["views"];
  if (typeof views !== "object" || views === null || Array.isArray(views)) return [];
  return Object.entries(views).flatMap(([file, name]) => (typeof name === "string" && file.trim() !== "" ? [[file.trim(), name] as [string, string]] : []));
}

/**
 * The views of this prompt, as `reader` (the lead) is given them. A view whose name finds nothing in
 * this prompt is not written. The history's view ends with a line for each stretch the window left
 * out of the prompt (`TurnRequest.leftOut`).
 */
export async function promptViews(prompt: TurnPrompt, guidance: Pick<Guidance, "part">, reader: AgentRef, leftOut: readonly HistoryRange[] = []): Promise<PromptView[]> {
  const [views, words] = await Promise.all([listed(guidance), promptWords(guidance)]);
  const made = await Promise.all(
    views.map(async ([file, name]) => {
      const items = await findName(prompt, name, reader);
      const missing = name.trim().toLowerCase().startsWith("history")
        ? leftOut.flatMap((range) => words("view_left_out", { from: range.from, last: range.to - 1, ...(range.covered === true ? { covered: true } : {}) }) ?? [])
        : [];
      const text = [items === undefined ? "" : laid(items, words), ...missing].filter((t) => t !== "").join("\n\n");
      return text === "" ? [] : [{ file, text }];
    }),
  );
  return made.flat();
}

/** The views' writes in the turn's folder, under way. */
export interface ViewWrites {
  /** Settles once every view is written, or its failure logged. */
  done: Promise<void>;
  /** Settles once the view at `path` (a path in the agents' view) is written, or its failure logged; at once for a path that is no view. */
  written(path: string): Promise<void>;
}

/**
 * Writes the views in the turn's folder (`Places.turn`) as they are made, as the harness writes its
 * own files there, and is not waited for: a view that cannot be made or written is logged.
 */
export function writeViews(files: FilesPort, scope: Scope, folder: string, views: Promise<readonly PromptView[]>, log: Log): ViewWrites {
  const writes = new Map<string, Promise<void>>();
  const write = async (view: PromptView): Promise<void> => {
    const written = await files.write(scope, `${folder}${view.file}`, { op: "write", text: view.text.endsWith("\n") ? view.text : `${view.text}\n` }, "harness").catch((error: unknown) => ({ status: error instanceof Error ? error.message : String(error) }));
    if (written.status !== "written") log.warn("A view of the prompt could not be written in the turn's folder.", { file: view.file, status: written.status });
  };
  const made = views.then(
    (list) => {
      for (const view of list) writes.set(`${folder}${view.file}`, write(view));
    },
    (error: unknown) => log.warn("The views of the prompt could not be made.", { error: error instanceof Error ? error.message : String(error) }),
  );
  return {
    done: made.then(async () => {
      await Promise.all(writes.values());
    }),
    written: async (path) => {
      if (!path.startsWith(folder)) return;
      await made;
      await writes.get(path);
    },
  };
}
