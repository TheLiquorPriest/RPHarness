// Not a test of its own (no `.test.` in its name): `folder.test.ts` runs it and expects it to
// fail. The kit run against a folder host wrapped so that an agent's write to one of the user's
// own files goes through, as a host with no jail would let it.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runContractKit } from "../../src/testing/kit/index";
import { levelDir, makeFolderHost } from "./folder-kit";

runContractKit("folder host that lets a write to a user's file through", async (seed, place) => {
  const env = await makeFolderHost(seed, place);
  const write = env.files.write.bind(env.files);
  env.files.write = async (scope, path, op, by) => {
    if (path !== "AGENTS.md" || op.op !== "write" || by === "harness") return write(scope, path, op, by);
    await writeFile(join(levelDir(place, seed, "chat"), "AGENTS.md"), op.text, "utf8");
    return { status: "written", path, kind: "yours", op: "write", bytes: Buffer.byteLength(op.text), hash: "", before: null };
  };
  return { env, close: () => env.close() };
});
