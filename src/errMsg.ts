/** Extracts a display-safe message from a caught value of unknown type (`useUnknownInCatchVariables`).
 *  A plain object (e.g. a non-Error rejection from an Observable, or a datasource/network failure
 *  that never got wrapped into an Error) must not fall through to bare `String(e)` — that always
 *  renders as the useless literal "[object Object]". JSON.stringify it instead so whatever shape
 *  the caller actually threw stays visible. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === 'string') {
    return e;
  }
  if (e && typeof e === 'object') {
    try {
      return JSON.stringify(e);
    } catch {
      return 'An error occurred that could not be serialized.';
    }
  }
  return String(e);
}
