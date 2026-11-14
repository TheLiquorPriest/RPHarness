// What a session's opening block holds, and what of it no longer stands (§5.2, §10.2). The opening
// block is fixed when a session opens, so the cached front of the prompt holds; a file changed in
// the middle of a session reaches the agent in the next briefing, as its whole current text or as
// switched off, in the words of the `notices` part.

import type { ChangesText, FileChange, FindChanges, TakeSnapshot } from "./api";
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

export const snapshot: TakeSnapshot = (stack) => ({
  agent: stack.agent,
  parts: stack.entries.flatMap((e) => (e.where === "opening" && e.left === undefined && e.hash !== undefined ? [{ part: e.part, path: e.path, level: e.level, hash: e.hash }] : [])),
});

export const changes: FindChanges = (opened, now) => {
  const given = now.entries.filter((e) => e.where === "opening" && e.left === undefined && e.hash !== undefined);
  const before = new Map(opened.parts.map((p) => [p.part, p] as const));
  const out: FileChange[] = [];
  for (const e of given) {
    const was = before.get(e.part);
    if (was !== undefined && was.hash === e.hash && was.path === e.path) continue;
    out.push({ part: e.part, change: was === undefined ? "added" : "changed", path: e.path, level: e.level, text: e.text ?? "" });
  }
  const still = new Set(given.map((e) => e.part));
  for (const was of opened.parts) {
    if (still.has(was.part)) continue;
    const entry = now.entries.find((e) => e.part === was.part && e.where === "opening");
    out.push({ part: was.part, change: "off", path: was.path, level: was.level, why: entry?.left ?? "missing" });
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
