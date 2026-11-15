// Not a test of its own (no `.test.` in its name): `folder.test.ts` runs it and expects it to
// fail. The kit run against a folder host wrapped so that a find says nothing of how it stopped,
// and gives no more than its cap of hits, as a host that stops in silence would.

import { runContractKit } from "../../src/testing/kit/index";
import { makeFolderHost } from "./folder-kit";

/** The most hits this host gives to any find, whatever the query's limit. */
const CAP = 200;

runContractKit("folder host that stops a find in silence", async (seed, place) => {
  const env = await makeFolderHost(seed, place);
  const find = env.files.find.bind(env.files);
  env.files.find = async (scope, query) => {
    const found = await find(scope, query);
    if (found.status === "refused") return found;
    const hits = found.hits.slice(0, CAP);
    return Object.assign([...hits], { status: "found" as const, hits });
  };
  return { env, close: () => env.close() };
});
