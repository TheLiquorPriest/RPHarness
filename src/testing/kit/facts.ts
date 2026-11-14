// The kit's cases for facts (§5.4 "Facts") and the host's tools (§6.8).

import { expect, test } from "bun:test";
import type { FactDef, FactValue, HostTool } from "../../contract/index";
import type { KitContext } from "./context";
import { notJson, schemaProblems } from "./schema";

/**
 * RPH's base tools (§6.8, §10.5): a host tool of one of these names would be hidden behind RPH's own.
 * When RPH adds a base tool, it is added here.
 */
export const BASE_TOOL_NAMES = [
  "prompt",
  "chat_read",
  "chat_search",
  "lore_read",
  "lore_search",
  "archive_search",
  "web_search",
  "gap_check",
  "delegate",
  "agent_message",
  "ask_author",
  "prompt_map_write",
  "write_reply",
  "reply_release",
  "file_read",
  "file_find",
  "file_write",
  "skill_load",
  "job_start",
  "suggest",
  "todo",
  "tool_search",
  "tool_use",
];

/**
 * What is wrong with fact values read from a host, against the facts it declares; none when
 * nothing is. Every fact read is declared; its count is a count; its groups, the names in each, and
 * its fields are ones its definition declares; each name of a group is among its names; each
 * field's value is JSON.
 */
export function factProblems(defs: readonly FactDef[], values: Readonly<Record<string, FactValue>>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const def = defs.find((d) => d.name === name);
    if (def === undefined) {
      out.push(`${name} is read but not declared`);
      continue;
    }
    if (!Number.isInteger(value.count) || value.count < 0) out.push(`${name}.count is not a count`);
    if (value.names !== undefined && !value.names.every((n) => typeof n === "string")) out.push(`${name}.names are not all names`);
    for (const [group, n] of Object.entries(value.by ?? {})) {
      if (!Number.isInteger(n) || n < 0) out.push(`${name}.by.${group} is not a count`);
      if (def.by === undefined || !def.by.includes(group)) out.push(`${name}.by.${group} is not a group its definition declares`);
    }
    for (const [group, names] of Object.entries(value.namesBy ?? {})) {
      if (def.by === undefined || !def.by.includes(group)) out.push(`${name}.namesBy.${group} is not a group its definition declares`);
      for (const n of names) if (value.names === undefined || !value.names.includes(n)) out.push(`${name}.namesBy.${group} names ${JSON.stringify(n)}, which is not among its names`);
    }
    for (const [field, v] of Object.entries(value.fields ?? {})) {
      if (def.fields === undefined || !def.fields.includes(field)) out.push(`${name}.fields.${field} is not a field its definition declares`);
      notJson(v, `${name}.fields.${field}`, out);
    }
  }
  return out;
}

export function factCases(ctx: KitContext): void {
  test("every fact is declared once, with a line on what it counts, and the list holds", () => {
    const defs = ctx.env.facts.defs();
    const names = defs.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of defs) {
      expect(d.name).toMatch(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/);
      expect(d.counts.trim()).not.toBe("");
      if (d.by !== undefined) expect(new Set(d.by).size).toBe(d.by.length);
      if (d.fields !== undefined) expect(new Set(d.fields).size).toBe(d.fields.length);
    }
    expect(ctx.env.facts.defs()).toEqual(defs);
  });

  test("every fact read is one the host declares, with its groups, names and fields as declared, and only those asked for", async () => {
    const defs = ctx.env.facts.defs();
    expect(factProblems(defs, await ctx.env.facts.read(ctx.scope))).toEqual([]);
    const first = defs[0];
    if (first !== undefined) expect(Object.keys(await ctx.env.facts.read(ctx.scope, [first.name]))).toEqual([first.name]);
    expect(await ctx.env.facts.read(ctx.scope, ["kit.not-declared"])).toEqual({});
  });
}

/** A tool as the model is told of it: everything but what runs it. */
function described(t: HostTool): Omit<HostTool, "run"> {
  const { run: _run, ...rest } = t;
  return rest;
}

export function toolCases(ctx: KitContext): void {
  test("tools have unique names apart from RPH's own, a tier, and parameters that are an object JSON Schema", async () => {
    const tools = await ctx.env.tools.all(ctx.scope);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    const problems: string[] = [];
    for (const t of tools) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) problems.push(`${t.name} is not a tool name a provider takes`);
      if (BASE_TOOL_NAMES.includes(t.name)) problems.push(`${t.name} is one of RPH's base tools`);
      if (t.family.trim() === "") problems.push(`${t.name} has no family`);
      if (!["read", "write", "external"].includes(t.tier)) problems.push(`${t.name} has no tier`);
      if (t.lane !== undefined && t.lane.trim() === "") problems.push(`${t.name} has an empty lane`);
      if (t.lane === "external") problems.push(`${t.name} names the lane "external", which is the external tier's own setting`);
      if (t.description.trim() === "") problems.push(`${t.name} has no description`);
      if (typeof t.run !== "function") problems.push(`${t.name} cannot run`);
      problems.push(...schemaProblems(t.parameters).map((p) => `${t.name}: ${p}`));
    }
    expect(problems).toEqual([]);
  });

  test("the list does not change within a session", async () => {
    const first = (await ctx.env.tools.all(ctx.scope)).map(described);
    const again = (await ctx.env.tools.all(ctx.scope)).map(described);
    const laterTurn = (await ctx.env.tools.all({ ...ctx.scope, turn: ctx.seed.prompts[2].turn })).map(described);
    expect(again).toEqual(first);
    expect(laterTurn).toEqual(first);
  });
}
