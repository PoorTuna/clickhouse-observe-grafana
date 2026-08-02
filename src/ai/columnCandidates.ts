/**
 * Expands raw `system.columns` rows (Tuple/JSON containers) into the dotted leaf names the rest
 * of the app already knows how to address — see FieldsContext.tsx's Phase D (tuple) / Phase C
 * (JSON) for the discovery-side equivalent of this. `guessColumnMapping`/`parseMapping`
 * (columnGuess.ts) only ever compare against exact names in the candidate list handed to them, so
 * without this expansion a Tuple/JSON column can only ever be guessed (or hallucination-guarded
 * away) as its whole-container name — e.g. `trace` instead of `trace.id` — even though `trace.id`
 * is a perfectly valid ColumnMapping value once discovered.
 */

import { inferFieldType, parseTupleElements } from '../sql/fieldModel';
import { TableColumn } from './columnGuess';

export interface JsonPathsByColumn {
  [jsonColumn: string]: Array<{ path: string; chType: string }>;
}

/**
 * Expand Tuple/JSON container rows into dotted leaf candidates; drop the container row once it's
 * been successfully expanded so the model/dropdowns can't pick an unusable struct.
 *
 * - Tuple: always expanded (parseTupleElements is a synchronous type-string parse — no query
 *   needed, so this never has a "not discovered yet" case).
 * - JSON: expanded using `jsonPaths[columnName]` when supplied (a scan the caller runs
 *   separately, see CreateDataViewModal). If no paths were discovered for a JSON column — the
 *   scan hasn't completed yet, failed, or the column has none — the container row is kept so the
 *   column doesn't silently vanish from the list.
 * - Map: left untouched. Map keys are not being expanded here — spanAttributes/serviceName are
 *   legitimate Map-column targets in their own right (see COL_FIELDS), so dropping Map rows would
 *   only remove a valid candidate.
 * - Everything else (scalars, already-flattened ClickHouse `Nested(...)` dotted rows, Array(...)
 *   including Array(Tuple(...))): passed through unchanged.
 */
export function expandColumnCandidates(
  raw: TableColumn[],
  jsonPaths: JsonPathsByColumn = {}
): TableColumn[] {
  const result: TableColumn[] = [];

  for (const col of raw) {
    const type = inferFieldType(col.type);

    if (type === 'tuple') {
      for (const leaf of parseTupleElements(col.type)) {
        result.push({ name: `${col.name}.${leaf.name}`, type: leaf.type });
      }
      continue;
    }

    if (type === 'json') {
      const paths = jsonPaths[col.name];
      if (paths && paths.length > 0) {
        const seen = new Set<string>();
        for (const { path, chType } of paths) {
          if (seen.has(path)) {
            continue; // dynamic paths can repeat with different observed types — first-seen wins
          }
          seen.add(path);
          result.push({ name: `${col.name}.${path}`, type: chType });
        }
        continue;
      }
      // No paths discovered (yet, or at all) — keep the container rather than drop it silently.
      result.push(col);
      continue;
    }

    result.push(col);
  }

  return result;
}
