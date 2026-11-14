// Values read from outside the layer (a host's document, a server's answer): checked before use,
// never trusted.

/** A plain object (not null, not an array): its fields are still to be checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A record's own field: a key such as `__proto__` reads nothing it doesn't hold itself. */
export function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A number of tokens as a person or a server gives one: a whole number above 0. */
export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
