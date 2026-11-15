// Where the folder host keeps each user's two documents of the model layer (§13.2), in his own folder:
// the connections in `host/user/<user>/models/connections.json`, the secrets in
// `host/user/<user>/secrets/secrets.json`, a file only its owner may read in a folder only its owner
// may enter (§16). A scope of a user the host does not serve is refused, as at every other port. Each
// document is written whole, one write at a time.

import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelsPort, UserScope } from "../../contract/index";
import { readJson, Serial, writeJson } from "./disk";
import type { Site } from "./site";
import { userFolder } from "./store";

export function folderModels(site: Site): ModelsPort {
  const serial = new Serial();
  const connectionsOf = (scope: UserScope): string => join(userFolder(site, scope), "models", "connections.json");
  const secretsFolderOf = (scope: UserScope): string => join(userFolder(site, scope), "secrets");

  return {
    loadConnections: async (scope) => (await readJson(connectionsOf(scope))) ?? null,
    saveConnections: async (scope, doc) => {
      const file = connectionsOf(scope);
      await serial.run(file, () => writeJson(file, doc));
    },
    loadSecrets: async (scope) => (await readJson(join(secretsFolderOf(scope), "secrets.json"))) ?? null,
    saveSecrets: async (scope, doc) => {
      const folder = secretsFolderOf(scope);
      const file = join(folder, "secrets.json");
      await serial.run(file, async () => {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await chmod(folder, 0o700);
        await writeJson(file, doc, 0o600);
      });
    },
  };
}
