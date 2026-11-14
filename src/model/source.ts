// What a runner asks for to run an agent: the model pi's `Agent` is given, the level it thinks at,
// the stream function the agent calls its model through, and the model's limits. The model layer
// gives one for a connection's model (index.ts); the scripted-model rig gives one for a script
// (testing/rig), in the same shape, so a runner takes either.

import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelLimits } from "../contract";

/**
 * How hard an agent's model reasons: `inherit` and `auto` leave it to the connection's own effort
 * (where it sets none, the provider's default); `off` turns reasoning off; the rest ask for that
 * level, or the nearest the model has.
 */
export type ModelEffort = "inherit" | "auto" | ModelThinkingLevel;

/** What an agent runs on: a connection (null: the default), a model on it (null: the connection's own), and how hard it reasons (absent: `inherit`). */
export interface AgentChoice {
  connectionId: string | null;
  model: string | null;
  effort?: ModelEffort;
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
  /** The model an agent runs on; rejects, in words that say what to do, when there is none to run on. */
  agentModel(choice: AgentChoice): Promise<AgentModel>;
}
