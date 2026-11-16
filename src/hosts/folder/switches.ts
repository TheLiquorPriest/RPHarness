// What is switched on (§16, C31): `host/switches.json`, which only the operator changes (with
// `rph-folder allow` and `rph-folder deny`), read as it stands at every ask:
//
//   { "on":  [ { "kind": "command-tool", "name": "dice", "target": "python3 dice.py", "user": "reader" } ],
//     "off": [ { "kind": "http-tool", "name": "weather" } ] }
//
// A thing is on for a user when an `on` entry names its kind, its name and exactly its target, for
// him (an entry that names no user is every user's); off when an `off` entry names its kind and
// name; and waits otherwise, so a thing just written in a file, or changed, waits.

import { join } from "node:path";
import type { Switchable, SwitchesPort, SwitchState } from "../../contract/index";
import { isRecord } from "../../contract/json";
import { readJson, writeJson } from "./disk";
import type { Site } from "./site";

/** One entry of the file. */
export interface SwitchEntry {
  kind: string;
  name: string;
  target?: string;
  user?: string;
}

interface SwitchesFile {
  on: SwitchEntry[];
  off: SwitchEntry[];
}

export function switchesPath(site: Site): string {
  return join(site.host, "switches.json");
}

function entries(value: unknown): SwitchEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e): SwitchEntry[] => (isRecord(e) && typeof e.kind === "string" && typeof e.name === "string" ? [{ kind: e.kind, name: e.name, ...(typeof e.target === "string" ? { target: e.target } : {}), ...(typeof e.user === "string" ? { user: e.user } : {}) }] : []));
}

/** The file as it stands; an empty one where there is none. */
export async function readSwitches(site: Site): Promise<SwitchesFile> {
  const raw: unknown = await readJson(switchesPath(site));
  return { on: entries(isRecord(raw) ? raw.on : undefined), off: entries(isRecord(raw) ? raw.off : undefined) };
}

/** Switches a thing on for a user (its exact target), or off, and writes the file: the operator's own act, from the host's command line. */
export async function setSwitch(site: Site, user: string, thing: Switchable, state: "on" | "off"): Promise<void> {
  const file = await readSwitches(site);
  const same = (e: SwitchEntry): boolean => e.kind === thing.kind && e.name === thing.name;
  const on = file.on.filter((e) => !(same(e) && (e.user === undefined || e.user === user)));
  const off = file.off.filter((e) => !same(e));
  if (state === "on") on.push({ kind: thing.kind, name: thing.name, target: thing.target, user });
  else off.push({ kind: thing.kind, name: thing.name });
  await writeJson(switchesPath(site), { on, off });
}

export function folderSwitches(site: Site): SwitchesPort {
  return {
    async state(user, thing): Promise<SwitchState> {
      const file = await readSwitches(site);
      if (file.off.some((e) => e.kind === thing.kind && e.name === thing.name)) return "off";
      if (file.on.some((e) => e.kind === thing.kind && e.name === thing.name && e.target === thing.target && (e.user === undefined || e.user === user))) return "on";
      return "waiting";
    },
  };
}
