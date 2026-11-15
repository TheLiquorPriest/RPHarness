export const CALLS_WORDS = {
  "limits.answerFloor": { name: "Least room for an answer", about: "Tokens an answer must have left at least, across every limit on tokens written; with less, no call is made and the work ends at the limit." },
  "tokens.charsPerToken": { name: "Characters per token", about: "Characters counted as one token when a prompt is measured before its provider counts it: whether a call fits, when to compact, and the trace's figures." },
  "sampling.<definition>.temperature": { name: "Temperature", about: "The temperature every call of this agent is made with; unset, its provider's own." },
  "sampling.<definition>.top_p": { name: "Top P", about: "The top P every call of this agent is made with, where its provider takes one; unset, its provider's own." },
  "sampling.<definition>.top_k": { name: "Top K", about: "The top K every call of this agent is made with, where its provider takes one; unset, its provider's own." },
  "sampling.<definition>.frequency_penalty": { name: "Frequency penalty", about: "The frequency penalty every call of this agent is made with, where its provider takes one; unset, its provider's own." },
  "sampling.<definition>.presence_penalty": { name: "Presence penalty", about: "The presence penalty every call of this agent is made with, where its provider takes one; unset, its provider's own." },
  "sampling.<definition>.repetition_penalty": { name: "Repetition penalty", about: "The repetition penalty every call of this agent is made with, where its provider takes one; unset, its provider's own." },
};
