// The folder host's small durable store: each of a user's values a JSON file in his own folder,
// under `host/user/<user>/store/`, its key's segments as folders (`jobs/9f2c` is
// `host/user/<user>/store/jobs/9f2c.json`), so two users' values under one key never meet. A scope
// of a user the host does not serve is refused, as at every other port. Changes to one key run one
// at a time.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, StorePort, UserScope } from "../../contract/index";
import { codeOf, readJson, safeId, Serial, writeJson } from "./disk";
import type { Site } from "./site";

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The user's own folder of the host's records, `host/user/<user>/`: refused for a user this host does not serve. */
export function userFolder(site: Site, scope: UserScope): string {
  if (scope.user !== site.user) throw new Error(`The folder host serves the user ${JSON.stringify(site.user)}, not ${JSON.stringify(scope.user)}.`);
  return join(site.host, "user", safeId("user", scope.user));
}

export function folderStore(site: Site): StorePort {
  const serial = new Serial();

  function fileOf(scope: UserScope, key: string): string {
    const segments = key.split("/");
    if (segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) throw new Error(`${JSON.stringify(key)} is not a store key: segments of letters, digits, ".", "_" and "-", joined by "/".`);
    return `${join(userFolder(site, scope), "store", ...segments)}.json`;
  }

  async function keys(folder: string, prefix: string): Promise<string[]> {
    let found;
    try {
      found = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (codeOf(error) === "ENOENT") return [];
      throw error;
    }
    const out: string[] = [];
    for (const d of found) {
      if (d.isDirectory()) out.push(...(await keys(join(folder, d.name), `${prefix}${d.name}/`)));
      else if (d.isFile() && d.name.endsWith(".json") && SEGMENT.test(d.name)) out.push(`${prefix}${d.name.slice(0, -".json".length)}`);
    }
    return out;
  }

  // Each member is async, so a refused scope or a key that is none is a rejection, as a failed write is.
  return {
    get: async (scope, key) => (await readJson(fileOf(scope, key))) as JsonValue | undefined,

    set: async (scope, key, value) => {
      const file = fileOf(scope, key);
      await serial.run(file, () => writeJson(file, value));
    },

    update: async (scope, key, change) => {
      const file = fileOf(scope, key);
      return serial.run(file, async () => {
        const next = change((await readJson(file)) as JsonValue | undefined);
        if (next === undefined) await rm(file, { force: true });
        else await writeJson(file, next);
        return next;
      });
    },

    delete: async (scope, key) => {
      const file = fileOf(scope, key);
      await serial.run(file, () => rm(file, { force: true }));
    },

    list: async (scope, prefix) => (await keys(join(userFolder(site, scope), "store"), "")).filter((k) => k.startsWith(prefix)),
  };
}
