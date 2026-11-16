// The chat's own layered parts for the Prompts page (C17, C-12; §14): a prompt part, a tool's
// description or a skill read as the chat's levels give it; a part rendered with given values, or
// previewed from a draft with the values it was last rendered with for an agent of the chat; and the
// keeper of those values, which a run's guidance tells each render (`GuidanceOptions.rendered`), kept
// in the host's store by user, chat and part. Everything here reads, save the keeper's own record.

import type { Environment, FilesPort, FileText, JsonObject, JsonValue, Log, PartFileKind, PartsApi, Scope, StorePort } from "../contract/index";
import { textHash } from "../prompt/text";
import type { Fields, GuidanceOptions, PartKind, PromptPart, Template } from "./api";
import { loadGuidance } from "./guidance";
import { parsePart } from "./parts";

/** The store's key of a part's last fields in a chat. */
function fieldsKey(chat: string, kind: PartKind, name: string): string {
  return `parts/fields/${textHash(chat)}/${kind}/${name}`;
}

const KIND: Record<"prompt" | "tool", PartKind> = { prompt: "prompts", tool: "tools" };

/** Values as JSON: a field left undefined is left out. */
function asJson(fields: Fields): JsonObject {
  return JSON.parse(JSON.stringify(fields)) as JsonObject;
}

/**
 * The keeper a run's guidance is given (`GuidanceOptions.rendered`): each render's values, kept as
 * the part's last (of a part of lines, by the line's name), written to the store once the render's
 * moment has passed, so a part rendered many times in one step is written once.
 */
export function partFields(store: StorePort, scope: Scope, log: Log): NonNullable<GuidanceOptions["rendered"]> {
  const pending = new Map<string, { whole?: JsonObject; lines: Record<string, JsonObject> }>();
  let flushing = false;
  const flush = async (): Promise<void> => {
    flushing = false;
    const writes = [...pending.entries()];
    pending.clear();
    for (const [key, kept] of writes) {
      try {
        if (kept.whole !== undefined) await store.set({ user: scope.user }, key, kept.whole);
        else await store.update({ user: scope.user }, key, (current) => ({ ...(typeof current === "object" && current !== null && !Array.isArray(current) ? current : {}), ...kept.lines }));
      } catch (error) {
        log.warn("The values a part was rendered with could not be kept; its preview shows the ones before.", { key, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  return (kind, name, fields, line) => {
    const key = fieldsKey(scope.chat, kind, name);
    const kept = pending.get(key) ?? { lines: {} };
    if (line === undefined) kept.whole = asJson(fields);
    else kept.lines[line] = asJson(fields);
    pending.set(key, kept);
    if (flushing) return;
    flushing = true;
    setTimeout(() => void flush(), 0);
  };
}

/** Every field a part names, in the order first named; of a part of lines, every line's. */
function fieldsOf(part: PromptPart): string[] {
  const templates: Template[] = part.format === "template" ? [part.template] : part.names.flatMap((n) => [part.lines.get(n)].filter((t): t is Template => t !== undefined));
  return [...new Set(templates.flatMap((template) => template.fields))];
}

/** A part rendered: a template with `values`; a part of lines line by line, each with its own values where `values` holds them by the line's name, else with `values`. */
function rendered(part: PromptPart, values: JsonObject): { text: string; missing: string[] } {
  if (part.format === "template") return part.render(values);
  const missing = new Set<string>();
  const lines: string[] = [];
  for (const name of part.names) {
    const own = values[name];
    const template = part.lines.get(name);
    if (template === undefined) continue;
    const done = template.render({ ...part.header, ...(typeof own === "object" && own !== null && !Array.isArray(own) ? own : values) });
    for (const field of done.missing) missing.add(field);
    lines.push(`${name}: ${done.text}`);
  }
  return { text: lines.join("\n"), missing: [...missing] };
}

export function partsApi(env: Pick<Environment, "files" | "store">): PartsApi {
  const files: FilesPort = env.files;
  const lastFields = async (scope: Scope, kind: "prompt" | "tool", name: string): Promise<JsonObject | undefined> => {
    const value: JsonValue | undefined = await env.store.get({ user: scope.user }, fieldsKey(scope.chat, KIND[kind], name));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  };
  return {
    async read(scope, kind: PartFileKind, name) {
      const found = await loadGuidance(files, scope).layered(kind === "skill" ? "skills" : KIND[kind], name);
      if (found === undefined) return undefined;
      const why = found.off ? "off" : found.broken ? "broken" : undefined;
      return { kind, name, text: found.text, path: found.path, level: found.level, inForce: why === undefined, ...(why !== undefined ? { why } : {}) };
    },

    async render(scope, kind, name, fields) {
      const guidance = loadGuidance(files, scope);
      const part = kind === "prompt" ? await guidance.part(name) : await guidance.tool(name);
      if (part === undefined) return undefined;
      return { fields: fieldsOf(part), ...rendered(part, fields), problems: [] };
    },

    async preview(scope, kind, name, text, fields) {
      const found = await loadGuidance(files, scope).layered(KIND[kind], name);
      const given = text ?? found?.text ?? "";
      const at = { path: found?.path ?? `${name}.md`, level: found?.level ?? "chat" };
      const lines = given.split("\n").length;
      const file: FileText = { status: "read", ...at, kind: "yours", text: given, start: 1, end: lines, lines, bytes: Buffer.byteLength(given, "utf8"), hash: textHash(given), modified: 0 };
      const { part, problems } = parsePart(file, name, KIND[kind], []);
      const shown = problems.map((p) => ({ ...(p.line !== undefined ? { line: p.line } : {}), message: p.message }));
      if (part === undefined) return { fields: [], missing: [], problems: shown };
      const values = fields ?? (await lastFields(scope, kind, name)) ?? {};
      return { fields: fieldsOf(part), ...rendered(part, values), problems: shown };
    },

    lastFields,
  };
}
