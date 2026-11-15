// Where the folder host keeps everything, and the checks every scope passes before the host acts
// on it: the scope is this host's user's whatever letters his name holds (an empty name is none),
// and its other ids are safe to put in a path.
//
//   <dir>/files/                          the agents' tree (§5): the global level
//   <dir>/files/defaults/                 the shipped level
//   <dir>/files/chats/<character>/        a character level
//   <dir>/files/chats/<character>/<chat>/ a chat level, the agents' root
//   <dir>/host/                           the host's own records, never in an agent's view
//   <dir>/host/user/<hash>/               one user's own records: <hash> is the SHA-256 of his name in hex, never the name itself

import { join } from "node:path";
import type { Scope, UserScope } from "../../contract/index";
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
  /** The one user this host serves. */
  readonly user: string;
  /** His folder's name under `host/user/`: the hash of his name, so two names never share a folder, whatever the disk's rule on case, and a name of any length or letters fits. */
  readonly #hash: string;
  /** Settles once his folder holds his name, written the first time the folder is used and checked against it every time this host is made. */
  #named: Promise<void> | undefined;

  constructor(dir: string, user: string) {
    this.dir = dir;
    this.files = join(dir, "files");
    this.host = join(dir, "host");
    this.user = user;
    this.#hash = sha256(user);
  }

  /** The one rule for a user's name at every port of this host: it is the user this host serves, and it is a name. */
  serves(scope: UserScope): void {
    if (scope.user === "") throw new Error("The folder host serves no user with an empty name.");
    if (scope.user !== this.user) throw new Error(`The folder host serves the user ${JSON.stringify(this.user)}, not ${JSON.stringify(scope.user)}.`);
  }

  /** Refuses a scope that is not this host's user's, or whose ids could reach outside a folder. */
  check(scope: Scope): void {
    this.serves(scope);
    safeId("chat", scope.chat);
    safeId("session", scope.session);
    if (scope.turn !== undefined) safeId("turn", scope.turn);
  }

  /** The user's own folder of the host's records, `host/user/<hash>/`: refused for a user this host does not serve; it holds his name in `user.json`, which the first use of the folder writes and checks. */
  async userFolder(scope: UserScope): Promise<string> {
    this.serves(scope);
    const folder = join(this.host, "user", this.#hash);
    const named = (this.#named ??= this.#keepName(folder).catch((error: unknown) => {
      this.#named = undefined;
      throw error;
    }));
    await named;
    return folder;
  }

  async #keepName(folder: string): Promise<void> {
    const file = join(folder, "user.json");
    const found = (await readJson(file)) as { user?: unknown } | undefined;
    if (found === undefined) await writeJson(file, { user: this.user });
    else if (found.user !== this.user) throw new Error(`The folder ${folder} is kept for the user ${JSON.stringify(found.user)}, not for ${JSON.stringify(this.user)}.`);
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
    return chatRecord(path, value);
  }

  /** Where the chat's levels are on disk. */
  async location(scope: Scope): Promise<ChatLocation> {
    const chat = await this.chat(scope);
    return { files: this.files, character: safeId("character folder", chat.character), chat: scope.chat };
  }
}
