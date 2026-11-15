// The folder host's job records, the store's typed part for them: each of a user's jobs a JSON file in
// his own folder, `host/user/<hash>/jobs/<started>~<id>.json`, the file's name beginning with the
// time the job started, zero-padded, so the latest comes first by the names alone and a page is read
// as a page: the records a page does not return are not opened. Another user's folder is never
// reached: a scope of a user the host does not serve is refused, as at every other port.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JobPage, JobQuery, JobRecords, JobView, JsonValue, UserScope } from "../../contract/index";
import { codeOf, readJson, Serial, writeJson } from "./disk";
import type { Site } from "./site";

/** The digits a start's time is written in: more than any clock counts to. */
const WIDTH = 16;
const ID = /^[A-Za-z0-9._-]+$/;
const SUFFIX = ".json";

/** The name of a job's file, without its ending: its start's time, a `~` no id holds, and its id. */
function stemOf(job: Pick<JobView, "id" | "started">): string {
  return `${String(Math.max(0, Math.floor(job.started))).padStart(WIDTH, "0")}~${job.id}`;
}

function checked(id: string): string {
  if (!ID.test(id)) throw new Error(`${JSON.stringify(id)} is not a job id: letters, digits, ".", "_" and "-".`);
  return id;
}

/** The stems of the records in a folder, the latest started first. */
async function stems(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder))
      .filter((name) => name.endsWith(SUFFIX) && name.includes("~"))
      .map((name) => name.slice(0, -SUFFIX.length))
      .sort()
      .reverse();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    throw error;
  }
}

async function read(folder: string, stem: string): Promise<JobView | undefined> {
  return (await readJson(join(folder, `${stem}${SUFFIX}`))) as JobView | undefined;
}

export function folderJobs(site: Site): JobRecords {
  const serial = new Serial();
  const folderOf = async (scope: UserScope): Promise<string> => join(await site.userFolder(scope), "jobs");

  return {
    async get(scope, id) {
      const folder = await folderOf(scope);
      const wanted = `~${checked(id)}`;
      const stem = (await stems(folder)).find((s) => s.endsWith(wanted));
      return stem === undefined ? undefined : read(folder, stem);
    },

    async set(scope, job) {
      const folder = await folderOf(scope);
      checked(job.id);
      const file = join(folder, `${stemOf(job)}${SUFFIX}`);
      await serial.run(file, () => writeJson(file, job as unknown as JsonValue));
    },

    async list(scope, query: JobQuery): Promise<JobPage> {
      const folder = await folderOf(scope);
      const all = await stems(folder);
      const { cursor } = query;
      const from = cursor === undefined ? 0 : all.findIndex((s) => s < cursor);
      const jobs: JobView[] = [];
      let last: string | undefined;
      let more = false;
      for (const stem of from < 0 ? [] : all.slice(from)) {
        if (query.limit !== undefined && jobs.length >= query.limit) {
          more = true;
          break;
        }
        last = stem;
        const job = await read(folder, stem);
        if (job === undefined) continue;
        if (query.chat !== undefined && job.scope.chat !== query.chat) continue;
        if (query.states !== undefined && !query.states.includes(job.state)) continue;
        jobs.push(job);
      }
      return { jobs, ...(more && last !== undefined ? { next: last } : {}) };
    },

    async prune(scope, before) {
      const folder = await folderOf(scope);
      let removed = 0;
      for (const stem of await stems(folder)) {
        if (Number(stem.slice(0, stem.indexOf("~"))) >= before) continue;
        const file = join(folder, `${stem}${SUFFIX}`);
        await serial.run(file, () => rm(file, { force: true }));
        removed += 1;
      }
      return removed;
    },
  };
}
