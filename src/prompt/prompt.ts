// One turn's prompt, cut into named slices (§4.8): by its learned map where its preset has one, by
// its raw layout alone where it has none. History is addressed by message and lore by entry, so
// neither needs learning. RPH reads the facts from the host's prompt port once per turn and keeps
// them here, for the `prompt` tool, for what an agent is given by name, and for the turn's views.
import type { ActivatedLore, Environment, PresetRef, PromptMap, PromptMessage, PromptNotice, PromptRole, RawLayout, Scope, SliceBehaviour, SliceKind } from "../contract";
import { type Cut, cut, namePlaces, type Piece } from "./cut";
import { locate } from "./locate";
import { noticesOf, type PromptRecord } from "./shape";
import { mergedSpans, messageText, type Span, spannedText } from "./text";

/** How a slice of this prompt got its name: the learned map, the chat application's block, its place, a chat message, a lore part; or it is text no slice of the map claims, named by its place. */
export type SliceFrom = "map" | "block" | "place" | "history" | "lore" | "unclaimed";

/** One named part of this turn's prompt, and where it is. */
export interface Slice {
  marker: string;
  kind: SliceKind;
  /** Where it is, in prompt order. */
  spans: Span[];
  /** The role of the message its first span is in. */
  role: PromptRole;
  from: SliceFrom;
  /** From the learned map: one line on what it is, and how it behaves. */
  line?: string;
  behaviour?: SliceBehaviour;
  /** The chat application's name for it, where it is one of the breakdown's blocks: the name and type. */
  block?: { name: string; type: string };
  /** For a history message: the chat message, by id and place on the path, and the speaker's name where the prompt gave one. */
  source?: { id: string; index: number; name?: string };
}

/** Where the turn's prompt facts come from. */
export interface PromptSources {
  env: Pick<Environment, "prompt" | "lore" | "log">;
  scope: Scope;
  /** The prompt as the request carries it (`TurnRequest.prompt`). */
  messages: readonly PromptMessage[];
}

/** What the host gave of this prompt. */
export interface PromptFacts {
  /** None: the host could not give it. */
  layout: RawLayout | undefined;
  map: PromptMap | undefined;
  activated: readonly ActivatedLore[];
}

/** One turn's prompt, its slices found. */
export class TurnPrompt {
  readonly sources: PromptSources;
  readonly facts: PromptFacts;
  /** Each message's text. */
  readonly texts: readonly string[];
  readonly roles: readonly PromptRole[];
  /** The prompt as its raw layout cuts it. */
  readonly cut: Cut;
  #slices: Slice[];
  /** What the turn this one follows held of its prompt, once compared with it. */
  #before: PromptRecord | undefined;

  /** Reads the layout, the map and the lore that activated from the host, and finds the slices. What the host cannot give is logged and taken as none. */
  static async read(sources: PromptSources): Promise<TurnPrompt> {
    const { env, scope } = sources;
    const warn = (what: string) => (error: unknown) => {
      env.log.warn(what, { ...(scope.turn !== undefined ? { turn: scope.turn } : {}), error: error instanceof Error ? error.message : String(error) });
      return undefined;
    };
    const [layout, map, activated] = await Promise.all([
      env.prompt.layout(scope).catch(warn("The host could not give the prompt's layout.")),
      env.prompt.map(scope).catch(warn("The host could not give the prompt map.")),
      env.lore.activated(scope).catch(warn("The host could not say which lore activated.")),
    ]);
    return new TurnPrompt(sources, { layout, map, activated: activated ?? [] });
  }

  constructor(sources: PromptSources, facts: PromptFacts) {
    this.sources = sources;
    this.facts = { ...facts };
    this.texts = sources.messages.map(messageText);
    this.roles = sources.messages.map((message) => message.role);
    this.cut = cut(this.texts, this.roles, facts.layout);
    this.#slices = this.#find();
  }

  /** Finds the slices again by `map`, newly learned for this prompt's preset. */
  remap(map: PromptMap): void {
    this.facts.map = map;
    this.#slices = this.#find();
  }

  /** Whether the slices are the learned map's: there is one, and the layout told this prompt's text apart. */
  get mapped(): boolean {
    return this.facts.map !== undefined && this.cut.fits && this.facts.layout?.complete === true;
  }

  /** Every named part of the prompt, in prompt order. */
  get slices(): readonly Slice[] {
    return this.#slices;
  }

  /** The preset the prompt was assembled from, where the host can tell. */
  get preset(): PresetRef | null {
    return this.facts.layout?.preset ?? null;
  }

  /** A slice's text, as it stands in the prompt. */
  text(slice: Pick<Slice, "spans">): string {
    return spannedText(this.texts, slice.spans);
  }

  /** Compares this prompt with what the turn it follows held (`PromptMemory`): the notices are then those since that turn. */
  compareWith(before: PromptRecord | undefined): void {
    this.#before = before;
  }

  /**
   * The notices about the prompt's shape (§4.8), compared with the turn before once `compareWith`
   * has been given it, else with the map itself. Facts only; they are said in the words of a file.
   */
  get notices(): PromptNotice[] {
    return noticesOf(this, this.#before);
  }

  #find(): Slice[] {
    const map = this.facts.map;
    return map !== undefined && this.mapped ? this.#learnedSlices(map) : this.cut.pieces.map((piece) => this.#pieceSlice(piece));
  }

  /** The role of the part a stretch of text begins in. */
  #roleAt(span: Span): PromptRole {
    const piece = this.cut.pieces.find((p) => p.span.message === span.message && p.span.start <= span.start && span.start < p.span.end);
    return piece?.role ?? this.facts.layout?.messages[span.message]?.parts.find((part) => part.start <= span.start && span.start < part.end)?.role ?? this.roles[span.message] ?? "system";
  }

  /** The learned map's slices where they were found, history and lore as they are, and the free text no slice claims, named by place. */
  #learnedSlices(map: PromptMap): Slice[] {
    const blocks = this.facts.layout?.blocks ?? [];
    const found = locate(this.texts, this.cut.pieces, map, (piece) => (piece.block === undefined ? undefined : blocks[piece.block]?.name));
    const slices: Slice[] = [];
    const placed: { span: Span; name: string; slice: Slice }[] = [];
    const others = new Map<number, number>();
    const count = (spans: readonly Span[]) => {
      for (const message of new Set(spans.map((span) => span.message))) others.set(message, (others.get(message) ?? 0) + 1);
    };
    for (const piece of this.cut.pieces) {
      if (piece.kind !== "history" && piece.kind !== "lore") continue;
      const slice = this.#pieceSlice(piece);
      slices.push(slice);
      if (piece.kind === "lore") placed.push({ span: piece.span, name: slice.marker, slice });
      else count(slice.spans);
    }
    map.slices.forEach((learned, at) => {
      const spans = found.spans.get(at);
      if (spans === undefined || spans.length === 0) return;
      const merged = mergedSpans(this.texts, spans);
      const block = this.cut.pieces.find((piece) => piece.kind === "block" && merged.some((span) => span.message === piece.span.message && span.start <= piece.span.start && piece.span.end <= span.end));
      const raw = block?.block === undefined ? undefined : blocks[block.block];
      count(merged);
      slices.push({
        marker: learned.marker,
        kind: learned.kind,
        spans: merged,
        role: this.#roleAt(merged[0] ?? { message: 0, start: 0, end: 0 }),
        from: "map",
        line: learned.line,
        behaviour: learned.behaviour,
        ...(raw !== undefined ? { block: { name: raw.name, type: raw.type } } : {}),
      });
    });
    for (const span of found.unclaimed) {
      const slice: Slice = { marker: "", kind: "other", spans: [span], role: this.#roleAt(span), from: "unclaimed" };
      slices.push(slice);
      placed.push({ span, name: "", slice });
    }
    namePlaces(placed, (message) => others.get(message) ?? 0);
    for (const item of placed) item.slice.marker = item.name;
    return slices.sort((a, b) => (a.spans[0]?.message ?? 0) - (b.spans[0]?.message ?? 0) || (a.spans[0]?.start ?? 0) - (b.spans[0]?.start ?? 0));
  }

  #pieceSlice(piece: Piece): Slice {
    const base = { marker: piece.name, spans: [piece.span], role: piece.role };
    switch (piece.kind) {
      case "history": {
        const name = this.sources.messages[piece.span.message]?.name;
        return { ...base, kind: "history", from: "history", ...(piece.source !== undefined ? { source: { ...piece.source, ...(name !== undefined ? { name } : {}) } } : {}) };
      }
      case "lore":
        return { ...base, kind: "lore", from: "lore" };
      case "block": {
        const block = piece.block === undefined ? undefined : this.facts.layout?.blocks[piece.block];
        return { ...base, kind: "other", from: "block", ...(block !== undefined ? { block: { name: block.name, type: block.type } } : {}) };
      }
      case "loose":
        return { ...base, kind: "other", from: "place" };
    }
  }
}
