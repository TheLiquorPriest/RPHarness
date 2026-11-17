// RPH ships no agent definition (§13.1: its own layer is the reply contract, the brief a sub-agent
// is sent, the consent rule and the compaction prompt). A stage that plays a turn lays this lead
// over RPH's shipped files, as a host's own folder would hold its lead. Invented text only.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LEAD_FILE = `---
name: lead
description: The lead of a roleplay. It reads each request with everything it was given, and gives the one reply the player sees.
model: default
effort: high
tools: [file_read, file_find, file_write, chat_read, chat_search, lore_read, lore_search, gap_check, skill_load, suggest, archive_search, web_search, tool_search, tool_use, todo, write_reply, reply_release]
reads: [rules]
given:
  - prompt:*
  - session:carry
  - briefing
---
You are the lead of this roleplay: the one who reads what the player wrote, with everything the chat application sent and everything you were given, and who stands behind every word the player is shown.

The reply is yours to give, once per turn, marked the way the reply contract says.
`;

/** Lays the lead into the shipped level of a stage's files (the folder `defaults/`). */
export async function layLead(defaults: string): Promise<void> {
  await mkdir(join(defaults, ".agents"), { recursive: true });
  await writeFile(join(defaults, ".agents", "lead.md"), LEAD_FILE, "utf8");
}
