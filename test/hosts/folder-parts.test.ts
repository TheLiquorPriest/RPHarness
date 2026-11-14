// Each area of the kit run against the folder host with only that area's port given to it, as a
// lane that builds one port of a host runs it: a case that reached for any other port would fail.

import type { Environment } from "../../src/contract/index";
import type { KitArea, KitPartFactory } from "../../src/testing/kit/index";
import { KIT_AREAS, runKitPart } from "../../src/testing/kit/index";
import { makeFolderHost } from "./folder-kit";

function onlyPort<A extends KitArea>(area: A): KitPartFactory<A> {
  return async (seed, place) => {
    const host = await makeFolderHost(seed, place);
    const port = { [area]: host[area] } as Pick<Environment, A>;
    return { ...port, close: () => host.close() };
  };
}

for (const area of KIT_AREAS) runKitPart(`folder host's ${area} port alone`, area, onlyPort(area));
