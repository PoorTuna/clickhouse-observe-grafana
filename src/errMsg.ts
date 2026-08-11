/** Extracts a display-safe message from a caught value of unknown type (`useUnknownInCatchVariables`). */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
