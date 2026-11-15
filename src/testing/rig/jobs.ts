// The store's typed part for job records, kept in memory: what a test host that keeps its store in
// memory gives for `StorePort.jobs`. It does what the contract says and what the folder host does:
// each user's records apart, the latest started first, a page and the cursor after it, the records
// of a chat or of some states only, and the ones started before a time removed.

import type { JobPage, JobQuery, JobRecords, JobView } from "../../contract";

export function memoryJobs(): JobRecords {
  const kept = new Map<string, Map<string, JobView>>();
  const of = (user: string): Map<string, JobView> => {
    let own = kept.get(user);
    if (own === undefined) {
      own = new Map();
      kept.set(user, own);
    }
    return own;
  };
  /** The key records are ordered by, the latest started first when read backwards: the start's time, then the id. */
  const orderOf = (job: JobView): string => `${String(Math.max(0, Math.floor(job.started))).padStart(16, "0")}~${job.id}`;

  return {
    async get(scope, id) {
      const job = of(scope.user).get(id);
      return job === undefined ? undefined : structuredClone(job);
    },
    async set(scope, job) {
      of(scope.user).set(job.id, structuredClone(job));
    },
    async list(scope, query: JobQuery): Promise<JobPage> {
      const { cursor } = query;
      const ordered = [...of(scope.user).values()].sort((a, b) => (orderOf(a) < orderOf(b) ? 1 : -1)).filter((job) => cursor === undefined || orderOf(job) < cursor);
      const jobs: JobView[] = [];
      let last: JobView | undefined;
      let more = false;
      for (const job of ordered) {
        if (query.limit !== undefined && jobs.length >= query.limit) {
          more = true;
          break;
        }
        last = job;
        if (query.chat !== undefined && job.scope.chat !== query.chat) continue;
        if (query.states !== undefined && !query.states.includes(job.state)) continue;
        jobs.push(structuredClone(job));
      }
      return { jobs, ...(more && last !== undefined ? { next: orderOf(last) } : {}) };
    },
    async prune(scope, before) {
      const own = of(scope.user);
      let removed = 0;
      for (const [id, job] of own) {
        if (job.started >= before) continue;
        own.delete(id);
        removed += 1;
      }
      return removed;
    },
  };
}
