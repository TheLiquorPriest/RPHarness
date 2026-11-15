// Where a connection's key and its headers' values were given for (READINGS R-53): its provider, and
// its address's origin and path, or none for the provider's own address. The model layer keeps each
// one's place beside it with the secrets, and sends it only there; a host that writes keys for the
// layer (a migration carrying keys over) writes their places in this same form. It reads only what
// it is given, so a host may import it from RPH's helpers.

/** A connection's place, as the secrets keep it beside its key and headers' values (`SecretsDoc.places`), and as a switch for the connection names it (`target`). */
export function placeOf(provider: string, baseUrl: string | null | undefined): string {
  const address = baseUrl?.trim() ?? "";
  if (address === "") return JSON.stringify([provider, null]);
  try {
    const url = new URL(address);
    return JSON.stringify([provider, `${url.origin}${url.pathname}`.replace(/\/+$/, "")]);
  } catch {
    // What isn't an address is a place of its own: an address it becomes is another.
    return JSON.stringify([provider, address]);
  }
}
