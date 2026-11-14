// The folder host's clock (the machine's own, the user's day by the machine's time zone) and its
// log (lines of `host/log.jsonl`).

import type { Clock, JsonValue, Log, LogLevel } from "../../contract/index";
import type { Appender } from "./disk";

/** The machine's clock. A test gives its own. */
export const machineClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as Timer),
  day(at) {
    const d = new Date(at ?? Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  },
};

/** A log whose lines go to a file, in order, without the caller waiting. */
export function fileLog(path: string, appender: Appender, clock: Clock): Log {
  const line = (level: LogLevel) => (message: string, fields?: Record<string, JsonValue>) => appender.line(path, { at: clock.now(), level, message, ...(fields !== undefined ? { fields } : {}) });
  return { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error") };
}
