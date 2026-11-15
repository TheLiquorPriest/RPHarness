// What an agent's opening block holds, and what of it no longer stands (§5.2, §10.2). The opening
// block is fixed when it is made, so the cached front of the prompt holds; a part changed since
// (a file edited, the reply contract, a tool's guide or description) reaches the agent in its next
// briefing, or the next message of a run that goes on, as its whole current text or as switched
// off, in the words of the `notices` part.

import { createHash } from "node:crypto";
import type { LayerLevel } from "../contract/index";
import type { ChangesText, FileChange, FindChanges, FrontPart, TakeSnapshot } from "./api";
import { normalized } from "./header";

/** Whether an instruction file holds nothing besides headings, comments and blank lines: a template such as the shipped `WORLD.md`, left out of the stack until it does. */
export function holdsNothing(text: string): boolean {
  const lines = normalized(text).replace(/<!--[\s\S]*?-->/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) continue;
    // A line underlined with = or - is a heading too.
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[i + 1] ?? "")) {
      i++;
      continue;
    }
    return false;
  }
  return true;
}

/** A part that stands, with its text. */
function stands(p: FrontPart): p is FrontPart & { text: string } {
  return p.left === undefined && p.text !== undefined;
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const snapshot: TakeSnapshot = (agent, front) => ({
  agent,
  parts: front.filter(stands).map((p) => ({ part: p.part, path: p.path, level: p.level, hash: hashOf(p.text), ...(p.layered === true ? { layered: true as const } : {}) })),
});

/** Which part of a block this is, across a session: its name, and for one level's file of a layered name, its level too. */
function partOf(p: { part: string; level: LayerLevel; layered?: true }): string {
  return p.layered === true ? `${p.level}\n${p.part}` : p.part;
}

export const changes: FindChanges = (opened, now) => {
  const given = now.filter(stands);
  const before = new Map(opened.parts.map((p) => [partOf(p), p] as const));
  const out: FileChange[] = [];
  for (const p of given) {
    const was = before.get(partOf(p));
    if (was !== undefined && was.hash === hashOf(p.text) && was.path === p.path) continue;
    out.push({ part: p.part, change: was === undefined ? "added" : "changed", path: p.path, level: p.level, text: p.text });
  }
  const still = new Set(given.map(partOf));
  for (const was of opened.parts) {
    if (still.has(partOf(was))) continue;
    const left = now.find((p) => partOf(p) === partOf(was))?.left;
    out.push({ part: was.part, change: "off", path: was.path, level: was.level, why: left ?? "missing" });
  }
  return out;
};

/** Between one file's piece and the next, and between a notice and the text it introduces. */
const GAP = "\n\n";

export const changesText: ChangesText = (list, notices) => {
  const pieces: string[] = [];
  for (const c of list) {
    const line = notices?.format === "lines" ? notices.line(c.change === "off" ? "file_off" : "file_changed", { path: c.path, part: c.part }) : undefined;
    if (c.change === "off") {
      if (line !== undefined) pieces.push(line);
      continue;
    }
    const text = (c.text ?? "").trimEnd();
    pieces.push(line === undefined ? text : `${line}${GAP}${text}`);
  }
  return pieces.join(GAP);
};
