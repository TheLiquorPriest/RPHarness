// The words of RPH's own shipped parts that the texts lane worded for the wave's code (PlanTexts-4): a
// refused write says where notes go; `write_reply` with no writer says why, in each of its three cases;
// `second_reply` is true in both forms of a reply; a line the code no longer asks for is gone; and no
// header of RPH's own parts or tools holds a field nothing reads. Each row is the shipped file's own line,
// rendered as the harness renders it. Every name is invented.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { LinesPart } from "../../src/files/api";
import { SHIPPED_GUIDANCE } from "../../src/harness/shipped";
import { shippedParts } from "./support";

async function lines(): Promise<LinesPart> {
  const part = await shippedParts().part("tool-notices");
  if (part?.format !== "lines") throw new Error("tool-notices is not a lines part");
  return part;
}

const WRITABLE = ["persistent-workspace/", "sessions/s-1/turns/t-1/scratch/", "sessions/s-1/turns/t-1/output/"];

test("each refused line says where notes go, naming the notes folder, and names no path of its own or any the player owns", async () => {
  const part = await lines();
  for (const reason of ["yours", "generated", "mounted", "outside", "link", "invalid"]) {
    const name = `refused_${reason}`;
    const template = part.lines.get(name);
    expect({ name, fields: template?.fields.filter((field) => field !== "path" && field !== "writable") }).toEqual({ name, fields: [] });
    const said = part.line(name, { path: "plan.md", writable: WRITABLE }) ?? "";
    expect({ name, notes: said.includes("persistent-workspace/"), mentioned: said.includes("Notes go in") }).toEqual({ name, notes: true, mentioned: true });
    // A path that is not there is not called the player's own.
    expect(said).not.toContain("player's own");
  }
});

test("no_writer is true in each of its three cases: no writer named, a writer no definition has, a writer whose definition is switched off", async () => {
  const part = await lines();
  expect(part.line("no_writer", {})).toBe("No reply was written: your definition names no agent to write it.");
  expect(part.line("no_writer", { writer: "narrator", missing: true })).toBe("No reply was written: narrator, the agent your definition names to write it, has no definition.");
  expect(part.line("no_writer", { writer: "narrator", off: true })).toBe("No reply was written: narrator, the agent your definition names to write it, is switched off.");
  // A definition that does not load is its own case, and any other left-out part is said plainly rather than not at all.
  expect(part.line("no_writer", { writer: "narrator", broken: true })).toContain("does not load");
  expect(part.line("no_writer", { writer: "narrator" })).toContain("cannot be used");
});

test("second_reply is true of the tags' form and of the two-step form: it names neither", async () => {
  const said = (await lines()).line("second_reply", {}) ?? "";
  expect(said).toBe("The reply for this turn has already gone out. Nothing more goes to the chat.");
  expect(said).not.toMatch(/tag|file|draft|<|two-step/i);
});

test("a line the code no longer asks for is gone: not_now", async () => {
  expect((await lines()).lines.has("not_now")).toBe(false);
});

test("the lines this lane words say what is so and ask for nothing", async () => {
  const part = await lines();
  const worded = ["refused_yours", "refused_generated", "refused_mounted", "refused_outside", "refused_link", "refused_invalid", "no_writer", "second_reply"];
  for (const name of worded) {
    const said = part.line(name, { path: "plan.md", writable: WRITABLE, writer: "narrator", off: true }) ?? "";
    expect({ name, said: said.length > 0, unfilled: said.includes("{{"), asks: /\b(must|should|always|please)\b/i.test(said) }).toEqual({ name, said: true, unfilled: false, asks: false });
  }
});

/** The header fields of a part or a tool file that something reads: its description and format, a tool's arguments, and the fields code reads of one part by name. */
const READ: Record<string, true> = { description: true, format: true, arguments: true, yes: true, record: true, views: true, tags: true, intent_file: true };

function headerOf(text: string): Record<string, unknown> {
  if (!text.startsWith("---\n")) return {};
  return Bun.YAML.parse(text.slice(4, text.indexOf("\n---\n", 4))) as Record<string, unknown>;
}

test("no header of RPH's own parts or tools holds a field nothing reads, and write_reply names no writer", () => {
  const unread: string[] = [];
  for (const folder of [".prompts", ".tools"]) {
    for (const file of readdirSync(join(SHIPPED_GUIDANCE, folder))) {
      const text = readFileSync(join(SHIPPED_GUIDANCE, folder, file), "utf8");
      for (const field of Object.keys(headerOf(text))) if (READ[field] !== true && !text.includes(`{{${field}`) && !text.includes(`{{#${field}`)) unread.push(`${folder}/${file}: ${field}`);
    }
  }
  expect(unread).toEqual([]);
  expect(Object.keys(headerOf(readFileSync(join(SHIPPED_GUIDANCE, ".tools", "write_reply.md"), "utf8")))).toEqual(["description", "arguments"]);
});

test("every definition RPH ships names its model and its effort", () => {
  for (const file of readdirSync(join(SHIPPED_GUIDANCE, ".agents"))) {
    const header = headerOf(readFileSync(join(SHIPPED_GUIDANCE, ".agents", file), "utf8"));
    expect({ file, model: typeof header.model, effort: typeof header.effort }).toEqual({ file, model: "string", effort: "string" });
  }
});
