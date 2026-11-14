// Where the folder host keeps the model layer's two documents (§13.2): the connections in
// `host/models/connections.json`, the secrets in `host/secrets/secrets.json`, a file only its owner
// may read in a folder only its owner may enter (§16). Each is written whole, one write at a time.

import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelsPort } from "../../contract/index";
import { readJson, Serial, writeJson } from "./disk";
import type { Site } from "./site";

export function folderModels(site: Site): ModelsPort {
  const connections = join(site.host, "models", "connections.json");
  const secretsFolder = join(site.host, "secrets");
  const secrets = join(secretsFolder, "secrets.json");
  const serial = new Serial();

  return {
    loadConnections: async () => (await readJson(connections)) ?? null,
    saveConnections: (doc) => serial.run(connections, () => writeJson(connections, doc)),
    loadSecrets: async () => (await readJson(secrets)) ?? null,
    saveSecrets: (doc) =>
      serial.run(secrets, async () => {
        await mkdir(secretsFolder, { recursive: true, mode: 0o700 });
        await chmod(secretsFolder, 0o700);
        await writeJson(secrets, doc, 0o600);
      }),
  };
}
