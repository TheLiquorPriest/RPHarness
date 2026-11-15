// The words the model layer sends that no agent wrote, each from a file the owner can replace at any
// level or switch off (§13.1; §17.2: every text an agent is sent is a file): the line at the head of
// a call on an Anthropic sign-in (`.prompts/signin-line.md`), the mark of a system message sent in
// its place (`.prompts/system-note.md`), the text of a connection's test (`.prompts/connection-test.md`),
// what a tool's answer with no text says (`.prompts/tool-notices.md`: `empty_answer`, and
// `pictures_answer` for one of pictures alone), and how tools offered as text, the calls to them
// and their answers read (`.prompts/tools-as-text.md`, tools-text.ts). They are read as each is
// used, at a scope's levels: an agent's chat's, or, with no chat in view, the levels every chat
// shares; a nearer file replaces a farther one. A file switched off, empty, or one that does not
// parse (listed with the files' problems) sends nothing in its place.

import type { FilesPort, Scope, UserScope } from "../contract";
import { loadGuidance } from "../files";
import type { Fields, PromptPart } from "../files/api";

/** The model layer's texts at one scope's levels. */
export interface ModelTexts {
  /** The line at the head of a call on an Anthropic sign-in; undefined: no line goes. */
  signinLine: string | undefined;
  /** What a system message is sent as in its place, from its text; undefined: its own text, unmarked. */
  markNote: ((text: string) => string) | undefined;
  /** What a connection's test sends. */
  testPrompt: string;
  /** What a tool's answer with no text says, by the tool's name; undefined: the answer goes as it is. */
  emptyAnswer: ((tool: string) => string) | undefined;
  /** What a tool's answer of pictures alone says before them, by the tool's name; undefined: the pictures go alone. */
  picturesAnswer: ((tool: string) => string) | undefined;
  /** The tools-as-text file filled in with one use's fields (tools-text.ts); undefined: tools offered as text go with no words. */
  toolsText: ((fields: Fields) => string) | undefined;
}

/** A template part's text, its fields filled in; undefined for a part that is not there, is not a template, or says nothing. */
function rendered(part: PromptPart | undefined, fields?: Record<string, string>): string | undefined {
  if (part?.format !== "template") return undefined;
  const text = part.render(fields).text.trimEnd();
  return text.trim() === "" ? undefined : text;
}

/** A line of a lines part as a text by the tool's name; undefined where the part holds no such line. */
function lineOf(part: PromptPart | undefined, name: string): ((tool: string) => string) | undefined {
  if (part?.format !== "lines" || !part.names.includes(name)) return undefined;
  return (tool) => part.line(name, { tool }) ?? "";
}

/** The model layer's texts as the scope's levels give them now. */
export async function modelTexts(files: FilesPort, scope: Scope | UserScope): Promise<ModelTexts> {
  const guidance = loadGuidance(files, scope);
  const [signin, note, test, notices, tools] = await Promise.all([guidance.part("signin-line"), guidance.part("system-note"), guidance.part("connection-test"), guidance.part("tool-notices"), guidance.part("tools-as-text")]);
  return {
    signinLine: rendered(signin),
    markNote: note?.format === "template" ? (text) => note.render({ text }).text.trimEnd() : undefined,
    testPrompt: rendered(test) ?? "",
    emptyAnswer: lineOf(notices, "empty_answer"),
    picturesAnswer: lineOf(notices, "pictures_answer"),
    toolsText: tools?.format === "template" ? (fields) => tools.render(fields).text.trim() : undefined,
  };
}
