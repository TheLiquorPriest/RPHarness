// The guidance of one scope (§5): every kind of file, read through the host's `FilesPort` at its
// levels, the nearest of a name in force and what config switches off kept off; and from them an
// agent's definition and stack, the files pinned for it, the skills' index, prompt parts, tool
// descriptions, the rules as the Rules page lists them, and one run's rule engine. Each file is read
// and parsed once.

import type { DefinitionView, FileRead, FileText, FilesPort, Found as FoundFiles, LayerLevel, Refused, RuleView, Scope, StackLeft, SwitchesPort, UserScope } from "../contract/index";
import type { AgentDefinition, Fields, Guidance, GuidanceOptions, LoadGuidance, ManifestRead, PartKind, Problem, PromptPart, Replaced, RuleRun, RuleRunOptions, Skill, SkillEntry, Stack, StackEntry, ToolManifest } from "./api";
import { limitsWritten, parseDefinition } from "./definitions";
import { createRuleRun } from "./engine";
import type { HookEntry } from "../external/hooks";
import { normalized, problemAt, WrittenItems } from "./header";
import { HOOKS_FILE, parseHooks } from "./hooks";
import { parseManifest } from "./manifest";
import { type McpRead, parseMcp } from "./mcp";
import { parsePart } from "./parts";
import type { ReadRule, Rule } from "./rules";
import { parseRule } from "./rules";
import { parseSkill } from "./skills";
import { holdsNothing } from "./stack";
import type { FileRef, InstructionsList, Listing } from "./tree";
import { itemKey, LEVEL_ORDER, stoppedWhy, Tree, writtenKey } from "./tree";

/** The name a definition's `reads:` gives the always-on rules it is named in (§5.2 part 2): `reads: [ALL-AGENTS, rules, …]`. */
const RULES = "rules";

/** His MCP servers' file in the tools folders, `<tools>/mcp.json`: not a tool's manifest. */
const MCP = "mcp";

/**
 * The parts of a stack a definition's `reads:` names that come before the definition, in §5.2's
 * order: 1 `ALL-AGENTS`; 2 the always-on rules; 3 `AGENTS`; 4 `WORLD`, `SIMULATION`, `WRITING`.
 * `reads:` chooses among the parts; it does not order them.
 */
const BEFORE_DEFINITION: readonly string[] = ["ALL-AGENTS", RULES, "AGENTS", "WORLD", "SIMULATION", "WRITING"];

/** The parts that come after the definition (§5.2 part 6), in that order. */
const AFTER_DEFINITION: readonly string[] = ["TURN", "PRESET"];

/**
 * The name a definition's `given:` gives the briefing by. The files added for the turn (§5.2 part
 * 7) come with the briefing, so they are in the stack of an agent that is given it.
 */
const BRIEFING = "briefing";

/** The nearest file of a name, the farther files it replaces, whether its name is switched off, the file as read, and what it was read as. */
interface Found<T> {
  ref: FileRef;
  replaces: Replaced[];
  off: boolean;
  /** Absent when it could not be read (the tree's problems say why). */
  file?: FileText;
  /** Absent when it could not be read, or is broken. */
  item?: T;
}

/** An instruction file, and why it is left out of a stack, if it is. */
interface Instruction extends Found<string> {
  left?: StackLeft;
}

/** An instruction file with why it is left out: its name switched off, the file unreadable, or nothing in it but headings and comments. */
function withLeft(found: Found<string>): Instruction {
  const left: StackLeft | undefined = found.off ? "off" : found.file === undefined ? "broken" : holdsNothing(found.file.text) ? "empty" : undefined;
  return { ...found, ...(left !== undefined ? { left } : {}) };
}

/** What a `stack.instructions` entry adds to the stacks it reaches, and what is wrong with it. */
interface Added {
  entries: StackEntry[];
  problems: Problem[];
}

interface RuleState {
  found: Found<ReadRule>;
  inForce: boolean;
  why?: "off" | "needs" | "broken";
}

export const loadGuidance: LoadGuidance = (files, scope, options) => new TreeGuidance(files, scope, options);

class TreeGuidance implements Guidance {
  readonly scope: Scope | UserScope;
  readonly #files: FilesPort;
  readonly #tree: Tree;
  readonly #options: GuidanceOptions;
  /** What parsing found, each file's once. */
  readonly #problems: Problem[] = [];
  readonly #memo = new Map<string, Promise<unknown>>();

  constructor(files: FilesPort, scope: Scope | UserScope, options: GuidanceOptions = {}) {
    this.scope = scope;
    this.#files = files;
    this.#tree = new Tree(files, scope);
    this.#options = options;
  }

  #once<T>(key: string, make: () => Promise<T>): Promise<T> {
    let made = this.#memo.get(key) as Promise<T> | undefined;
    if (made === undefined) {
      made = make();
      this.#memo.set(key, made);
    }
    return made;
  }

  layers() {
    return this.#tree.layers();
  }

  /** The nearest file of a name in a listing, read with `read` once. */
  #found<T>(listing: Listing, name: string, read: (file: FileText, replaces: Replaced[]) => { item?: T | undefined; problems: Problem[] }): Promise<Found<T> | undefined> {
    return this.#once(`found ${listing}/${name}`, async () => {
      const refs = (await this.#tree.found(listing)).get(name);
      const ref = refs?.[refs.length - 1];
      if (refs === undefined || ref === undefined) return undefined;
      const replaces = refs.slice(0, -1).map((r) => ({ level: r.level, path: r.path }));
      const off = (await this.#tree.config()).off.has(itemKey(listing, name));
      const file = await this.#tree.read(ref.path);
      if (file === undefined) return { ref, replaces, off };
      const parsed = read(file, replaces);
      this.#problems.push(...parsed.problems);
      return { ref, replaces, off, file, ...(parsed.item !== undefined ? { item: parsed.item } : {}) };
    });
  }

  async #definition(name: string): Promise<Found<AgentDefinition> | undefined> {
    // Every definition's name, at any level, against which the reader checks what a `writer:` names (§10.6).
    const agents = await this.#tree.found("agents");
    return this.#found("agents", name, (file, replaces) => {
      const { definition, problems } = parseDefinition(file, name, replaces, agents);
      return { item: definition, problems };
    });
  }

  #skill(name: string): Promise<Found<Skill> | undefined> {
    return this.#found("skills", name, (file, replaces) => {
      const { skill, problems } = parseSkill(file, name, replaces);
      return { item: skill, problems };
    });
  }

  #part(kind: PartKind, name: string): Promise<Found<PromptPart> | undefined> {
    const rendered = this.#options.rendered;
    return this.#found(kind, name, (file, replaces) => {
      const { part, problems } = parsePart(file, name, kind, replaces);
      if (part === undefined || rendered === undefined) return { item: part, problems };
      // Each render tells the values it was rendered with, so the page previews the part with them (C17).
      if (part.format === "template")
        return {
          item: {
            ...part,
            render: (fields?: Fields) => {
              rendered(kind, name, fields ?? {});
              return part.render(fields);
            },
          },
          problems,
        };
      return {
        item: {
          ...part,
          line: (line: string, fields?: Fields) => {
            rendered(kind, name, fields ?? {}, line);
            return part.line(line, fields);
          },
        },
        problems,
      };
    });
  }

  async layered(kind: PartKind | "skills", name: string): Promise<{ text: string; path: string; level: LayerLevel; off: boolean; broken: boolean } | undefined> {
    const found = kind === "skills" ? await this.#skill(name) : await this.#part(kind, name);
    if (found === undefined) return undefined;
    return { text: found.file?.text ?? "", path: found.ref.path, level: found.ref.level, off: found.off, broken: found.item === undefined };
  }

  #manifest(name: string): Promise<Found<ToolManifest> | undefined> {
    return this.#found("manifests", name, (file) => {
      const { manifest, problems } = parseManifest(file, name);
      return { item: manifest, problems };
    });
  }

  #rule(listing: "rules" | "examples", name: string): Promise<Found<ReadRule> | undefined> {
    return this.#found(listing, name, (file, replaces) => {
      const read = parseRule(file, name, replaces);
      return { item: read, problems: read.problems };
    });
  }

  /**
   * The instruction files in force by a name: the nearest; or, for a name in `stack.layered`, the file of
   * every level that has one, farther first, none replacing another. Each says why it is left out,
   * if it is. None when no level has the name.
   */
  async #instructions(name: string): Promise<Instruction[]> {
    const config = await this.#tree.config();
    if (!config.layered.has(name)) {
      const found = await this.#found("instructions", name, (file) => ({ item: file.text, problems: [] }));
      return found === undefined ? [] : [withLeft(found)];
    }
    const off = config.off.has(itemKey("instructions", name));
    const refs = (await this.#tree.found("instructions")).get(name) ?? [];
    return Promise.all(
      refs.map(async (ref) => {
        const file = await this.#tree.read(ref.path);
        return withLeft({ ref, replaces: [], off, ...(file !== undefined ? { file, item: file.text } : {}) });
      }),
    );
  }

  /** Whether an item a `needs:` names that is not a rule is in force: an instruction file (any of a layered one's levels), or `<kind>/<name>` (as `writtenKey` gives it). Undefined: nothing has that name. */
  async #otherInForce(key: string): Promise<boolean | undefined> {
    const slash = key.indexOf("/");
    if (slash === -1) {
      const files = await this.#instructions(key);
      return files.length === 0 ? undefined : files.some((f) => f.left === undefined);
    }
    const kind = key.slice(0, slash);
    const name = key.slice(slash + 1);
    const found = kind === "agents" ? await this.#definition(name) : kind === "skills" ? await this.#skill(name) : kind === "prompts" || kind === "tools" ? await this.#part(kind, name) : undefined;
    return found === undefined ? undefined : found.item !== undefined && !found.off;
  }

  /** Every rule (not the examples), in force or not, by name: off, broken, or held by a `needs:` that is not in force, followed through other rules. */
  #ruleStates(): Promise<Map<string, RuleState>> {
    return this.#once("rule states", async () => {
      const names = [...(await this.#tree.found("rules")).keys()].sort();
      const found = new Map<string, Found<ReadRule>>();
      for (const [name, f] of await Promise.all(names.map(async (n) => [n, await this.#rule("rules", n)] as const))) if (f !== undefined) found.set(name, f);
      // A `needs:` name is read the way a `stack.off` entry is: `perceptions`, `rules/perceptions`, `TURN`, `TURN.md`.
      const layers = await this.layers();
      const ruleNamed = (need: string): string | undefined => {
        const key = writtenKey(need, layers);
        const bare = key.startsWith(`${RULES}/`) ? key.slice(RULES.length + 1) : key;
        return found.has(bare) ? bare : undefined;
      };
      // Everything else a `needs:` names is looked at first, so the walk below waits on nothing.
      const others = new Map<string, boolean | undefined>();
      for (const f of found.values()) {
        for (const need of f.item?.rule?.needs ?? []) if (ruleNamed(need) === undefined && !others.has(need)) others.set(need, await this.#otherInForce(writtenKey(need, layers)));
      }
      const states = new Map<string, RuleState>();
      const visit = (name: string, chain: readonly string[]): RuleState => {
        const done = states.get(name);
        if (done !== undefined) return done;
        const f = found.get(name) as Found<ReadRule>;
        const rule = f.item?.rule;
        let state: RuleState;
        if (rule === undefined) state = { found: f, inForce: false, why: "broken" };
        else if (f.off) state = { found: f, inForce: false, why: "off" };
        else {
          const at = { path: f.ref.path, level: f.ref.level };
          let held = false;
          for (const need of rule.needs) {
            const other = ruleNamed(need);
            if (other === undefined) {
              const inForce = others.get(need);
              if (inForce === undefined) this.#problems.push(problemAt(at, rule.lines.needs, `\`needs:\` names ${need}, and no rule or instruction file has that name, so this rule is not in force.`));
              if (inForce !== true) held = true;
            } else if ([...chain, name].includes(other)) {
              this.#problems.push(problemAt(at, rule.lines.needs, `\`needs:\` goes round in a circle (${[...chain, name, other].join(", then ")}), so none of those rules is in force.`));
              held = true;
            } else if (!visit(other, [...chain, name]).inForce) held = true;
          }
          state = held ? { found: f, inForce: false, why: "needs" } : { found: f, inForce: true };
        }
        states.set(name, state);
        return state;
      };
      // In the order of their names, whatever order the walk met them in.
      return new Map([...found.keys()].map((name) => [name, visit(name, [])] as const));
    });
  }

  async problems(): Promise<Problem[]> {
    const [lists, config] = await Promise.all([Promise.all((["instructions", "agents", "skills", "prompts", "tools", "examples", "manifests"] as const).map(async (l) => [l, [...(await this.#tree.found(l)).keys()]] as const)), this.#tree.config()]);
    const loads: Promise<unknown>[] = [this.#ruleStates(), this.#mappedToNobody(), this.#pinned(), this.hooks()];
    for (const [listing, names] of lists) {
      for (const name of names) {
        if (listing === "instructions") loads.push(this.#instructions(name));
        else if (listing === "agents") loads.push(this.#definition(name));
        else if (listing === "skills") loads.push(this.#skill(name));
        else if (listing === "examples") loads.push(this.#rule("examples", name));
        else if (listing === "manifests") loads.push(name === MCP ? this.#mcp() : this.#manifest(name));
        else loads.push(this.#part(listing, name));
      }
    }
    for (const list of config.instructions) for (const at of list.entries.keys()) loads.push(this.#listed(list, at));
    for (const name of lists.find(([listing]) => listing === "agents")?.[1] ?? []) loads.push(this.#readsNothing(name));
    await Promise.all(loads);
    return [...this.#tree.problems, ...this.#problems];
  }

  async definition(name: string): Promise<AgentDefinition | undefined> {
    const found = await this.#definition(name);
    return found === undefined || found.off ? undefined : found.item;
  }

  async pins(agent: string): Promise<{ file: string; problem?: Problem }[]> {
    const config = await this.#tree.config();
    const problems = await this.#pinned();
    return config.pins.flatMap((pin, i) => {
      if (pin.agent !== agent) return [];
      const problem = problems.find((p) => p.at === i)?.problem;
      return [{ file: pin.file, ...(problem !== undefined ? { problem } : {}) }];
    });
  }

  /**
   * What is wrong with the levels' pins, each by its place in the list: a pin for an agent no
   * definition has, or a pinned file that is not where a run looks for it (the chat's folder, or
   * failing that the turn's, as `attach` finds a `file:` name). Neither stops a run: the agent is
   * handed what is there, and the Files page and each run that misses it say what is not. Checked once.
   */
  #pinned(): Promise<{ at: number; problem: Problem }[]> {
    return this.#once("pins", async () => {
      const [agents, config] = await Promise.all([this.#tree.found("agents"), this.#tree.config()]);
      const scope = this.scope;
      const files = this.#tree.files;
      // Its first line is enough to know it is there; the run reads it whole.
      const there = async (path: string): Promise<FileRead> => {
        const read = await files.read(scope, path, { start: 1, end: 1 });
        if (read.status !== "missing" || !("chat" in scope)) return read;
        const turn = (await files.places(scope)).turn;
        return turn === undefined || path.startsWith(turn) ? read : files.read(scope, `${turn}${path}`, { start: 1, end: 1 });
      };
      const checked = await Promise.all(
        config.pins.map(async (pin): Promise<string | undefined> => {
          if (!agents.has(pin.agent)) return `\`stack.pins\` pins ${pin.file} for ${pin.agent}, and no agent definition has that name, so nobody is handed it.`;
          try {
            const read = await there(pin.file);
            if (read.status === "read") return undefined;
            if (read.status === "refused") return `The host refused to read the file pinned for ${pin.agent}, ${pin.file} (${read.reason}), so ${pin.agent} is handed nothing for it.`;
            return `The file pinned for ${pin.agent}, ${pin.file}, is not there, so ${pin.agent} is handed nothing for it.`;
          } catch (error) {
            return `The file pinned for ${pin.agent}, ${pin.file}, could not be read (${error instanceof Error ? error.message : String(error)}), so ${pin.agent} is handed nothing for it.`;
          }
        }),
      );
      const found = config.pins.flatMap((pin, at) => {
        const message = checked[at];
        return message === undefined ? [] : [{ at, problem: problemAt(pin.at, pin.line, message) }];
      });
      this.#problems.push(...found.map((f) => f.problem));
      return found;
    });
  }

  async definitions(): Promise<DefinitionView[]> {
    const names = [...(await this.#tree.found("agents")).keys()].sort();
    const out: DefinitionView[] = [];
    for (const found of await Promise.all(names.map((n) => this.#definition(n)))) {
      const d = found?.item;
      if (found === undefined || d === undefined) continue;
      out.push({
        name: d.name,
        description: d.description,
        path: d.source.path,
        level: d.source.level,
        replaces: d.replaces,
        off: found.off,
        ...(d.model !== undefined ? { model: d.model } : {}),
        ...(d.effort !== undefined ? { effort: d.effort } : {}),
        ...(d.limits !== undefined && Object.keys(d.limits).length > 0 ? { limits: limitsWritten(d.limits) } : {}),
        ...(d.toolsAs !== undefined ? { toolsAs: d.toolsAs } : {}),
        tools: [...d.tools],
        reads: [...d.reads],
        given: [...d.given],
        ...(d.writer !== undefined ? { writer: d.writer } : {}),
      });
    }
    return out;
  }

  /** Where a missing definition would be: the nearest level's folder of definitions. */
  async #wouldBe(name: string): Promise<Pick<StackEntry, "path" | "level">> {
    const layers = await this.layers();
    for (const layer of [...layers].reverse()) {
      const folder = layer.folders.agents?.replace(/\/+$/, "");
      if (folder !== undefined) return { path: `${layer.mount}${folder}/${name}.md`, level: layer.level };
    }
    return { path: `${name}.md`, level: "chat" };
  }

  async #instructionEntries(name: string, where: StackEntry["where"]): Promise<StackEntry[]> {
    const files = await this.#instructions(name);
    if (files.length === 0) {
      const chat = (await this.layers()).find((l) => l.level === "chat");
      return [{ part: name, kind: "instruction", where, path: `${chat?.mount ?? ""}${name}.md`, level: "chat", replaces: [], left: "missing" }];
    }
    const layered = (await this.#tree.config()).layered.has(name);
    return files.map((f) => ({
      part: name,
      kind: "instruction",
      where,
      path: f.ref.path,
      level: f.ref.level,
      ...(f.file !== undefined ? { hash: f.file.hash } : {}),
      replaces: f.replaces,
      ...(layered ? { layered: true as const } : {}),
      ...(f.left !== undefined ? { left: f.left } : { text: f.item ?? "" }),
    }));
  }

  /**
   * What one entry of a `stack.instructions` list adds (`at`, its place in the list), read once for the
   * line it is written on: an instruction file by name, found as `reads:` finds one (`STYLE`,
   * `STYLE.md`); or the owner's files a path or a glob in the agents' view finds, in path order. An
   * entry that finds no file, or only agents' notes or generated files (they are not instructions,
   * §5.1, Y5), is a problem at its line; one that finds none is also in the stack, marked missing.
   */
  #listed(list: InstructionsList, at: number): Promise<Added> {
    const entry = list.entries[at] ?? "";
    const line = list.lines[at] ?? list.line;
    return this.#once(`instructions ${list.at.path}:${line ?? ""}\n${entry}`, async () => {
      const said = (message: string, entries: StackEntry[] = []): Added => {
        const problem = problemAt(list.at, line, message);
        this.#problems.push(problem);
        return { entries, problems: [problem] };
      };
      const notInstructions = `\`stack.instructions\` names ${entry}, which finds only agents' notes or generated files. Those are not instructions, so it adds nothing.`;
      if (!/[/*?[{]/.test(entry)) {
        const name = entry.replace(/\.md$/, "");
        const entries = await this.#instructionEntries(name, "opening");
        if ((await this.#instructions(name)).length > 0) return { entries, problems: [] };
        if ((await this.#tree.notYours("instructions")).has(name)) return said(notInstructions);
        return said(`\`stack.instructions\` names ${entry}, and no instruction file has that name, so it adds nothing.`, entries);
      }
      const path = entry.replace(/^(?:\.\/|\/)+/, "");
      const wild = path.search(/[*?[{]/);
      if (wild === -1) {
        const file = await this.#tree.read(path);
        if (file !== undefined && file.kind !== "yours") return said(notInstructions);
        const entries = [await this.#fileEntry(path, file, "missing")];
        // A file the host refused or failed to read is a problem of the read's own.
        if (file !== undefined || this.#tree.problems.some((problem) => problem.path === path)) return { entries, problems: [] };
        return said(`\`stack.instructions\` names ${entry}, and no file is there, so it adds nothing.`, entries);
      }
      // A glob looks below the folders it names before its first wildcard: under a mount, in that level alone (`FilesPort.find`).
      const slash = path.lastIndexOf("/", wild);
      const where = slash === -1 ? { pattern: path } : { path: path.slice(0, slash), pattern: path.slice(slash + 1) };
      let found: FoundFiles | Refused;
      try {
        // Every file it matches: the owner's own list, not an agent's search, so no find limit cuts it.
        found = await this.#tree.files.find(this.scope, { by: "glob", ...where, limit: Number.POSITIVE_INFINITY });
      } catch (error) {
        return said(`\`stack.instructions\` names ${entry}, which could not be looked for (${error instanceof Error ? error.message : String(error)}), so it adds nothing.`);
      }
      if (found.status === "refused") return said(`The host refused to look for ${entry} (${found.reason}), so \`stack.instructions\` adds nothing for it.`);
      const files = found.hits.filter((hit) => hit.type === "file");
      const yours = files.filter((hit) => hit.kind === "yours");
      // A search the host cut is said (R-183), with what it found before it stopped.
      const cut = found.stopped === undefined ? undefined : `The host stopped looking for ${entry} ${stoppedWhy(found.stopped)}, so \`stack.instructions\` adds only the files it found before then.`;
      if (yours.length === 0) return said(cut ?? (files.length === 0 ? `\`stack.instructions\` names ${entry}, and no file matches it, so it adds nothing.` : notInstructions));
      const entries = await Promise.all(yours.map(async (hit) => this.#fileEntry(hit.path, await this.#tree.read(hit.path), "broken")));
      return cut === undefined ? { entries, problems: [] } : said(cut, entries);
    });
  }

  /** An owner's file `stack.instructions` names by path, as a part of a stack; `unread` says why it is left out when it could not be read. */
  async #fileEntry(path: string, file: FileText | undefined, unread: "missing" | "broken"): Promise<StackEntry> {
    const layers = await this.layers();
    if (file === undefined) return { part: path, kind: "instruction", where: "opening", path, level: layers.find((l) => l.mount !== "" && path.startsWith(l.mount))?.level ?? "chat", replaces: [], left: unread };
    const off = (await this.#tree.config()).off.has(writtenKey(file.path, layers));
    const f = withLeft({ ref: { name: file.path, path: file.path, level: file.level }, replaces: [], off, file, item: file.text });
    return { part: file.path, kind: "instruction", where: "opening", path: file.path, level: file.level, hash: file.hash, replaces: [], ...(f.left !== undefined ? { left: f.left } : { text: file.text }) };
  }

  /** What the levels' `stack.instructions` add to `agent`'s stack, the farther level's lists first, each in its order: the lists for every agent when its definition reads an instruction file, and those for it by name. */
  async #addedFor(agent: string, readsInstructions: boolean): Promise<Added> {
    const lists = (await this.#tree.config()).instructions.filter((list) => (list.agent === undefined ? readsInstructions : list.agent === agent));
    const added = await Promise.all(lists.flatMap((list) => list.entries.map((_, at) => this.#listed(list, at))));
    return { entries: added.flatMap((a) => a.entries), problems: added.flatMap((a) => a.problems) };
  }

  /** Each agent a `stack.instructions` mapping gives a list to that no definition has: that list reaches no stack. Checked once. */
  #mappedToNobody(): Promise<void> {
    return this.#once("instructions for nobody", async () => {
      const [agents, config] = await Promise.all([this.#tree.found("agents"), this.#tree.config()]);
      for (const list of config.instructions) {
        if (list.agent !== undefined && !agents.has(list.agent)) this.#problems.push(problemAt(list.at, list.line, `\`stack.instructions\` gives a list to ${list.agent}, and no agent definition has that name, so the list reaches no stack.`));
      }
    });
  }

  /**
   * Each name a definition's `reads:` gives that no instruction file has: a problem at the line the
   * name is written on, beside the stack's part marked missing. §5.2's own parts (`ALL-AGENTS`, the
   * rules, `AGENTS`, `WORLD`, `SIMULATION`, `WRITING`, `TURN`, `PRESET`) are aside: a chat starts
   * without them and gains them as the owner writes or accepts them, so one not yet written is no
   * mistake. Checked once for each definition.
   */
  #readsNothing(agent: string): Promise<void> {
    return this.#once(`reads ${agent}`, async () => {
      const found = await this.#definition(agent);
      const def = found?.item;
      if (found === undefined || def === undefined || found.off || found.file === undefined) return;
      const at = { path: found.file.path, level: found.file.level };
      const written = new WrittenItems(normalized(found.file.text).split("\n"), "reads", 1);
      for (const read of def.reads) {
        const line = written.find(read) ?? written.field;
        const name = read.replace(/\.md$/, "");
        if (BEFORE_DEFINITION.includes(name) || AFTER_DEFINITION.includes(name) || (await this.#instructions(name)).length > 0) continue;
        this.#problems.push(problemAt(at, line, `\`reads:\` names ${read}, and no instruction file has that name, so ${agent}'s stack has nothing for it.`));
      }
    });
  }

  /** The always-on rules naming `agent`, in force or not: those for every turn in the opening block, or those whose `turns:` name the situations at hand for the briefing. Shipped first, then global, character, chat; by name within a level. */
  async #ruleEntries(agent: string, where: StackEntry["where"], situations?: readonly string[]): Promise<StackEntry[]> {
    const out: StackEntry[] = [];
    for (const [name, state] of await this.#ruleStates()) {
      const read = state.found.item;
      const rule = read?.rule;
      const agents = rule?.agents ?? read?.agents ?? [];
      if ((rule?.when.trigger ?? read?.trigger) !== "always" || (agents !== "all" && !agents.includes(agent))) continue;
      const turns = rule?.turns;
      if (where === "opening" ? turns !== undefined : turns === undefined) continue;
      const these = turns === undefined || situations === undefined ? turns : turns.filter((t) => situations.includes(t));
      if (these !== undefined && these.length === 0) continue;
      out.push({
        part: itemKey("rules", name),
        kind: "rule",
        where,
        path: state.found.ref.path,
        level: state.found.ref.level,
        ...(state.found.file !== undefined ? { hash: state.found.file.hash } : {}),
        replaces: state.found.replaces,
        ...(state.inForce && rule !== undefined ? { text: rule.text.text } : { left: state.why ?? "broken" }),
        ...(these !== undefined ? { situations: these } : {}),
      });
    }
    return out.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || (a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
  }

  async stack(agent: string, options: { situations?: readonly string[] } = {}): Promise<Stack> {
    const entries: StackEntry[] = [];
    // The problems of the `stack.instructions` entries that reach this stack: a run's start logs them. A pin's are its own (`pins`).
    const reached: Problem[] = [];
    const found = await this.#definition(agent);
    await this.#readsNothing(agent);
    const def = found?.item;
    if (found === undefined || def === undefined || found.off) {
      const where = found === undefined ? await this.#wouldBe(agent) : { path: found.ref.path, level: found.ref.level, ...(found.file !== undefined ? { hash: found.file.hash } : {}) };
      entries.push({ part: itemKey("agents", agent), kind: "definition", where: "opening", ...where, replaces: found?.replaces ?? [], left: found === undefined ? "missing" : found.off ? "off" : "broken" });
    } else {
      // `reads:` chooses the parts and §5.2 orders them, whatever order `reads:` names them in. A file
      // is given once however often it is named, and the definition's own file only as part 5 (R-105).
      const reads = [...new Set(def.reads.map((read) => read.replace(/\.md$/, "")))];
      const given = new Set([def.source.path]);
      const add = (list: readonly StackEntry[]): void => {
        for (const entry of list) {
          if (given.has(entry.path)) continue;
          given.add(entry.path);
          entries.push(entry);
        }
      };
      const part = (name: string): Promise<StackEntry[]> => (name === RULES ? this.#ruleEntries(agent, "opening") : this.#instructionEntries(name, "opening"));
      for (const name of BEFORE_DEFINITION) if (reads.includes(name)) add(await part(name));
      // The files the levels' `stack.instructions` add, then each instruction file `reads:` names that §5.2
      // does not number, in `reads:`'s order: after part 4, before the definition. A file the config's
      // `stack.added` table adds for a turn (§5.2 part 7: `SWIPE`, `DELETE`) is the briefing's alone, given
      // on the turns it is for, never in the opening block.
      const config = await this.#tree.config();
      const forTurns = new Set([...config.added.values()].flat());
      const listed = await this.#addedFor(agent, reads.some((read) => read !== RULES));
      add(listed.entries);
      reached.push(...listed.problems);
      for (const name of reads) if (!BEFORE_DEFINITION.includes(name) && !AFTER_DEFINITION.includes(name) && !forTurns.has(name)) add(await part(name));
      entries.push({ part: itemKey("agents", agent), kind: "definition", where: "opening", path: def.source.path, level: def.source.level, hash: def.source.hash, replaces: def.replaces, text: def.instructions.text });
      for (const name of AFTER_DEFINITION) if (reads.includes(name)) add(await part(name));
      if (def.given.includes(BRIEFING)) {
        const wanted = options.situations;
        const added = new Map<string, string[]>();
        for (const [situation, names] of config.added) {
          if (wanted !== undefined && !wanted.includes(situation)) continue;
          for (const name of names) added.set(name, [...(added.get(name) ?? []), situation]);
        }
        for (const [name, situations] of added) entries.push(...(await this.#instructionEntries(name, "briefing")).map((e) => ({ ...e, situations })));
        entries.push(...(await this.#ruleEntries(agent, "briefing", wanted)));
      }
    }
    const paths = new Set(entries.map((e) => e.path));
    const own = [...this.#tree.problems, ...this.#problems].filter((p) => paths.has(p.path));
    return { agent, entries, problems: [...own, ...reached.filter((p) => !own.includes(p))] };
  }

  async skills(): Promise<SkillEntry[]> {
    const names = [...(await this.#tree.found("skills")).keys()].sort();
    return (await Promise.all(names.map((n) => this.#skill(n)))).flatMap((found) => {
      const skill = found?.item;
      return found === undefined || skill === undefined || found.off ? [] : [{ name: skill.name, description: skill.description, source: skill.source, replaces: skill.replaces }];
    });
  }

  async skill(name: string): Promise<Skill | undefined> {
    const found = await this.#skill(name);
    return found === undefined || found.off ? undefined : found.item;
  }

  async part(name: string): Promise<PromptPart | undefined> {
    const found = await this.#part("prompts", name);
    return found === undefined || found.off ? undefined : found.item;
  }

  async tool(name: string): Promise<PromptPart | undefined> {
    const found = await this.#part("tools", name);
    return found === undefined || found.off ? undefined : found.item;
  }

  async manifests(): Promise<ToolManifest[]> {
    const names = [...(await this.#tree.found("manifests")).keys()].filter((name) => name !== MCP).sort();
    return (await Promise.all(names.map((name) => this.#manifest(name)))).flatMap((found) => (found === undefined || found.off || found.item === undefined ? [] : [found.item]));
  }

  /** Every level's `mcp.json`, farther first: a nearer server replaces a farther one of its name; every file's problems join the Files page's. `stack.off: [tools/mcp]` leaves them all out. */
  #mcp(): Promise<McpRead[]> {
    return this.#once("mcp", async () => {
      const [found, config] = await Promise.all([this.#tree.found("manifests"), this.#tree.config()]);
      if (config.off.has(itemKey("manifests", MCP))) return [];
      const servers = new Map<string, McpRead>();
      for (const ref of found.get(MCP) ?? []) {
        const file = await this.#tree.read(ref.path);
        if (file === undefined) continue;
        const read = parseMcp(file);
        this.#problems.push(...read.problems);
        for (const server of read.servers) servers.set(server.name, server);
      }
      return [...servers.values()];
    });
  }

  mcpServers(): Promise<McpRead[]> {
    return this.#mcp();
  }

  /** Every level's `hooks.yml`, farther first, each in its written order: a nearer hook replaces a farther one of its name; those `stack.off` names (`hooks/<name>`) are left out; every file's problems join the Files page's. */
  hooks(): Promise<HookEntry[]> {
    return this.#once("hooks", async () => {
      const [layers, config] = await Promise.all([this.#tree.layers(), this.#tree.config()]);
      const hooks = new Map<string, HookEntry>();
      for (const layer of layers) {
        const folder = layer.folders.hooks?.replace(/\/+$/, "");
        if (folder === undefined) continue;
        const file = await this.#tree.read(`${layer.mount}${folder}/${HOOKS_FILE}`);
        if (file === undefined) continue;
        const read = parseHooks(file);
        this.#problems.push(...read.problems);
        for (const hook of read.hooks) {
          hooks.delete(hook.name);
          hooks.set(hook.name, hook);
        }
      }
      return [...hooks.values()].filter((hook) => !config.off.has(`hooks/${hook.name}`));
    });
  }

  async manifestFiles(): Promise<ManifestRead[]> {
    const names = [...(await this.#tree.found("manifests")).keys()].filter((name) => name !== MCP).sort();
    const out: ManifestRead[] = [];
    for (const found of await Promise.all(names.map((name) => this.#manifest(name)))) {
      if (found === undefined || found.off) continue;
      const { name, path, level } = found.ref;
      // A file the tree could not read says why among the tree's problems as well.
      const read = found.file === undefined ? undefined : parseManifest(found.file, name);
      out.push({ name, path, level, ...(read?.manifest !== undefined ? { manifest: read.manifest } : {}), ...(read?.written !== undefined ? { written: read.written } : {}), problems: read === undefined ? ["The file could not be read."] : read.problems.map((p) => p.message) });
    }
    return out;
  }

  async rule(name: string): Promise<Rule | undefined> {
    const found = (await this.#ruleStates()).get(name)?.found ?? (await this.#rule("examples", name));
    return found?.item?.rule;
  }

  async rules(switches?: SwitchesPort): Promise<RuleView[]> {
    const user = this.scope.user;
    const view = async (f: Found<ReadRule>, inForce: boolean, why: RuleView["why"]): Promise<RuleView> => {
      const when = f.item?.rule?.when;
      const runs = when?.trigger === "moment" ? when.command : undefined;
      // A rule's command stands as the host's switches say, asked as it is listed: without them it is off.
      const state = runs === undefined ? undefined : switches === undefined ? "off" : await switches.state(user, { kind: "rule-command", name: f.ref.name, target: runs });
      return {
        name: f.ref.name,
        path: f.ref.path,
        level: f.ref.level,
        description: f.item?.description ?? "",
        agents: f.item?.agents ?? [],
        ...(f.item?.trigger !== undefined ? { trigger: f.item.trigger } : {}),
        ...(runs !== undefined && state !== undefined ? { command: { runs, state } } : {}),
        inForce,
        ...(why !== undefined ? { why } : {}),
        replaces: f.replaces,
      };
    };
    const views = await Promise.all([...(await this.#ruleStates()).values()].map((s) => view(s.found, s.inForce, s.why)));
    for (const name of [...(await this.#tree.found("examples")).keys()].sort()) {
      const found = await this.#rule("examples", name);
      if (found !== undefined) views.push(await view(found, false, found.item?.rule === undefined ? "broken" : "example"));
    }
    return views;
  }

  /** The triggered rules in force (`always` rules are the stack's), as this read found the files. */
  async #triggered(): Promise<Rule[]> {
    return [...(await this.#ruleStates()).values()].flatMap((s) => {
      const rule = s.found.item?.rule;
      return s.inForce && rule !== undefined && rule.when.trigger !== "always" ? [rule] : [];
    });
  }

  async ruleRun(options: RuleRunOptions): Promise<RuleRun> {
    const { facts, memory, window, patternTime, ranOut, stops, command, commandFailed, commandWaiting } = options;
    const terms = { facts, patternTime, ...(memory !== undefined ? { memory } : {}), ...(window !== undefined ? { window } : {}), ...(ranOut !== undefined ? { ranOut } : {}), ...(stops !== undefined ? { stops } : {}), ...(command !== undefined ? { command } : {}), ...(commandFailed !== undefined ? { commandFailed } : {}), ...(commandWaiting !== undefined ? { commandWaiting } : {}) };
    const scope = this.scope;
    if ("chat" in scope) {
      // Each moment reads the levels' config, the rules and what their `needs:` name as they stand then (decision 16).
      const read = (): Promise<Rule[]> => new TreeGuidance(this.#files, scope, this.#options).#triggered();
      return createRuleRun({ scope, rules: await this.#triggered(), read, ...terms });
    }
    // A scope of no chat has no rules to run (a job of no chat, C-23): its run is given none and reads none at any moment, whatever rule files its levels hold.
    if (!("session" in scope) || typeof scope.session !== "string") throw new Error("A rule run is a run's: a guidance read that names only the user, and no run's session, has none to hold rules for.");
    return createRuleRun({ scope: { user: scope.user, session: scope.session }, rules: [], read: () => Promise.resolve([]), ...terms });
  }
}
