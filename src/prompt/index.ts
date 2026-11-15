// The prompt map (§4.8): a turn's prompt cut into named slices, by its raw layout until a map is
// learned and by the learned map after; one resolver for names; the `prompt` and
// `prompt_map_write` tools; the notices and the front measured each turn; the turn folder's views.
export { type Learned, learn, type WrittenSlice } from "./learn";
export { type PromptTurnInput, PromptMemory, promptTurn } from "./memory";
export { findName, type Item, SLICE_KINDS } from "./names";
export { type PromptFacts, type PromptSources, type Slice, type SliceFrom, TurnPrompt } from "./prompt";
export { locatedOf, noticesOf, type PromptRecord, recordOf } from "./shape";
export { PROMPT_TOOLS, promptMapWrite, promptSlice, promptTool, type PromptToolsDeps } from "./tools";
export { type PromptView, promptViews, type ViewWrites, writeViews } from "./views";
export { laid, noticeLines, PROMPT_PART, promptWords } from "./words";
