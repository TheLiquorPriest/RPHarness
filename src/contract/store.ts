// Small durable state RPH keeps through the host (Appendix A: jobs, approvals, token counts): JSON
// values by key, each read and written whole, that outlive a restart (§13.5: a job that was running
// is listed as interrupted after one). Every value is a user's (Appendix B: every table carries the
// user; READINGS R-52): each member takes first the scope RPH acts for, a run's, a job's or a chat's,
// or the user's alone for what is his across his chats (his day's counts), and the host keeps every
// user's values apart, so the same key holds one value for each user and a list gives a user only
// his own keys.

import type { UserScope } from "./common";
import type { JsonValue } from "./json";

/**
 * A key: segments of letters, digits, `.`, `_` and `-`, joined by "/" (`jobs/9f2c`,
 * `usage/2026-11-13`). No segment is empty, `.` or `..`.
 */
export type StoreKey = string;

/**
 * Each member's `scope` is the one RPH acts for: a `Scope` where there is a chat (a run's, a job's,
 * a chat's), else the user's alone. The host keeps values by `scope.user`, never mixing two users'.
 */
export interface StorePort {
  /** The user's value under `key`; undefined when there is none. */
  get(scope: UserScope, key: StoreKey): Promise<JsonValue | undefined>;
  /** Keeps `value` under the user's `key`, whole, in place of what was there. */
  set(scope: UserScope, key: StoreKey, value: JsonValue): Promise<void>;
  /**
   * Changes the user's value under `key` by `change`, which is given the value as it stands
   * (undefined: none) and returns the new one (undefined: remove it). Changes to one user's key run
   * one at a time, each seeing the last one's result, so counts kept by agents running at once add
   * up. Resolves with the value kept.
   */
  update(scope: UserScope, key: StoreKey, change: (current: JsonValue | undefined) => JsonValue | undefined): Promise<JsonValue | undefined>;
  /** Removes the user's value under `key`; a key with none is passed over. */
  delete(scope: UserScope, key: StoreKey): Promise<void>;
  /** Every key of the user's that starts with `prefix`, in no set order: never another user's. */
  list(scope: UserScope, prefix: string): Promise<StoreKey[]>;
}
