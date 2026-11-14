// Small durable state RPH keeps through the host (Appendix A: jobs, approvals, token counts): JSON
// values by key, each read and written whole, that outlive a restart (§13.5: a job that was running
// is listed as interrupted after one).

import type { JsonValue } from "./json";

/**
 * A key: segments of letters, digits, `.`, `_` and `-`, joined by "/" (`jobs/9f2c`,
 * `usage/2026-11-13`). No segment is empty, `.` or `..`.
 */
export type StoreKey = string;

export interface StorePort {
  /** The value under `key`; undefined when there is none. */
  get(key: StoreKey): Promise<JsonValue | undefined>;
  /** Keeps `value` under `key`, whole, in place of what was there. */
  set(key: StoreKey, value: JsonValue): Promise<void>;
  /**
   * Changes the value under `key` by `change`, which is given the value as it stands (undefined:
   * none) and returns the new one (undefined: remove it). Changes to one key run one at a time, each
   * seeing the last one's result, so counts kept by agents running at once add up. Resolves with
   * the value kept.
   */
  update(key: StoreKey, change: (current: JsonValue | undefined) => JsonValue | undefined): Promise<JsonValue | undefined>;
  /** Removes the value under `key`; a key with none is passed over. */
  delete(key: StoreKey): Promise<void>;
  /** Every key that starts with `prefix`, in no set order. */
  list(prefix: string): Promise<StoreKey[]>;
}
