// The folder host's small durable store: each key's value a JSON file under `host/store/`, its
// segments as folders (`jobs/9f2c` is `host/store/jobs/9f2c.json`). Changes to one key run one at a
// time.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, StorePort } from "../../contract/index";
import { codeOf, readJson, Serial, writeJson } from "./disk";
import type { Site } from "./site";

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function folderStore(site: Site): StorePort {
  const root = join(site.host, "store");
  const serial = new Serial();

  function fileOf(key: string): string {
    const segments = key.split("/");
    if (segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) throw new Error(`${JSON.stringify(key)} is not a store key: segments of letters, digits, ".", "_" and "-", joined by "/".`);
    return `${join(root, ...segments)}.json`;
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

  return {
    get: async (key) => (await readJson(fileOf(key))) as JsonValue | undefined,

    set: (key, value) => serial.run(key, () => writeJson(fileOf(key), value)),

    update: (key, change) =>
      serial.run(key, async () => {
        const file = fileOf(key);
        const next = change((await readJson(file)) as JsonValue | undefined);
        if (next === undefined) await rm(file, { force: true });
        else await writeJson(file, next);
        return next;
      }),

    delete: (key) => serial.run(key, () => rm(fileOf(key), { force: true })),

    list: async (prefix) => (await keys(root, "")).filter((k) => k.startsWith(prefix)),
  };
}
