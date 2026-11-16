// Where the folder host keeps everything, and the checks every scope passes before the host acts
// on it: the scope is one of this host's users' whatever letters his name holds (an empty name is
// none), a chat is its own user's where `chat.json` names one, and its other ids are safe to put in
// a path.
//
//   <dir>/files/                          the agents' tree (§5): the global level
//   <dir>/files/defaults/                 the shipped level
//   <dir>/files/chats/<character>/        a character level
//   <dir>/files/chats/<character>/<chat>/ a chat level, the agents' root
//   <dir>/host/                           the host's own records, never in an agent's view
//   <dir>/host/user/<hash>/               one user's own records: <hash> is the SHA-256 of his name in hex, never the name itself

import { join } from "node:path";
import type { RunScope, Scope, UserScope } from "../../contract/index";
import { readJson, safeId, sha256, writeJson } from "./disk";
import type { ChatRecord } from "./shape";
import { chatRecord } from "./shape";
import type { ChatLocation } from "./view";

export class Site {
  readonly dir: string;
  /** The agents' tree. */
  readonly files: string;
  /** The host's own records. */
  readonly host: string;
  /** The users this host serves, each with his own records. */
  readonly users: readonly string[];
  /** The first of them: whom the host's command line acts for when it names no one. */
  readonly user: string;
  /** Per user, settles once his folder holds his name, written the first time the folder is used and checked against it every time this host is made. */
  readonly #named = new Map<string, Promise<void>>();

  constructor(dir: string, users: string | readonly string[]) {
    this.dir = dir;
    this.files = join(dir, "files");
    this.host = join(dir, "host");
    const list = typeof users === "string" ? [users] : [...new Set(users)];
    const first = list[0];
    if (first === undefined) throw new Error("The folder host serves at least one user.");
    this.users = list;
    this.user = first;
  }

  /** The one rule for a user's name at every port of this host: it is a user this host serves, and it is a name. */
  serves(scope: UserScope): void {
    if (scope.user === "") throw new Error("The folder host serves no user with an empty name.");
    if (!this.users.includes(scope.user)) throw new Error(`The folder host serves ${this.users.length === 1 ? `the user ${JSON.stringify(this.user)}` : `the users ${this.users.map((u) => JSON.stringify(u)).join(", ")}`}, not ${JSON.stringify(scope.user)}.`);
  }

  /** Refuses a scope that is not this host's user's, or whose ids could reach outside a folder; a job's of no chat has only its session. */
  check(scope: RunScope): void {
    this.serves(scope);
    if (scope.chat !== undefined) safeId("chat", scope.chat);
    safeId("session", scope.session);
    if (scope.turn !== undefined) safeId("turn", scope.turn);
  }

  /** A user's own folder of the host's records, `host/user/<hash>/` (his name's hash, so two names never share a folder, whatever the disk's rule on case): its path alone, the user checked. */
  userRecords(scope: UserScope): string {
    this.serves(scope);
    return join(this.host, "user", sha256(scope.user));
  }

  /** A user's own folder of the host's records: refused for a user this host does not serve; it holds his name in `user.json`, which the first use of the folder writes and checks. */
  async userFolder(scope: UserScope): Promise<string> {
    const folder = this.userRecords(scope);
    let named = this.#named.get(scope.user);
    if (named === undefined) {
      named = this.#keepName(folder, scope.user).catch((error: unknown) => {
        this.#named.delete(scope.user);
        throw error;
      });
      this.#named.set(scope.user, named);
    }
    await named;
    return folder;
  }

  async #keepName(folder: string, user: string): Promise<void> {
    const file = join(folder, "user.json");
    const found = (await readJson(file)) as { user?: unknown } | undefined;
    if (found === undefined) await writeJson(file, { user });
    else if (found.user !== user) throw new Error(`The folder ${folder} is kept for the user ${JSON.stringify(found.user)}, not for ${JSON.stringify(user)}.`);
  }

  /** Where a run's records are kept: its chat's, or, for a job of no chat, its user's own. */
  recordsOf(scope: RunScope): string {
    this.check(scope);
    return scope.chat === undefined ? this.userRecords(scope) : this.chatRecords(scope.chat);
  }

  /** The host's records of a chat. */
  chatRecords(chat: string): string {
    return join(this.host, "chats", safeId("chat", chat));
  }

  /** The host's records of a turn. */
  turnRecords(chat: string, turn: string): string {
    return join(this.chatRecords(chat), "turns", safeId("turn", turn));
  }

  /** The chat as `chat.json` describes it; a chat the host has no record of is an error. */
  async chat(scope: Scope): Promise<ChatRecord> {
    this.check(scope);
    const path = join(this.chatRecords(scope.chat), "chat.json");
    const value = await readJson(path);
    if (value === undefined) throw new Error(`The folder host has no chat ${JSON.stringify(scope.chat)}: ${path} is not there.`);
    const record = chatRecord(path, value);
    if (record.user !== undefined && record.user !== scope.user) throw new Error(`The chat ${JSON.stringify(scope.chat)} is ${JSON.stringify(record.user)}'s, not ${JSON.stringify(scope.user)}'s.`);
    return record;
  }

  /** Where the chat's levels are on disk. */
  async location(scope: Scope): Promise<ChatLocation> {
    const chat = await this.chat(scope);
    return { files: this.files, character: safeId("character folder", chat.character), chat: scope.chat };
  }

  /** The chat's own level on disk, where its generated files (`PROMPT-MAP.md`, `LORE-INDEX.md`) are written. */
  async chatFolder(scope: Scope): Promise<string> {
    const loc = await this.location(scope);
    return join(loc.files, "chats", loc.character, safeId("chat", loc.chat));
  }
}
