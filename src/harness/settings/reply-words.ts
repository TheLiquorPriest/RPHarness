// The settings of the reply and of the progress lines, as the Settings page names each and says what it is for.
export const REPLY_WORDS = {
  "reply.form": { name: "Reply form", about: "How a connection marks its reply: with tags, or in two steps for a connection that does not keep them." },
  "reply.forms.<connection>": { name: "Reply form of a connection", about: "The reply form of this connection, in place of the one every connection takes." },
  "reply.streamAnyway": { name: "Two-step connections that stream", about: "Two-step connections whose replies are shown as they are written, not when their message ends." },
  "reply.heldSentences": { name: "Sentences held back", about: "Sentences the reply is held back by while a rule that interrupts covers it." },
  "reply.tailSentences": { name: "Sentences shown again", about: "Sentences of what was already shown that go with the line an agent goes on under after a rule stopped it." },
  "reply.leadSampling": { name: "The lead's sampling", about: "Whether the lead samples as its own model does, or as the chat's preset says." },
  "reply.intentWait": { name: "Wait for the intent record", about: "Seconds a tool or the reply waits, at most, for the intent record written before it to be kept; 0 waits for nothing." },
  "progress.show": { name: "Progress lines", about: "All the progress lines in the chat's thinking block, or the least: only the line that keeps a silent turn alive." },
  "progress.silence": { name: "Silence before a progress line", about: "Seconds of nothing shown before a progress line goes to the chat's thinking block; at most nine minutes, since a generation that shows nothing for ten is ended." },
};
