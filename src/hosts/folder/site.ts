// Where the folder host keeps everything, and the checks every scope passes before the host acts
// on it: the scope is this host's user's, and its ids are safe to put in a path.
//
//   <dir>/files/                          the agents' tree (§5): the global level
//   <dir>/files/defaults/                 the shipped level
//   <dir>/files/chats/<character>/        a character level
//   <dir>/files/chats/<character>/<chat>/ a chat level, the agents' root
//   <dir>/host/                           the host's own records, never in an agent's view

import { join } from "node:path";
import type { Scope } from "../../contract/index";
import { readJson, safeId } from "./disk";
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

  constructor(dir: string, user: string) {
    this.dir = dir;
    this.files = join(dir, "files");
    this.host = join(dir, "host");
    this.user = user;
  }

  /** Refuses a scope that is not this host's user's, or whose ids could reach outside a folder. */
  check(scope: Scope): void {
    if (scope.user !== this.user) throw new Error(`The folder host serves the user ${JSON.stringify(this.user)}, not ${JSON.stringify(scope.user)}.`);
    safeId("chat", scope.chat);
    safeId("session", scope.session);
    if (scope.turn !== undefined) safeId("turn", scope.turn);
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
