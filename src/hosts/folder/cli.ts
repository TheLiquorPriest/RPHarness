#!/usr/bin/env bun
// `rph-folder`: the folder host played from the command line (§13.6, §16). Point it at a directory
// laid out as the folder host's (index.ts) and, where the tools manifest is not the directory's own
// `host/tools.json`, at a manifest, and it plays a chat with RPH:
//
//   rph-folder <dir> [--manifest <file>] [--chat <id>] [--user <name>] [--lead <definition>] [--carry continuing|records|nothing] <command>
//
//   say "<message>"          the owner's message, then a turn: the reply streams to stdout, progress to stderr, and is kept as the chat's next message
//   swipe                    the last reply leaves the path and the turn is played again
//   jobs [list]              the user's jobs; jobs start <agent> "<brief>"; jobs hold|letgo|again|resume|cancel <id>;
//                            jobs carry <id> [--calls N] [--tokens N] [--tokens-in N] [--tokens-out N] [--time S]; jobs answer <id> on|end
//   sessions [list]          the chat's sessions; sessions close|reopen|compact (the scene's session)
//   waiting                  everything that runs a command or calls out, and where each stands
//   allow <name>, deny <name>  the only way a command, an address, a server, a hook or a moved connection is switched on or off
//   answer [<call> yes|no [reason]]  the questions a lane set to Confirm waits on, or an answer to one
//   connections             the user's connections, each with its newest tag check; connect <name> --provider <p> [--model m] [--base-url u] [--api a] [--auth key|none] [--default], the key on stdin
//   tagcheck <connection>   whether a connection keeps the reply's tags: a job that plays `.prompts/tag-check.md`'s turns on it and sets its form
//   secret <name>            a secret his tools and servers send, its value on stdin (nothing: taken away)
//
// The chat is `--chat`, or the one chat under `host/chats/`. The user is `--user`, or the one its
// `chat.json` names, or the one the host keeps records for. The lead is `--lead`, or the `lead`
// setting. A turn's prompt is `host/chats/<chat>/system.md`, where there is one, then each message of
// the chat's path the chat does not hide. Before anything else every command lists the user's jobs,
// so a job a cut-off process left under way is kept as interrupted, and says so; and before it ends
// it waits for the jobs it left running, which an interrupt leaves to be resumed.

import { access, appendFile, cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChatRole, Harness, JobLimits, JobView, JobRefusal, PromptMessage, ReplySink, Scope, SwitchableKind, SwitchState } from "../../contract/index";
import { isRecord } from "../../contract/json";
import { loadGuidance } from "../../files/index";
import { createHarness } from "../../harness/index";
import { readSettings } from "../../harness/settings/index";
import { SHIPPED_GUIDANCE } from "../../harness/shipped";
import { placeOf } from "../../model/place";
import { readJson, readLines, readText, writeJson, writeWhole } from "./disk";
import { createFolderHost, type FolderHost } from "./index";
import type { GivenMessage } from "./shape";
import { chatRecord, storedMessage } from "./shape";
import { Site } from "./site";
import { setSwitch } from "./switches";

const USAGE = `rph-folder <dir> [--manifest <file>] [--chat <id>] [--user <name>] [--lead <definition>] [--carry continuing|records|nothing] <command>
commands: say "<message>" | swipe | jobs [list|start|hold|letgo|again|resume|cancel|carry|answer] | sessions [list|close|reopen|compact] | waiting | allow <name> | deny <name> | answer [<call> yes|no [reason]] | connections | connect <name> --provider <p> | tagcheck <connection> | secret <name>`;

/** How often the jobs left running are looked at while the command waits for them. */
const JOB_LOOK_MS = 500;

class Usage extends Error {}

interface Args {
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    // `--default` alone takes no value.
    if (name === "default") {
      flags.set(name, "yes");
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Usage(`--${name} needs a value.`);
    flags.set(name, value);
    i++;
  }
  return { positional, flags };
}

/** A message of the chat's path as `messages.jsonl` keeps it, with the turn a reply answered. */
interface Line {
  id: string;
  role: ChatRole;
  name: string;
  text: string;
  hidden: boolean;
  turn?: string;
  at?: number;
}

function shortId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

function firstLine(text: string | undefined, most = 120): string {
  const line = (text ?? "").trim().split("\n")[0] ?? "";
  return line.length > most ? `${line.slice(0, most - 1)}…` : line;
}

function jobLine(job: JobView): string {
  return `${job.id}  ${job.state.padEnd(11)}  ${job.agent}  ${firstLine(job.brief, 60)}${job.limit !== undefined ? `  (stopped at ${job.limit.limit} ${job.limit.value}/${job.limit.max})` : ""}`;
}

function isRefusal(value: JobView | JobRefusal): value is JobRefusal {
  return "refused" in value;
}

function said(value: JobView | JobRefusal | undefined, id: string): void {
  if (value === undefined) err(`No job ${id}.`);
  else if (isRefusal(value)) err(`Refused: ${value.refused} ${JSON.stringify({ ...value, refused: undefined })}`);
  else out(jobLine(value));
}

/** The folder, the chat and the user a command acts on, with the host and the harness made over them. */
class Played {
  readonly dir: string;
  readonly site: Site;
  readonly host: FolderHost;
  readonly harness: Harness;
  readonly user: string;
  readonly chat: string;
  readonly character: string;
  readonly flags: Map<string, string>;
  readonly stop = new AbortController();
  #session: string | undefined;

  constructor(dir: string, user: string, chat: string, character: string, host: FolderHost, flags: Map<string, string>) {
    this.dir = dir;
    this.user = user;
    this.chat = chat;
    this.character = character;
    this.host = host;
    this.flags = flags;
    this.site = new Site(dir, user);
    // A Confirm says what it waits on, and how to answer it, as it starts to wait.
    const approvals = host.approvals;
    this.harness = createHarness({
      ...host,
      ...(approvals !== undefined
        ? {
            approvals: {
              permission: (scope, lane) => approvals.permission(scope, lane),
              ask: (scope, ask, signal) => {
                err(`? ${ask.tool} asks to write to ${ask.lane}: ${JSON.stringify(ask.args)}`);
                err(`  answer with: rph-folder ${dir} answer ${ask.callId} yes|no [reason]`);
                return approvals.ask(scope, ask, signal);
              },
            },
          }
        : {}),
    });
  }

  get records(): string {
    return this.site.chatRecords(this.chat);
  }

  get messagesPath(): string {
    return join(this.records, "messages.jsonl");
  }

  async messages(): Promise<Line[]> {
    const path = this.messagesPath;
    return (await readLines(path)).map((raw, i) => {
      const m = storedMessage(`${path} line ${i + 1}`, raw);
      const turn = isRecord(raw) && typeof raw.turn === "string" ? raw.turn : undefined;
      return { ...m, ...(turn !== undefined ? { turn } : {}) };
    });
  }

  async keep(line: Line): Promise<void> {
    await appendFile(this.messagesPath, `${JSON.stringify(line)}\n`, "utf8");
  }

  /** The scene's session: the newest open one of the chat's, or a new one where none is open. */
  async session(): Promise<string> {
    if (this.#session !== undefined) return this.#session;
    const latest = await this.latestScene();
    if (latest !== undefined && latest.state === "open") this.#session = latest.id;
    else {
      const id = shortId("s");
      await this.harness.sessions.open({ user: this.user, chat: this.chat, session: id });
      this.#session = id;
    }
    return this.#session;
  }

  async latestScene() {
    let after: string | undefined;
    let latest;
    for (;;) {
      const page = await this.harness.sessions.list(this.user, this.chat, after !== undefined ? { after } : {});
      for (const s of page.sessions) if (s.kind === "scene" && s.offPath !== true) latest = s;
      if (page.next === undefined) return latest;
      after = page.next;
    }
  }

  async scope(turn?: string): Promise<Scope> {
    return { user: this.user, chat: this.chat, session: await this.session(), ...(turn !== undefined ? { turn } : {}) };
  }

  /** The newest turn on the path whose reply the chat keeps. */
  async latestTurn(): Promise<string | undefined> {
    return (await this.messages()).findLast((m) => m.turn !== undefined)?.turn;
  }

  async lead(scope: Scope): Promise<string> {
    const named = this.flags.get("lead");
    if (named !== undefined) return named;
    const settings = await readSettings(loadGuidance(this.host.files, scope), this.host, scope);
    if (settings.lead === undefined) throw new Usage("Name the definition that leads with --lead, or set `turn.lead` in a config file.");
    return settings.lead;
  }

  /** Plays a turn on the chat as its path stands: the reply streamed, and kept as the chat's next message once released. */
  async play(kind: "new" | "swipe"): Promise<boolean> {
    const lines = await this.messages();
    const turn = shortId("t");
    const scope = { ...(await this.scope()), turn };
    const parent = lines.findLast((m) => m.turn !== undefined)?.turn ?? null;
    const system = await readText(join(this.records, "system.md"));
    const given: GivenMessage[] = [
      ...(system !== undefined && system.trim() !== "" ? [{ role: "system" as const, content: system, kind: "other" as const }] : []),
      ...lines.flatMap((m, index): GivenMessage[] => (m.hidden ? [] : [{ role: m.role, content: m.text, name: m.name, kind: "history", source: { id: m.id, index } }])),
    ];
    const prompt: PromptMessage[] = given.map(({ role, content, name }) => ({ role, content, ...(name !== undefined ? { name } : {}) }));
    await this.host.givePrompt(scope, { messages: given });
    const carry = this.flags.get("carry") ?? "continuing";
    if (carry !== "continuing" && carry !== "records" && carry !== "nothing") throw new Usage("--carry is continuing, records or nothing.");
    let streamed = false;
    const sink: ReplySink = {
      progress: (line) => err(`· ${line}`),
      content: (delta) => {
        streamed = true;
        process.stdout.write(delta);
      },
      finish: () => {
        if (streamed) process.stdout.write("\n");
      },
      error: (e) => err(`The reply failed: ${e.code}${e.limit !== undefined ? ` (${e.limit.limit} ${e.limit.value}/${e.limit.max} per ${e.limit.per})` : ""}${e.hook !== undefined ? ` (hook ${e.hook})` : ""}${e.agent !== undefined ? ` (${e.agent})` : ""}${e.detail !== undefined ? `: ${e.detail}` : ""}`),
    };
    const outcome = await this.harness.answer({ scope, parent, kind, lead: await this.lead(scope), prompt, briefing: [], carry, since: [] }, sink, this.stop.signal);
    if (outcome.released && outcome.reply !== "") {
      await this.keep({ id: shortId("m"), role: "assistant", name: this.character, text: outcome.reply, hidden: false, turn, at: Date.now() });
      err(`· ${outcome.usage.calls} calls, ${outcome.usage.input} tokens in, ${outcome.usage.output} out`);
      return true;
    }
    // A turn that kept nothing is dropped from the path, as a host drops it.
    await this.harness.turnLeft(scope);
    await this.host.turnLeft(scope);
    err(`No reply was kept (${outcome.status}). \`swipe\` plays the turn again.`);
    return false;
  }

  /** Each job the store held as under way before this command, now kept as interrupted, said. */
  async markInterrupted(): Promise<void> {
    const underWay = (await this.host.store.jobs.list({ user: this.user }, { states: ["running"] })).jobs;
    await this.harness.jobs.list({ user: this.user, limit: 1 });
    for (const was of underWay) {
      const job = await this.harness.jobs.get(this.user, was.id);
      if (job?.state === "interrupted") err(`Job ${job.id} (${job.agent}) was cut off when its process ended, and is kept as interrupted: \`jobs resume ${job.id}\` goes on from where it stood.`);
    }
  }

  /** Waits for the jobs left queued or running to end, saying how each ended; an interrupt stops the wait. */
  async waitForJobs(): Promise<void> {
    const open = async () => (await this.harness.jobs.list({ user: this.user, states: ["queued", "running"] })).jobs;
    let left = await open();
    if (left.length === 0) return;
    err(`Waiting for ${left.length} job(s) to end; an interrupt leaves them to be resumed.`);
    while (left.length > 0 && !this.stop.signal.aborted) {
      await Bun.sleep(JOB_LOOK_MS);
      const now = await open();
      for (const job of left) {
        if (now.some((j) => j.id === job.id)) continue;
        const ended = await this.harness.jobs.get(this.user, job.id);
        if (ended !== undefined) err(`Job ${ended.id} ${ended.state}: ${firstLine(ended.report)}`);
      }
      left = now;
    }
  }

  async close(): Promise<void> {
    await this.harness.close();
    await this.host.close();
  }
}

/** The chat a command acts on: `--chat`, or the one chat the host keeps. */
async function chatOf(dir: string, flags: Map<string, string>): Promise<string> {
  const named = flags.get("chat");
  if (named !== undefined) return named;
  const chats = (await readdir(join(dir, "host", "chats"), { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);
  if (chats.length === 1 && chats[0] !== undefined) return chats[0];
  throw new Usage(chats.length === 0 ? `${dir} holds no chat: make host/chats/<chat>/chat.json.` : `Name the chat with --chat: ${chats.join(", ")}.`);
}

/** The user a command acts for: `--user`, or the chat's, or the one the host keeps records for. */
async function userOf(dir: string, chat: string, flags: Map<string, string>): Promise<{ user: string; character: string }> {
  const path = join(dir, "host", "chats", chat, "chat.json");
  const raw = await readJson(path);
  if (raw === undefined) throw new Usage(`${path} is not there.`);
  const record = chatRecord(path, raw);
  const named = flags.get("user") ?? record.user;
  if (named !== undefined) return { user: named, character: record.character };
  const kept: string[] = [];
  for (const d of await readdir(join(dir, "host", "user"), { withFileTypes: true }).catch(() => [])) {
    const file = await readJson(join(dir, "host", "user", d.name, "user.json"));
    if (isRecord(file) && typeof file.user === "string") kept.push(file.user);
  }
  if (kept.length === 1 && kept[0] !== undefined) return { user: kept[0], character: record.character };
  throw new Usage("Name the user with --user.");
}

/** Everything that runs a command or calls out, and where each stands: the files', the manifest's command tools, and connections whose key waits. */
async function switchables(p: Played): Promise<{ kind: SwitchableKind; name: string; runs: string; state: SwitchState; where?: string; problem?: string }[]> {
  // Listing opens no session: the chat's files are read under its latest one, or under a name no session has yet.
  const scope: Scope = { user: p.user, chat: p.chat, session: (await p.latestScene())?.id ?? "unopened" };
  const files = (await p.harness.external.list(scope)).map((e) => ({ kind: e.kind, name: e.name, runs: e.runs, state: e.state, where: e.path, ...(e.problem !== undefined ? { problem: e.problem } : {}) }));
  const tools = await Promise.all(
    (await p.host.tools.all(scope)).flatMap((t) => (t.switchable !== undefined ? [t.switchable] : [])).map(async (s) => ({ kind: s.kind, name: s.name, runs: s.target, state: p.host.switches === undefined ? ("off" as const) : await p.host.switches.state(p.user, s), where: "the tools manifest" })),
  );
  const connections = (await p.harness.models.list(p.user)).connections.flatMap((c) => (c.key?.waiting === true ? [{ kind: "connection" as const, name: c.name, runs: placeOf(c.provider, c.baseUrl), state: "waiting" as const, where: "connections" }] : []));
  return [...files, ...tools, ...connections];
}

/** The numbers `jobs carry` gives a job more of. */
function moreOf(flags: Map<string, string>): JobLimits {
  const more: JobLimits = {};
  const take = (flag: string, key: keyof JobLimits) => {
    const value = flags.get(flag);
    if (value === undefined) return;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Usage(`--${flag} is a whole number above 0.`);
    more[key] = n;
  };
  take("calls", "calls");
  take("tokens", "tokens");
  take("tokens-in", "tokensIn");
  take("tokens-out", "tokensOut");
  take("time", "time");
  if (Object.keys(more).length === 0) throw new Usage("Say how much more: --calls, --tokens, --tokens-in, --tokens-out or --time.");
  return more;
}

async function jobs(p: Played, args: readonly string[]): Promise<void> {
  const [what = "list", id, ...rest] = args;
  const user = p.user;
  const needId = (): string => {
    if (id === undefined) throw new Usage(`jobs ${what} <id>`);
    return id;
  };
  switch (what) {
    case "list": {
      let cursor: string | undefined;
      do {
        const page = await p.harness.jobs.list({ user, ...(cursor !== undefined ? { cursor } : {}) });
        for (const job of page.jobs) out(jobLine(job));
        cursor = page.next;
      } while (cursor !== undefined);
      return;
    }
    case "start": {
      const brief = rest.join(" ");
      if (id === undefined || brief === "") throw new Usage('jobs start <agent> "<brief>"');
      const started = await p.harness.jobs.start(await p.scope(), { agent: id, brief });
      return said(started, id);
    }
    case "hold":
      return said(await p.harness.jobs.hold(user, needId()), needId());
    case "letgo":
      return said(await p.harness.jobs.letGo(user, needId()), needId());
    case "again":
      return said(await p.harness.jobs.again(user, needId()), needId());
    case "resume":
      return said(await p.harness.jobs.resume(user, needId()), needId());
    case "cancel":
      return said(await p.harness.jobs.cancel(user, needId()), needId());
    case "carry":
      return said(await p.harness.jobs.carryOn(user, needId(), moreOf(p.flags)), needId());
    case "answer": {
      const go = rest[0];
      if (go !== "on" && go !== "end") throw new Usage("jobs answer <id> on|end");
      return said(await p.harness.jobs.answer(user, needId(), go === "on" ? { go: "on" } : { go: "end" }), needId());
    }
    default:
      throw new Usage(`No jobs command ${what}.`);
  }
}

async function sessions(p: Played, args: readonly string[]): Promise<void> {
  const [what = "list"] = args;
  if (what === "list") {
    let after: string | undefined;
    for (;;) {
      const page = await p.harness.sessions.list(p.user, p.chat, after !== undefined ? { after } : {});
      for (const s of page.sessions) out(`${s.id}  ${s.kind.padEnd(5)}  ${s.state.padEnd(6)}  ${s.turns} turns${s.agent !== undefined ? `  ${s.agent}` : ""}${s.offPath === true ? "  (off the path)" : ""}${s.compactAsked === true ? "  (compaction asked)" : ""}`);
      if (page.next === undefined) return;
      after = page.next;
    }
  }
  const latest = await p.latestScene();
  if (latest === undefined) throw new Usage("The chat has no session yet.");
  const scope: Scope = { user: p.user, chat: p.chat, session: latest.id };
  const shown = (s: { id: string; state: string; compactAsked?: true }) => out(`${s.id}  ${s.state}${s.compactAsked === true ? "  (compaction asked)" : ""}`);
  if (what === "close") {
    const turn = await p.latestTurn();
    return shown(await p.harness.sessions.close(turn !== undefined ? { ...scope, turn } : scope, { by: "user" }));
  }
  if (what === "reopen") return shown(await p.harness.sessions.reopen(scope));
  if (what === "compact") return shown(await p.harness.sessions.compact(scope));
  throw new Usage(`No sessions command ${what}.`);
}

async function answer(p: Played, args: readonly string[]): Promise<void> {
  // The chat's questions, and those of the user's jobs of no chat, which wait in the host's own folder.
  const bases = [p.records, p.site.host];
  const [call, word, ...reason] = args;
  if (call === undefined) {
    for (const base of bases) {
      for (const name of (await readdir(join(base, "asks")).catch(() => [])).filter((n) => n.endsWith(".json"))) {
        const ask = await readJson(join(base, "asks", name));
        if (isRecord(ask)) out(`${String(ask.callId)}  ${String(ask.tool)} on ${String(ask.lane)}: ${JSON.stringify(ask.args)}`);
      }
    }
    return;
  }
  if (word !== "yes" && word !== "no") throw new Usage("answer <call> yes|no [reason]");
  for (const base of bases) {
    if ((await readJson(join(base, "asks", `${call}.json`))) === undefined) continue;
    await writeJson(join(base, "answers", `${call}.json`), word === "yes" ? { go: true } : { go: false, ...(reason.length > 0 ? { reason: reason.join(" ") } : {}) });
    return out(`Answered ${call}: ${word}.`);
  }
  throw new Usage(`No question ${call} waits.`);
}

async function stdinText(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  return (await Bun.stdin.text()).trim();
}

async function run(argv: readonly string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [dir, command, ...args] = positional;
  if (dir === undefined || command === undefined) throw new Usage(USAGE);
  const chat = await chatOf(dir, flags);
  const { user, character } = await userOf(dir, chat, flags);
  // A folder that has no shipped level yet is given RPH's own shipped files as it (remove `files/defaults/` to take a newer RPH's), and the chat its own folder.
  const shipped = join(dir, "files", "defaults");
  if (!(await access(shipped).then(() => true, () => false))) {
    await cp(SHIPPED_GUIDANCE, shipped, { recursive: true });
    err(`RPH's shipped files are laid in ${shipped}.`);
  }
  await mkdir(join(dir, "files", "chats", character, chat), { recursive: true });
  const manifest = flags.get("manifest");
  const host = await createFolderHost({ dir, user, ...(manifest !== undefined ? { manifest } : {}) });
  const p = new Played(dir, user, chat, character, host, flags);
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    p.stop.abort(new Error("Interrupted."));
  });
  // A turn that keeps no reply ends the command with 1.
  let code = 0;
  try {
    await p.markInterrupted();
    switch (command) {
      case "say": {
        const text = args.join(" ").trim();
        if (text === "") throw new Usage('say "<message>"');
        await p.keep({ id: shortId("m"), role: "user", name: user, text, hidden: false, at: Date.now() });
        if (!(await p.play("new"))) code = 1;
        break;
      }
      case "swipe": {
        const lines = await p.messages();
        const last = lines.at(-1);
        if (last === undefined) throw new Usage("The chat has no message to answer.");
        if (last.role === "assistant" && last.turn !== undefined) {
          await writeWhole(p.messagesPath, lines.slice(0, -1).map((m) => `${JSON.stringify(m)}\n`).join(""));
          const left = { ...(await p.scope()), turn: last.turn };
          await p.harness.turnLeft(left);
          await p.host.turnLeft(left);
          if (!(await p.play("swipe"))) code = 1;
        } else if (!(await p.play("new"))) code = 1;
        break;
      }
      case "jobs":
        await jobs(p, args);
        break;
      case "sessions":
        await sessions(p, args);
        break;
      case "waiting":
        for (const s of await switchables(p)) out(`${s.state.padEnd(7)}  ${s.kind.padEnd(12)}  ${s.name}  ${s.runs}${s.where !== undefined ? `  (${s.where})` : ""}${s.problem !== undefined ? `  ! ${s.problem}` : ""}`);
        break;
      case "allow":
      case "deny": {
        const name = args[0];
        if (name === undefined) throw new Usage(`${command} <name>`);
        const found = (await switchables(p)).filter((s) => s.name === name && (command === "deny" || s.state !== "on"));
        if (found.length === 0) throw new Usage(command === "allow" ? `Nothing named ${name} waits.` : `Nothing is named ${name}.`);
        for (const s of found) {
          await setSwitch(p.site, user, { kind: s.kind, name: s.name, target: s.runs }, command === "allow" ? "on" : "off");
          out(`${command === "allow" ? "On" : "Off"}: ${s.kind} ${s.name}${command === "allow" ? `, running exactly ${s.runs}` : ""}.`);
        }
        break;
      }
      case "answer":
        await answer(p, args);
        break;
      case "connections": {
        const [list, checks] = await Promise.all([p.harness.models.list(user), p.harness.jobs.tagChecks(user)]);
        for (const c of list.connections) {
          const check = checks.find((t) => t.connection === c.id);
          out(`${c.id}  ${c.name}  ${c.provider}${c.model !== undefined ? `  ${c.model}` : ""}${c.default ? "  (default)" : ""}${c.key === null ? "" : c.key.waiting ? "  (key waits: allow it)" : c.key.set ? "" : "  (no key)"}${check !== undefined ? `  tags kept ${check.kept}/${check.tried} on ${check.model} (${check.needed} needed): ${check.form}${check.set ? "" : ", not written to the config"}` : ""}`);
        }
        break;
      }
      case "tagcheck": {
        const connection = args[0];
        if (connection === undefined) throw new Usage("tagcheck <connection>");
        said(await p.harness.jobs.tagCheck(user, connection), connection);
        break;
      }
      case "connect": {
        const name = args[0];
        const provider = flags.get("provider");
        if (name === undefined || provider === undefined) throw new Usage("connect <name> --provider <provider> [--model m] [--base-url u] [--api a] [--auth key|none] [--default], the key on stdin");
        const auth = flags.get("auth") ?? "key";
        if (auth !== "key" && auth !== "none") throw new Usage("--auth is key or none.");
        const list = await p.harness.models.list(user);
        const existing = list.connections.find((c) => c.name === name);
        const key = auth === "key" ? await stdinText() : "";
        const saved = await p.harness.models.save(
          user,
          { ...(existing !== undefined ? { id: existing.id } : {}), name, provider, auth, baseUrl: flags.get("base-url") ?? null, api: flags.get("api") ?? null, model: flags.get("model") ?? null },
          key !== "" ? key : undefined,
        );
        if (flags.has("default") || list.default === null) await p.harness.models.setDefault(user, saved.id);
        out(`${saved.id}  ${saved.name}  ${saved.provider}${saved.key?.set === true ? "  (key set)" : ""}`);
        break;
      }
      case "secret": {
        const name = args[0];
        if (name === undefined) throw new Usage("secret <name>, its value on stdin");
        const value = await stdinText();
        await p.harness.models.setToolSecret(user, name, value === "" ? null : value);
        out(value === "" ? `Secret ${name} taken away.` : `Secret ${name} set.`);
        break;
      }
      default:
        throw new Usage(USAGE);
    }
    await p.waitForJobs();
    return code;
  } finally {
    await p.close();
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      err(error instanceof Error ? error.message : String(error));
      process.exit(error instanceof Usage ? 2 : 1);
    },
  );
}

export { run as runFolderCli };
