// The folder host's facts (§5.4 "Facts") from `host/facts.json`: the facts it declares, read once
// when the host is made (the list holds for the host's life), and each chat's values, read afresh
// on every call. A declared fact with no value for a chat counts 0; a value for a name not declared
// is never given.

import { join } from "node:path";
import type { FactDef, FactsPort, FactValue } from "../../contract/index";
import { readJson } from "./disk";
import type { FactsDoc } from "./shape";
import { factsDoc } from "./shape";
import type { Site } from "./site";

export async function folderFacts(site: Site): Promise<FactsPort> {
  const path = join(site.host, "facts.json");
  const load = async (): Promise<FactsDoc> => {
    const value = await readJson(path);
    return value === undefined ? { defs: [], values: {} } : factsDoc(path, value);
  };
  const defs: FactDef[] = (await load()).defs;
  const declared = new Set<string>();
  for (const d of defs) {
    if (declared.has(d.name)) throw new Error(`${path} declares the fact ${JSON.stringify(d.name)} twice.`);
    declared.add(d.name);
  }

  return {
    // Copies, so a caller that changes what it was given changes nothing here.
    defs: () => defs.map((d) => ({ ...d, ...(d.by !== undefined ? { by: [...d.by] } : {}), ...(d.fields !== undefined ? { fields: [...d.fields] } : {}) })),

    async read(scope, names) {
      site.check(scope);
      const values = (await load()).values[scope.chat] ?? {};
      const out: Record<string, FactValue> = {};
      for (const name of names ?? defs.map((d) => d.name)) {
        if (!declared.has(name)) continue;
        out[name] = Object.hasOwn(values, name) ? (values[name] as FactValue) : { count: 0 };
      }
      return out;
    },
  };
}
