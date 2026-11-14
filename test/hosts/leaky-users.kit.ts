// Not a test of its own (no `.test.` in its name): `folder.test.ts` runs it and expects it to
// fail. The kit run against a folder host wrapped so that every scope is read as the kit's own
// user's, as a host that keyed its data by chat alone would read it.

import type { Scope } from "../../src/contract/index";
import { KIT_SEED, runContractKit } from "../../src/testing/kit/index";
import { makeFolderHost } from "./folder-kit";

/** A port whose every call is made for the kit's user, whoever's scope it was given. */
function asKitUser<T extends object>(port: T): T {
  return new Proxy(port, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (scope: Scope, ...rest: unknown[]) => value.call(target, { ...scope, user: KIT_SEED.scope.user }, ...rest);
    },
  });
}

runContractKit("folder host that reads every user's scope as one user's", async (seed, place) => {
  const env = await makeFolderHost(seed, place);
  env.files = asKitUser(env.files);
  env.chat = asKitUser(env.chat);
  env.lore = asKitUser(env.lore);
  env.prompt = asKitUser(env.prompt);
  return { env, close: () => env.close() };
});
