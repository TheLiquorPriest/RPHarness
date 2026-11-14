// The scripted-model rig (`rp-harness/testing/rig`): models that answer from a script, standing
// wherever a real one does, and the clock their waits run on.

export { FakeClock } from "./clock";
export { gate, scriptedModel, scriptedSource } from "./scripted";
export type { Answer, Gate, Piece, PushedPiece, RecordedOptions, RecordedRequest, Reply, ReplyUsage, ScriptedModel, ScriptedOptions } from "./scripted";
export type { AgentChoice, AgentModel, ModelSource } from "../../model/source";
