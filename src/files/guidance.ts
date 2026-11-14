// The guidance of one scope (§5): every kind of file, read through the host's `FilesPort` at its
// levels, the nearest of a name in force and what config switches off kept off; and from them an
// agent's definition and stack, the skills' index, prompt parts, tool descriptions, the rules as the
// Rules page lists them, and one run's rule engine. Each file is read and parsed once.

import type { DefinitionView, FileText, FilesPort, RuleView, Scope, StackLeft, StackPart } from "../contract/index";
import type { AgentDefinition, Guidance, LoadGuidance, PartKind, Problem, PromptPart, Replaced, RuleRun, RuleRunOptions, Skill, SkillEntry, Stack, StackEntry } from "./api";
import { parseDefinition } from "./definitions";
import { createRuleRun } from "./engine";
import { problemAt } from "./header";
import { parsePart } from "./parts";
import type { ReadRule } from "./rules";
import { parseRule } from "./rules";
import { parseSkill } from "./skills";
import { holdsNothing } from "./stack";
import type { FileRef, Listing } from "./tree";
import { itemKey, LEVEL_ORDER, Tree, writtenKey } from "./tree";

/** The name a definition's `reads:` gives the always-on rules it is named in (§5.2 part 2): `reads: [ALL-AGENTS, rules, …]`. */
const RULES = "rules";

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

interface RuleState {
  found: Found<ReadRule>;
  inForce: boolean;
  why?: "off" | "needs" | "broken";
}

export const loadGuidance: LoadGuidance = (files, scope) => new TreeGuidance(files, scope);

class TreeGuidance implements Guidance {
  readonly scope: Scope;
  readonly #tree: Tree;
  /** What parsing found, each file's once. */
  readonly #problems: Problem[] = [];
  readonly #memo = new Map<string, Promise<unknown>>();

  constructor(files: FilesPort, scope: Scope) {
    this.scope = scope;
    this.#tree = new Tree(files, scope);
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

  #definition(name: string): Promise<Found<AgentDefinition> | undefined> {
    return this.#found("agents", name, (file, replaces) => {
      const { definition, problems } = parseDefinition(file, name, replaces);
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
    return this.#found(kind, name, (file, replaces) => {
      const { part, problems } = parsePart(file, name, kind, replaces);
      return { item: part, problems };
    });
  }

  #rule(listing: "rules" | "examples", name: string): Promise<Found<ReadRule> | undefined> {
    return this.#found(listing, name, (file, replaces) => {
      const read = parseRule(file, name, replaces);
      return { item: read, problems: read.problems };
    });
  }

  /**
   * The instruction files in force by a name: the nearest; or, for a name in `layered:`, the file of
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

  /** Every rule (not the examples), in force or not, by name: off, broken, a question nobody asks, or held by a `needs:` that is not in force, followed through other rules. */
  #ruleStates(): Promise<Map<string, RuleState>> {
    return this.#once("rule states", async () => {
      const names = [...(await this.#tree.found("rules")).keys()].sort();
      const found = new Map<string, Found<ReadRule>>();
      for (const [name, f] of await Promise.all(names.map(async (n) => [n, await this.#rule("rules", n)] as const))) if (f !== undefined) found.set(name, f);
      // A `needs:` name is read the way an `off:` entry is: `perceptions`, `rules/perceptions`, `TURN`, `TURN.md`.
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
        else if (rule.when.trigger === "question") {
          // Listed as in force, a question nobody asks would never fire: the user is told instead.
          this.#problems.push(problemAt({ path: f.ref.path, level: f.ref.level }, rule.lines.question, "No model is asked a rule's question in this harness, so this rule would never fire, and it is not in force. A pattern (`condition:`) can look for what the question asks about."));
          state = { found: f, inForce: false };
        } else {
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
    const lists = await Promise.all((["instructions", "agents", "skills", "prompts", "tools", "examples"] as const).map(async (l) => [l, [...(await this.#tree.found(l)).keys()]] as const));
    const loads: Promise<unknown>[] = [this.#ruleStates(), this.#tree.config()];
    for (const [listing, names] of lists) {
      for (const name of names) {
        if (listing === "instructions") loads.push(this.#instructions(name));
        else if (listing === "agents") loads.push(this.#definition(name));
        else if (listing === "skills") loads.push(this.#skill(name));
        else if (listing === "examples") loads.push(this.#rule("examples", name));
        else loads.push(this.#part(listing, name));
      }
    }
    await Promise.all(loads);
    return [...this.#tree.problems, ...this.#problems];
  }

  async definition(name: string): Promise<AgentDefinition | undefined> {
    const found = await this.#definition(name);
    return found === undefined || found.off ? undefined : found.item;
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
        tools: [...d.tools],
        reads: [...d.reads],
        given: [...d.given],
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
    const found = await this.#definition(agent);
    const def = found?.item;
    if (found === undefined || def === undefined || found.off) {
      const where = found === undefined ? await this.#wouldBe(agent) : { path: found.ref.path, level: found.ref.level, ...(found.file !== undefined ? { hash: found.file.hash } : {}) };
      entries.push({ part: itemKey("agents", agent), kind: "definition", where: "opening", ...where, replaces: found?.replaces ?? [], left: found === undefined ? "missing" : found.off ? "off" : "broken" });
    } else {
      entries.push({ part: itemKey("agents", agent), kind: "definition", where: "opening", path: def.source.path, level: def.source.level, hash: def.source.hash, replaces: def.replaces, text: def.instructions.text });
      for (const read of def.reads) {
        if (read === RULES) entries.push(...(await this.#ruleEntries(agent, "opening")));
        else entries.push(...(await this.#instructionEntries(read.replace(/\.md$/, ""), "opening")));
      }
      if (def.given.includes(BRIEFING)) {
        const wanted = options.situations;
        const added = new Map<string, string[]>();
        for (const [situation, names] of (await this.#tree.config()).added) {
          if (wanted !== undefined && !wanted.includes(situation)) continue;
          for (const name of names) added.set(name, [...(added.get(name) ?? []), situation]);
        }
        for (const [name, situations] of added) entries.push(...(await this.#instructionEntries(name, "briefing")).map((e) => ({ ...e, situations })));
        entries.push(...(await this.#ruleEntries(agent, "briefing", wanted)));
      }
    }
    const paths = new Set(entries.map((e) => e.path));
    return { agent, entries, problems: [...this.#tree.problems, ...this.#problems].filter((p) => paths.has(p.path)) };
  }

  async stackParts(agent: string): Promise<StackPart[]> {
    return (await this.stack(agent)).entries.map((e) => ({ part: e.part, path: e.path, level: e.level, ...(e.hash !== undefined ? { hash: e.hash } : {}), where: e.where, ...(e.left !== undefined ? { left: e.left } : {}) }));
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

  async rules(): Promise<RuleView[]> {
    const view = (f: Found<ReadRule>, inForce: boolean, why: RuleView["why"]): RuleView => ({
      name: f.ref.name,
      path: f.ref.path,
      level: f.ref.level,
      description: f.item?.description ?? "",
      agents: f.item?.agents ?? [],
      ...(f.item?.trigger !== undefined ? { trigger: f.item.trigger } : {}),
      inForce,
      ...(why !== undefined ? { why } : {}),
      replaces: f.replaces,
    });
    const views = [...(await this.#ruleStates()).values()].map((s) => view(s.found, s.inForce, s.why));
    for (const name of [...(await this.#tree.found("examples")).keys()].sort()) {
      const found = await this.#rule("examples", name);
      if (found !== undefined) views.push(view(found, false, found.item?.rule === undefined ? "broken" : "example"));
    }
    return views;
  }

  async ruleRun(options: RuleRunOptions): Promise<RuleRun> {
    const rules = [...(await this.#ruleStates()).values()].flatMap((s) => {
      const rule = s.found.item?.rule;
      return s.inForce && rule !== undefined && rule.when.trigger !== "always" ? [rule] : [];
    });
    return createRuleRun({ scope: this.scope, rules, facts: options.facts, ...(options.memory !== undefined ? { memory: options.memory } : {}), ...(options.window !== undefined ? { window: options.window } : {}) });
  }
}
