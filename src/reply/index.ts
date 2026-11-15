// The reply: its forms (the tag form, the plain text of a message), one per generation, held back
// by sentences while a rule that interrupts covers it, and the progress lines that keep a long turn
// alive.
export { ReplyDesk } from "./desk";
export { MessageReply, type MessageReplyOptions } from "./message";
export { KeepAlive, type KeepAliveOptions } from "./progress";
export { Release } from "./release";
export { heldSentences, TagReply, type TagReplyOptions } from "./reply";
export { lastSentences, sentenceEnds } from "./sentences";
export { outsideTags, type ReplyTags, type TagPart, TagParser, type TagRole } from "./tags";
