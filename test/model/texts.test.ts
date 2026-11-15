// The model layer's texts as a host's levels give them (texts.ts): a nearer level's file replaces a
// farther one's, a read with no chat in view sees the shipped and global levels alone, and a line
// missing from a file sends nothing in its place. Read through the folder host, as a host's files
// are; its chats have no prompts folder of their own (§5), so the nearest level here is the global one.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { FolderHost } from "../../src/hosts/folder/index";
import { modelTexts } from "../../src/model";
import { KIT_SEED } from "../../src/testing/kit/index";
import { levelDir, makeFolderHost } from "../hosts/folder-kit";

let place: string;
let host: FolderHost;

beforeEach(async () => {
  place = await mkdtemp(join(tmpdir(), "rph-texts-"));
  host = await makeFolderHost(KIT_SEED, place);
});

afterEach(async () => {
  await host.close();
  await rm(place, { recursive: true, force: true });
});

/** Writes a file at a level of the kit's chat. */
async function put(level: "shipped" | "global" | "chat", path: string, text: string): Promise<void> {
  const full = join(levelDir(place, KIT_SEED, level), path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text);
}

test("a global system-note.md and connection-test.md replace the shipped ones, in a chat and with no chat in view", async () => {
  await put("shipped", ".prompts/system-note.md", "Shipped note:\n{{text}}\n");
  await put("shipped", ".prompts/connection-test.md", "Shipped test.\n");
  await put("shipped", ".prompts/signin-line.md", "Shipped sign-in line.\n");
  await put("shipped", ".prompts/tool-notices.md", "---\ndescription: Fixture notices.\nformat: lines\n---\nempty_answer: {{tool}} said nothing.\n");
  await put("global", ".prompts/system-note.md", "Global note:\n{{text}}\n");
  await put("chat", ".prompts/system-note.md", "A chat's prompts folder is outside the view:\n{{text}}\n");
  await put("global", ".prompts/connection-test.md", "Global test.\n");

  const inChat = await modelTexts(host.files, KIT_SEED.scope);
  expect(inChat.markNote?.("The tide turns.")).toBe("Global note:\nThe tide turns.");
  expect(inChat.testPrompt).toBe("Global test.");
  expect(inChat.signinLine).toBe("Shipped sign-in line.");
  expect(inChat.emptyAnswer?.("lookup")).toBe("lookup said nothing.");
  // The file holds no line for an answer of pictures alone: such an answer goes as it is.
  expect(inChat.picturesAnswer).toBeUndefined();

  const shared = await modelTexts(host.files, { user: KIT_SEED.scope.user });
  expect(shared.markNote?.("The tide turns.")).toBe("Global note:\nThe tide turns.");
  expect(shared.testPrompt).toBe("Global test.");
});
