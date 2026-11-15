// What a runner asks for to run an agent: the model pi's `Agent` is given, the level it thinks at,
// the stream function the agent calls its model through, and the model's limits. The model layer
// gives one for a connection's model (index.ts); the scripted-model rig gives one for a script
// (testing/rig), in the same shape, so a runner takes either.

import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelLimits, Scope, ToolsAs } from "../contract";

/**
 * How hard an agent's model reasons: `inherit` and `auto` leave it to the connection's own effort
 * (where it sets none, the provider's default); `off` turns reasoning off; the rest ask for that
 * level, or the nearest the model has.
 */
export type ModelEffort = "inherit" | "auto" | ModelThinkingLevel;

/** What an agent runs on, among one user's connections: a connection (null: his default), a model on it (null: the connection's own), how hard it reasons (absent: `inherit`), and how its tools are offered (absent: `auto`). */
export interface AgentChoice {
  connectionId: string | null;
  model: string | null;
  effort?: ModelEffort;
  toolsAs?: ToolsAs;
}

/**
 * An agent's choice as the harness asks for it: the user it acts for, whose connections the choice is
 * among. A connection's id, and which connection is the default, are one user's alone (READINGS R-52).
 * `scope` is the scope of the run the agent is in: its calls read the model layer's settings at its
 * chat's levels. Absent, the agent has no chat in view, and its calls read the levels every chat shares.
 */
export interface UserChoice extends AgentChoice {
  user: string;
  scope?: Scope;
}

export interface AgentModel {
  /** `initialState.model` of the agent's `Agent`. */
  model: Model<Api>;
  /** `initialState.thinkingLevel`. */
  thinkingLevel: ThinkingLevel;
  /** The agent's `streamFn`. */
  streamFn: StreamFn;
  limits: ModelLimits;
}

export interface ModelSource {
  /** The model an agent runs on, from the connections of the user the choice names; rejects, in words that say what to do, when there is none to run on. */
  agentModel(choice: UserChoice): Promise<AgentModel>;
  /** One of the user's agent sessions ended: what is kept for its prompt cache is let go, his alone (the model layer's `ended`). Absent: nothing is kept. */
  ended?(user: string, sessionId: string): void;
}
