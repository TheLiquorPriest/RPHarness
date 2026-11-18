// A rule that fires is told in the chat's thinking block by what a person calls it, its file's `title:` (its name where it gives
// none), and as one of the person's own or one shipped with the application; the trace's record of the firing and the Rules page's
// list carry the title beside the name. A title that ends a sentence, or is no text, is reported. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { loadGuidance } from "../../src/files";
import { SHIPPED_GUIDANCE } from "../../src/harness/shipped";
import { request, type Stage, stage } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const AUTHOR = "---\nname: author\ndescription: Fixture lead.\nmodel: default\ntools: [file_read]\n---\nFixture author: you run the turn.\n";
const BEHIND = "---\ndescription: Fixture rule, the record is behind the window.\ntitle: The record behind the window\nagents: [author]\nat: run-end\n---\nFixture: bring the record up to date.\n";

test("a rule of the person's is told by its title, a shipped one as a rule that fired, by its name where it has no title; the record carries the title", async () => {
  const progress = await Bun.file(join(SHIPPED_GUIDANCE, ".prompts", "progress.md")).text();
  const s = (open = await stage({
    // The drafted guidance at the shipped level brings its rule reply-missing, which has no title.
    drafted: true,
    files: { ".agents/author.md": AUTHOR, ".prompts/progress.md": progress, ".rules/behind.md": BEHIND },
    answers: [{ pieces: [{ text: "Thinking aloud." }] }, { pieces: [{ text: "<reply>Wren counts the candles.</reply>" }] }],
  }));

  const { outcome, sink } = await s.turn(request("t1", { lead: "author" }));

  expect(outcome.status).toBe("released");
  const lines = sink.lines.map((line) => line.line);
  expect(lines).toContain("A rule fired: reply-missing.");
  expect(lines).toContain("A rule of yours fired: The record behind the window.");
  expect(s.trace.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.title, record.event.firing.level]).sort()).toEqual([
    ["behind", "The record behind the window", "global"],
    ["reply-missing", undefined, "shipped"],
  ]);
  // The Rules page's list names it the same way.
  const listed = await loadGuidance(s.env.files, request("t1").scope).rules();
  expect(listed.find((rule) => rule.name === "behind")?.title).toBe("The record behind the window");
});

test("a title that ends a sentence, or is no text, is reported, and a rule with one still fires", async () => {
  const s = (open = await stage({
    files: {
      ".agents/author.md": AUTHOR,
      ".rules/stopped.md": BEHIND.replace("title: The record behind the window", "title: The record behind the window."),
      ".rules/listed.md": BEHIND.replace("title: The record behind the window", "title: [behind, window]"),
    },
    answers: [{ pieces: [{ text: "<reply>Wren counts the candles.</reply>" }] }, { pieces: [{ text: "Noted." }] }],
  }));

  await s.turn(request("t1", { lead: "author" }));

  const problems = await loadGuidance(s.env.files, request("t1").scope).problems();
  expect(problems.filter((problem) => problem.message.startsWith("`title:`")).map((problem) => problem.path.split("/").at(-1)).sort()).toEqual(["listed.md", "stopped.md"]);
  expect(s.trace.of("rule_fired").map((record) => record.event.firing.rule).sort()).toEqual(["listed", "stopped"]);
});
