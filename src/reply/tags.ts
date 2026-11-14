// Reads a model's text as it streams and says which parts lie inside which tag (§10.7, the reply's
// tag form). The names are configuration: the reply contract's file sets them in its header and
// nowhere else, so this file names no tag.

/** The two marked parts of a message in the tag form, by the names the reply contract's header gives. */
export interface ReplyTags {
  /** What the player is shown. */
  reply: string;
  /** The lead's intent record, kept and shown in the live view, never sent into the chat. */
  intent: string;
}

/** Which marked part a piece of text is in; `undefined` is outside every tag (working text). */
export type TagRole = keyof ReplyTags;

/** What the parser found in a piece: text in a part, or a part opening or closing. */
export type TagPart =
  | { kind: "text"; role: TagRole | undefined; text: string }
  | { kind: "open"; role: TagRole }
  | { kind: "close"; role: TagRole };

const NAME = /^[A-Za-z_][\w.-]*$/;

/**
 * A streaming parser for the tag form. Outside every part it looks for any part's opening tag;
 * inside a part it looks only for that part's closing tag, so a reply may quote anything. A tag
 * split across pieces is held back until the next piece tells it apart from text; nothing else is
 * held.
 */
export class TagParser {
  readonly #opens: ReadonlyMap<string, TagRole>;
  readonly #closes: Readonly<Record<TagRole, string>>;
  #role: TagRole | undefined;
  #pending = "";

  constructor(tags: ReplyTags) {
    for (const [role, name] of Object.entries(tags)) {
      if (!NAME.test(name)) throw new Error(`The reply contract's tag name for the ${role} is "${name}", which is not a name a tag can have.`);
    }
    if (tags.reply === tags.intent) throw new Error(`The reply contract gives the reply and the intent record the same tag name, "${tags.reply}".`);
    this.#opens = new Map<string, TagRole>([
      [`<${tags.reply}>`, "reply"],
      [`<${tags.intent}>`, "intent"],
    ]);
    this.#closes = { reply: `</${tags.reply}>`, intent: `</${tags.intent}>` };
  }

  /** The part the parser is inside now. */
  get inside(): TagRole | undefined {
    return this.#role;
  }

  /** Reads the next piece of the stream. */
  push(piece: string): TagPart[] {
    const parts: TagPart[] = [];
    let buffer = this.#pending + piece;
    this.#pending = "";
    for (;;) {
      const found = this.#find(buffer);
      if (found === undefined) break;
      if (found.at > 0) parts.push({ kind: "text", role: this.#role, text: buffer.slice(0, found.at) });
      if (this.#role === undefined) {
        this.#role = found.role;
        parts.push({ kind: "open", role: found.role });
      } else {
        parts.push({ kind: "close", role: this.#role });
        this.#role = undefined;
      }
      buffer = buffer.slice(found.at + found.tag.length);
    }
    // Only the last "<" can begin a tag that runs on into the next piece: a tag holds no other "<".
    const lt = buffer.lastIndexOf("<");
    if (lt >= 0) {
      const tail = buffer.slice(lt);
      if (this.#candidates().some((tag) => tag.length > tail.length && tag.startsWith(tail))) {
        this.#pending = tail;
        buffer = buffer.slice(0, lt);
      }
    }
    if (buffer !== "") parts.push({ kind: "text", role: this.#role, text: buffer });
    return parts;
  }

  /** The message ended: what was held as a possible tag is text after all. The parser starts the next message outside every part. */
  end(): TagPart[] {
    const parts: TagPart[] = this.#pending === "" ? [] : [{ kind: "text", role: this.#role, text: this.#pending }];
    this.reset();
    return parts;
  }

  /** Forgets the message in progress: a new message starts outside every part. */
  reset(): void {
    this.#role = undefined;
    this.#pending = "";
  }

  #candidates(): string[] {
    return this.#role === undefined ? [...this.#opens.keys()] : [this.#closes[this.#role]];
  }

  #find(buffer: string): { at: number; tag: string; role: TagRole } | undefined {
    let best: { at: number; tag: string; role: TagRole } | undefined;
    if (this.#role !== undefined) {
      const tag = this.#closes[this.#role];
      const at = buffer.indexOf(tag);
      return at < 0 ? undefined : { at, tag, role: this.#role };
    }
    for (const [tag, role] of this.#opens) {
      const at = buffer.indexOf(tag);
      if (at >= 0 && (best === undefined || at < best.at)) best = { at, tag, role };
    }
    return best;
  }
}
