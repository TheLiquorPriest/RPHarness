// The folder host's clock (the machine's own) and its log (lines of `host/log.jsonl`).

import type { Clock, JsonValue, Log, LogLevel } from "../../contract/index";
import type { Appender } from "./disk";

/** The machine's clock. A test gives its own. */
export const machineClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as Timer),
};

/** A log whose lines go to a file, in order, without the caller waiting. */
export function fileLog(path: string, appender: Appender, clock: Clock): Log {
  const line = (level: LogLevel) => (message: string, fields?: Record<string, JsonValue>) => appender.line(path, { at: clock.now(), level, message, ...(fields !== undefined ? { fields } : {}) });
  return { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error") };
}
