export const HOOKS_WORDS = {
  "hooks.timeoutSeconds": { name: "Time a hook may take", about: "Seconds one of your hooks may take where hooks.yml names no timeout of its own; past them it is stopped, blocks nothing, and is shown as timed out." },
  "hooks.blockExit": { name: "Exit code that blocks", about: "The exit code with which a hook blocks, its error output as the reason; any other failing code blocks nothing and is shown as failed." },
  "hooks.maxAnswerBytes": { name: "Most of a hook's answer read", about: "Bytes read of what a hook answers; an answer past them is cut, blocks nothing, and is shown as failed." },
  "hooks.reasonChars": { name: "Most of a hook's reason kept", about: "Characters of a hook's error output kept as its reason or as why it failed; the last of them are kept." },
};
