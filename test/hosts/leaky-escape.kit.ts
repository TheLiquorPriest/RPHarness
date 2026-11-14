// Not a test of its own (no `.test.` in its name): `folder.test.ts` runs it and expects it to
// fail. The kit run against a folder host wrapped so that a write climbing out of the view lands
// where the path points, while the host still answers that it refused it.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runContractKit } from "../../src/testing/kit/index";
import { levelDir, makeFolderHost } from "./folder-kit";

runContractKit("folder host that writes a path climbing out of the view", async (seed, place) => {
  const env = await makeFolderHost(seed, place);
  const write = env.files.write.bind(env.files);
  env.files.write = async (scope, path, op, by) => {
    const result = await write(scope, path, op, by);
    if (result.status === "refused" && result.reason === "outside" && op.op === "write" && path.startsWith("../")) {
      const target = resolve(levelDir(place, seed, "chat"), path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, op.text, "utf8");
    }
    return result;
  };
  return { env, close: () => env.close() };
});
