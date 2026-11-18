export const REPLY_WORDS = {
  "reply.form": { name: "Reply form", about: "How a connection marks its reply: with tags, or in two steps for a connection that does not keep them." },
  "connections.<connection>.reply.form": { name: "Reply form of a connection", about: "The reply form of this connection, in place of the one every connection takes." },
  "reply.check.turns": { name: "Turns a tag check plays", about: "Simple turns a tag check plays on a connection to see whether it keeps the reply's tags." },
  "reply.check.kept": { name: "Turns that must keep the tags", about: "Turns of a tag check that must come back with the reply and the intent record in their tags for the connection to be given the tag form; fewer give it the two-step form." },
  "reply.streamAnyway": { name: "Two-step connections that stream", about: "Two-step connections whose replies are shown as they are written, not when their message ends." },
  "reply.heldSentences": { name: "Sentences held back", about: "Sentences the reply is held back by while a rule that interrupts covers it." },
  "reply.tailSentences": { name: "Sentences shown again", about: "Sentences of what was already shown that go with the line an agent goes on under after a rule stopped it." },
  "reply.leadSampling": { name: "The lead's sampling", about: "Whether the lead samples as its own model does, or as the chat's preset says." },
  "progress.show": { name: "Progress lines", about: "All the progress lines in the chat's thinking block, or the least: only the line that keeps a silent turn alive." },
  "progress.silenceSeconds": { name: "Silence before a progress line", about: "Seconds of nothing shown before a progress line goes to the chat's thinking block.", above: "Lumiverse ends a generation that has shown nothing for ten minutes: past nine, a silent turn may be cut off before its progress line comes." },
  "progress.thinking": { name: "Thinking in the chat", about: "Whose thinking goes to the chat's thinking block as the model writes it, between the progress lines: lines, the progress lines alone; lead, the lead agent's; all, every agent's of the turn, each stretch under its agent's name. An agent's thinking can hold what the story has not shown yet, and the chat application keeps it with the message." },
};
