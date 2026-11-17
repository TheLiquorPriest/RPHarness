// A tag check (§10.7 l.1285, §14 l.1563, §18.1 row 0.2; C-20): whether one of his connections keeps
// the reply's tags, measured, as a job he starts from the Connections page. It plays the turns of
// `.prompts/tag-check.md` (a part of lines: `ask`, what the turn asks besides the reply contract, and
// each other line one simple turn the player sends; the host ships it, RPH ships none) on the
// connection, `reply.check.turns` of them, the lines taken in turn and again from the first where
// they run out. Each is a fresh turn of one call: the shipped reply contract in its tag form and the
// `ask` line, then the player's turn. A turn keeps the tags when its answer holds the reply and the
// intent record, each opened and closed by the contract's tags, and the reply not empty. A turn the
// provider failed ends the check failed, with nothing set: a failure is no measure of the tags. At
// its end the record is kept under the connection (the newest stands), and the connection's form
// written into his global config as `connections.<connection>.reply.form`: the tag form at `reply.check.kept`
// kept turns or more, else the two-step form; his to change after.

import type { AgentRef, ConnectionView, JsonObject, JsonValue, TagCheck, Usage } from "../contract";
import { isRecord } from "../contract/json";
import { loadGuidance } from "../files";
import { isMapping, normalized } from "../files/header";
import { lines, template } from "../harness/means";
import { userMessage } from "../harness/prompt";
import { callTerms, readSettings } from "../harness/settings";
import { joined } from "../agents/attachments";
import { type AgentOutcome, AgentRunner, Budget, emptyUsage, RunTrace } from "../loop";
import { TagParser, type ReplyTags } from "../reply/tags";
import type { JobAsk, JobCore, PreparedJob } from "./run";

/** The part whose lines the check plays. */
export const TAG_CHECK = "tag-check";

/** The line of the part that is what each turn asks besides the reply contract. */
const ASK = "ask";

/** Where a connection's newest check is kept, under the user. */
const RECORDS = "tagchecks/";

/** The tag names a reply contract's header gives, when it gives both. */
function tagsOf(header: Readonly<Record<string, unknown>>): ReplyTags | undefined {
  const tags = header["tags"];
  if (!isMapping(tags)) return undefined;
  const { reply, intent } = tags;
  return typeof reply === "string" && typeof intent === "string" ? { reply, intent } : undefined;
}

/** Whether an answer holds the reply, not empty, and the intent record, each opened and closed by its tag. */
export function keepsTags(text: string, tags: ReplyTags): boolean {
  const parser = new TagParser(tags);
  const closed = new Set<string>();
  let reply = "";
  for (const part of [...parser.push(text), ...parser.end()]) {
    if (part.kind === "close") closed.add(part.role);
    else if (part.kind === "text" && part.role === "reply") reply += part.text;
  }
  return closed.has("reply") && closed.has("intent") && reply.trim() !== "";
}

/** A key or a plain scalar as YAML reads it back unquoted, or the same in quotes. */
function plain(text: string): string {
  return /^[A-Za-z_][\w./@-]*$/.test(text) && !/^(?:y|n|yes|no|true|false|on|off|null)$/i.test(text) ? text : JSON.stringify(text);
}

/** A value of the config as block lines below `key`, at `indent`: mappings as blocks, anything else as one flow value. */
function block(key: string, value: JsonValue, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (isRecord(value) && Object.keys(value).length > 0) return [`${pad}${plain(key)}:`, ...Object.entries(value).flatMap(([k, v]) => block(k, v, indent + 2))];
  if (value === null) return [`${pad}${plain(key)}: ~`];
  return [`${pad}${plain(key)}: ${typeof value === "string" ? plain(value) : JSON.stringify(value)}`];
}

/**
 * The config's text with `connections.<connection>.reply.form` set to `form`: the `connections:`
 * entry written back in its place as blocks, the rest of the file as it was; added at its end where
 * the file has none. Throws, saying why, where the file is no mapping of settings.
 */
export function withForm(text: string, connection: string, form: TagCheck["form"]): string {
  const rows = normalized(text).replace(/\n+$/, "").split("\n");
  const parsed: unknown = text.trim() === "" ? {} : Bun.YAML.parse(normalized(text));
  if (parsed !== null && parsed !== undefined && !isMapping(parsed)) throw new Error("the config is not `name: value` lines");
  const config = (parsed ?? {}) as JsonObject;
  const connections = isRecord(config["connections"]) ? config["connections"] : {};
  const own = isRecord(connections[connection]) ? connections[connection] : {};
  const reply = isRecord(own["reply"]) ? own["reply"] : {};
  const written = block("connections", { ...connections, [connection]: { ...own, reply: { ...reply, form } } }, 0);
  const row = rows.findIndex((line) => /^connections[ \t]*:/.test(line));
  let out: string[];
  if (row === -1) out = [...(rows.length === 1 && rows[0] === "" ? [] : rows), ...written];
  else {
    let end = row + 1;
    while (end < rows.length && !/^(?:[^\s#-]|-\S)/.test(rows[end] ?? "")) end++;
    while (end > row + 1 && /^\s*(?:#.*)?$/.test(rows[end - 1] ?? "")) end--;
    out = [...rows.slice(0, row), ...written, ...rows.slice(end)];
  }
  return `${out.join("\n")}\n`;
}

/** The newest check of each of the user's connections that had one. */
export async function tagChecks(core: Pick<JobCore, "env">, user: string): Promise<TagCheck[]> {
  const { store } = core.env;
  const keys = await store.list({ user }, RECORDS);
  const found = await Promise.all(keys.map((key) => store.get({ user }, key)));
  return found.filter((value): value is JsonObject => isRecord(value) && typeof value["connection"] === "string").map((value) => value as unknown as TagCheck);
}

/** A tag check's run, made and ready, or the part or connection it cannot be made without. */
export async function prepareTagCheck(core: JobCore, ask: Pick<JobAsk, "id" | "scope" | "spend">, named: string): Promise<PreparedJob | { refused: "connection"; connection: string } | { refused: "part"; part: typeof TAG_CHECK | "reply-contract" }> {
  const { env } = core;
  const { scope } = ask;
  const user = scope.user;
  const guidance = loadGuidance(env.files, scope);
  const [settings, list, part, contract] = await Promise.all([readSettings(guidance, env, scope), core.connections.list(user), guidance.part(TAG_CHECK), guidance.part("reply-contract")]);
  const connection: ConnectionView | undefined = list.connections.find((c) => c.id === named || c.name === named);
  if (connection === undefined) return { refused: "connection", connection: named };
  const turns = lines(part);
  const played = turns?.names.filter((name) => name !== ASK).flatMap((name) => {
    const text = turns.line(name);
    return text === undefined || text.trim() === "" ? [] : [text];
  });
  if (played === undefined || played.length === 0) return { refused: "part", part: TAG_CHECK };
  const tagged = template(contract);
  const tags = tagged === undefined ? undefined : tagsOf(tagged.header);
  if (tagged === undefined || tags === undefined) return { refused: "part", part: "reply-contract" };
  const instructions = joined([tagged.render({ form: { tags: true } }).text, turns?.line(ASK) ?? ""]);
  const trace = new RunTrace(core.hub.tee(env.trace, scope, () => settings.liveBacklog), scope, ask.id, env.clock, core.hub.hold(ask.id));
  // What the check spends counts in his jobs' day and every agent's; the check itself is bounded by its turns.
  const everyAgent = new Budget("day", settings.day.tokens !== undefined ? { tokens: settings.day.tokens } : {}, undefined, { spent: ask.spend.all, cachedWeight: settings.cachedWeight });
  const day = new Budget("day", settings.jobs.tokensPerDay !== undefined ? { tokens: settings.jobs.tokensPerDay } : {}, everyAgent, { spent: ask.spend.jobs, cachedWeight: settings.cachedWeight });
  const budget = new Budget("job", {}, day, { cachedWeight: settings.cachedWeight });
  const ref: AgentRef = { id: ask.id, definition: TAG_CHECK, job: ask.id };

  /** The record kept, and the form written into his global config. */
  const finish = async (model: string, tried: number, kept: number): Promise<TagCheck> => {
    const form = kept >= settings.checkKept ? "tags" : "two-step";
    let set = false;
    const global = (await env.files.layers({ user })).find((layer) => layer.level === "global");
    if (global?.config !== undefined) {
      const path = `${global.mount}${global.config}`;
      try {
        const read = await env.files.read({ user }, path);
        if (read.status === "refused") throw new Error(`it could not be read (${read.reason})`);
        const written = await env.files.write({ user }, path, { op: "write", text: withForm(read.status === "read" ? read.text : "", connection.name, form) }, "owner");
        if (written.status !== "written") throw new Error(`it could not be written (${written.status === "refused" ? written.reason : written.status})`);
        set = true;
      } catch (error) {
        env.log.warn("A tag check's form could not be written into the global config; the record keeps it.", { connection: connection.name, path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const record: TagCheck = { connection: connection.id, name: connection.name, model, tried, kept, needed: settings.checkKept, form, set, at: env.clock.now(), job: ask.id };
    await env.store.set({ user }, `${RECORDS}${connection.id}`, record as unknown as JsonValue);
    return record;
  };

  return {
    settings,
    connection: { id: connection.id, name: connection.name },
    agent: ref,
    trace,
    budget,
    day,
    missing: [],
    async run(signal, hearing) {
      core.hub.started({ run: ask.id, scope, what: "job", agents: [], started: env.clock.now() });
      core.usage.begin(ask.id);
      trace.watch((record) => {
        core.usage.record(record);
        if (record.event.kind === "call_ended") hearing.spent({ ...budget.used });
      });
      trace.event(ref, undefined, { kind: "run_started", run: "job", lead: TAG_CHECK });
      let tried = 0;
      let kept = 0;
      let model = "";
      let ended: AgentOutcome = { agent: ref, status: "done", text: "", usage: emptyUsage() };
      try {
        const chosen = await core.models.agentModel({ user, scope, connectionId: connection.id, model: null });
        model = chosen.model.id;
        for (let i = 0; i < settings.checkTurns && !signal.aborted; i++) {
          // Each turn a fresh one: an agent of its own, in a session of its own, let go when it ends.
          const agent: AgentRef = { id: core.ids(), definition: TAG_CHECK, parent: ref.id, job: ask.id };
          const session = core.ids();
          const runner = new AgentRunner({ agent, trace, model: chosen.model, streamFn: chosen.streamFn, connection: connection.name, session, thinkingLevel: chosen.thinkingLevel, instructions, terms: callTerms(settings), texts: { continueAfterRule: () => "" }, turn: budget });
          const work = runner.start({ messages: [userMessage(played[i % played.length] ?? "", env.clock.now())] });
          const stop = (): void => work.stop();
          signal.addEventListener("abort", stop, { once: true });
          const outcome = await work.done.finally(() => {
            signal.removeEventListener("abort", stop);
            core.models.ended?.(user, session);
          });
          if (outcome.status !== "done") {
            ended = { ...outcome, agent: ref };
            break;
          }
          tried += 1;
          if (keepsTags(outcome.text, tags)) kept += 1;
          // Its report is its count as it stands, as figures: the host words the record (§3.4).
          hearing.text(`${kept}/${tried}`);
        }
        if (ended.status === "done" && !signal.aborted) {
          const record = await finish(model, tried, kept);
          ended = { ...ended, text: `${record.kept}/${record.tried} ${record.form}` };
        }
      } catch (error) {
        ended = { agent: ref, status: "failed", failure: "model", error: error instanceof Error ? error.message : String(error), text: "", usage: emptyUsage() };
      } finally {
        core.usage.end(ask.id);
        core.hub.ended(ask.id);
      }
      const used: Usage = { ...budget.used };
      return { outcome: { ...ended, usage: used }, usage: used, ...(ended.limit !== undefined ? { limit: ended.limit } : {}) };
    },
  };
}
