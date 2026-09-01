/**
 * KQL search bar with autocomplete.
 *
 * Suggestion types:
 *   field       – field names from useFields(), insert "name " (trailing space); a Map container
 *                 field inserts "name." instead (no space) and drills into mapkey suggestions
 *   operator    – :  :*  >=  <=  >  <   with exact insert-text
 *   value       – top values fetched from ClickHouse (debounced 250ms, cached)
 *   mapkey      – a Map column's leaf keys, fetched lazily on first drilldown into that column
 *                 (sql/keys.ts, no debounce — typing after the dot filters the fetched list
 *                 locally, it does not re-query)
 *   conjunction – "and " / "or "
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  KeyboardEvent,
} from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, IconButton, useStyles2 } from '@grafana/ui';
import { useFields } from './FieldsContext';
import { getSuggestions, resolveValueContext, Suggestion } from '../sql/kql/suggest';
import { FieldValue } from '../sql/kql/_values';
import { KeysResult } from '../sql/keys';
import { parseKql, KqlSyntaxError } from '../sql/kql';
import { errMsg } from '../errMsg';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: () => void;
  /** Page-supplied value lookup (bound to the page's own table/filters). */
  loadValues: (sqlExpr: string) => Promise<FieldValue[]>;
  /** Page-supplied Map key lookup (bound to the page's own table/filters) — same shared
   *  sql/keys.ts cache the field sidebar's FieldKeysPopover reads, so browsing a column from
   *  either surface warms the other. */
  loadMapKeys: (mapColumn: string) => Promise<KeysResult>;
  placeholder?: string;
}

/** Readable short labels for the autocomplete badge — replaces the old single-letter badge. */
const SUGGESTION_TYPE_LABEL: Record<Suggestion['type'], string> = {
  field: 'field',
  operator: 'op',
  value: 'value',
  mapkey: 'key',
  conjunction: 'and/or',
};

export function SearchBar({
  value,
  onChange,
  onSearch,
  loadValues,
  loadMapKeys,
  placeholder = 'Filter logs with KQL  ·  level:error and service:payment*  ·  responseTime > 500',
}: SearchBarProps) {
  const styles = useStyles2(getStyles);
  const { fields } = useFields();

  const [inputValue, setInputValue] = useState(value);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [open, setOpen] = useState(false);
  // Kibana-style "reject the query, don't guess" — set only when commit() fails to parse the
  // current input as KQL. The search is not run and results on screen stay as they are.
  const [parseError, setParseError] = useState<string | null>(null);
  // Drives the "Listing keys…" / error / "from N sampled records" rows for the currently
  // drilled-into Map column. Kept separate from `suggestions` (which only holds selectable rows)
  // since these are informational, non-selectable.
  const [mapKeyState, setMapKeyState] = useState<{
    column: string;
    loading: boolean;
    error: string | null;
    total: number;
  } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Per-column key cache for THIS search bar instance, mirroring `values` — fetched once per
  // column (sql/keys.ts's own module-level cache makes repeat fetches across instances/pages
  // cheap regardless). Not React state: mutating it doesn't need to re-render on its own, only the
  // getSuggestions() re-run after a fetch does, which already flows through setSuggestions.
  const keysByColumnRef = useRef<Map<string, KeysResult>>(new Map());
  // Columns with a fetch currently in flight — guards against firing a second loadMapKeys for the
  // same column while the user keeps typing the key prefix (keysByColumnRef alone only closes that
  // gap once the first fetch resolves).
  const pendingMapKeyColumnsRef = useRef<Set<string>>(new Set());
  // Monotonic token guarding both async passes (value fetch, map-key fetch) — without it a slow
  // fetch triggered by a stale keystroke can overwrite a newer sync result after the user has
  // since moved on (mountedRef alone only guards against unmount, not against being superseded).
  const requestSeqRef = useRef(0);

  // Sync when external value changes (e.g. loading a saved search) — `value` is the
  // external/controlled prop, `inputValue` the local draft; this mirrors external -> local.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInputValue(value);
  }, [value]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Suggestion computation ─────────────────────────────────────────────────

  const keyListsSnapshot = useCallback((): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const [col, res] of keysByColumnRef.current) {
      out.set(col, res.keys.map((k) => k.key));
    }
    return out;
  }, []);

  const computeSuggestions = useCallback(
    async (query: string, cursor: number) => {
      const seq = ++requestSeqRef.current;

      if (!query && cursor === 0) {
        // Empty bar: show all fields
        const result = getSuggestions(query, cursor, fields, [], keyListsSnapshot());
        if (mountedRef.current && requestSeqRef.current === seq) {
          setSuggestions(result.suggestions.slice(0, 12));
          setHighlightIdx(-1);
          setOpen(result.suggestions.length > 0);
          setMapKeyState(null);
        }
        return;
      }

      // Sync pass: fields / operators / conjunctions / already-loaded map keys — no async needed
      const syncResult = getSuggestions(query, cursor, fields, [], keyListsSnapshot());

      if (mountedRef.current && requestSeqRef.current === seq) {
        setSuggestions(syncResult.suggestions.slice(0, 12));
        setHighlightIdx(-1);
        setOpen(
          syncResult.suggestions.length > 0 ||
            Boolean(syncResult.valueContext) ||
            Boolean(syncResult.mapKeyContext)
        );
      }

      // Async pass: fetch values if we're in a value context (debounced — fires on every
      // keystroke of a value prefix, so worth coalescing).
      const vctx = syncResult.valueContext ?? resolveValueContext(query, cursor, fields);
      if (vctx) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }
        debounceRef.current = setTimeout(async () => {
          const fetched = await loadValues(vctx.sqlExpr);
          if (!mountedRef.current || requestSeqRef.current !== seq) {
            return;
          }
          // Re-run suggestions with now-loaded values
          const withValues = getSuggestions(query, cursor, fields, fetched, keyListsSnapshot());
          setSuggestions(withValues.suggestions.slice(0, 12));
          setHighlightIdx(-1);
          setOpen(withValues.suggestions.length > 0);
        }, 250);
      }

      // Async pass: fetch a Map column's keys if we're drilled into one. No debounce — this fires
      // once per column (guarded by keysByColumnRef/pendingMapKeyColumnsRef below), and every
      // further keystroke of the key prefix is a local filter over the already-fetched list
      // (mapKeySuggestions, sql/kql/suggest.ts), not a new query.
      const mctx = syncResult.mapKeyContext;
      if (!mctx) {
        if (mountedRef.current && requestSeqRef.current === seq) {
          setMapKeyState(null);
        }
        return;
      }

      const cachedKeys = keysByColumnRef.current.get(mctx.column);
      if (cachedKeys) {
        if (mountedRef.current && requestSeqRef.current === seq) {
          setMapKeyState({ column: mctx.column, loading: false, error: null, total: cachedKeys.total });
        }
        return;
      }

      if (mountedRef.current && requestSeqRef.current === seq) {
        setMapKeyState({ column: mctx.column, loading: true, error: null, total: 0 });
      }

      if (pendingMapKeyColumnsRef.current.has(mctx.column)) {
        return; // already in flight from an earlier keystroke on this same column
      }
      pendingMapKeyColumnsRef.current.add(mctx.column);
      try {
        const result = await loadMapKeys(mctx.column);
        keysByColumnRef.current.set(mctx.column, result);
        if (!mountedRef.current || requestSeqRef.current !== seq) {
          return;
        }
        setMapKeyState({ column: mctx.column, loading: false, error: null, total: result.total });
        // Re-run suggestions with now-loaded keys
        const withKeys = getSuggestions(query, cursor, fields, [], keyListsSnapshot());
        setSuggestions(withKeys.suggestions.slice(0, 12));
        setHighlightIdx(-1);
        setOpen(withKeys.suggestions.length > 0 || Boolean(withKeys.mapKeyContext));
      } catch (e) {
        if (mountedRef.current && requestSeqRef.current === seq) {
          setMapKeyState({ column: mctx.column, loading: false, error: errMsg(e), total: 0 });
        }
      } finally {
        pendingMapKeyColumnsRef.current.delete(mctx.column);
      }
    },
    [fields, loadValues, loadMapKeys, keyListsSnapshot]
  );

  // ── Input handlers ────────────────────────────────────────────────────────

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setInputValue(v);
    setParseError(null); // clear a stale error as soon as the user edits the query again
    const cursor = e.target.selectionStart ?? v.length;
    computeSuggestions(v, cursor);
  };

  const applySuggestion = useCallback(
    (s: Suggestion) => {
      const before = inputValue.slice(0, s.replaceStart);
      const after  = inputValue.slice(s.replaceEnd);
      const next   = before + s.insertText + after;
      setInputValue(next);
      setSuggestions([]);
      setOpen(false);
      setHighlightIdx(-1);
      // Reposition caret after the inserted text
      const newCaret = s.replaceStart + s.insertText.length;
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(newCaret, newCaret);
        inputRef.current?.focus();
      });
      // Re-compute suggestions from the new position
      computeSuggestions(next, newCaret);
    },
    [inputValue, computeSuggestions]
  );

  // Client-side parse-before-send, same placement Kibana uses (KQLSyntaxError is thrown before
  // the query ever reaches Elasticsearch). An unparseable query is refused here rather than
  // silently run as a plain-text search — the table on screen is left exactly as it was.
  // buildSearchClause's own try/catch (queryBuilder.ts) still exists as a safety net for callers
  // that don't go through this gate — restored saved searches, dashboard export — so it stays
  // reachable there, just not from typing.
  const commit = useCallback(() => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      try {
        parseKql(trimmed);
      } catch (e) {
        setSuggestions([]);
        setOpen(false);
        setMapKeyState(null);
        setParseError(e instanceof KqlSyntaxError ? e.message : String(e));
        return;
      }
    }
    setParseError(null);
    setSuggestions([]);
    setOpen(false);
    setMapKeyState(null);
    onChange(inputValue);
    onSearch();
  }, [inputValue, onChange, onSearch]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) {
      if (e.key === 'Enter') {
        commit();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, suggestions.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, -1));
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      setHighlightIdx(-1);
      return;
    }
    // Enter or Tab accepts the highlighted suggestion — matches Kibana's own KQL input (its
    // `index` state starts `null` and resets to `null` on every keystroke, only becoming non-null
    // via ArrowDown/ArrowUp; Enter checks `index !== null` before accepting, else it submits — see
    // query_string_input.tsx's onKeyDown). `highlightIdx` here is the same contract: -1 until the
    // user explicitly arrows into the list, reset to -1 on every keystroke (computeSuggestions). So
    // typing + Enter always searches; ArrowDown + Enter accepts. This used to always submit on
    // Enter regardless of highlight — that "fix" was for the wrong bug: the real issue was that
    // accepting inserted different text than the dropdown showed (see fieldSuggestions/
    // escapeKqlIdent), not that Enter could accept at all. With insert === display now guaranteed,
    // accepting via Enter can no longer silently rewrite the query.
    if ((e.key === 'Enter' || e.key === 'Tab') && highlightIdx >= 0) {
      e.preventDefault();
      applySuggestion(suggestions[highlightIdx]);
      return;
    }
    if (e.key === 'Enter') {
      commit();
    }
  };

  const onClear = () => {
    setInputValue('');
    setParseError(null);
    setSuggestions([]);
    setOpen(false);
    setMapKeyState(null);
    onChange('');
    onSearch();
  };

  const onFocus = () => {
    if (inputValue !== undefined) {
      computeSuggestions(inputValue, inputRef.current?.selectionStart ?? inputValue.length);
    }
  };

  const onBlur = () => {
    // Delay close so that clicks on suggestion items fire first
    setTimeout(() => {
      if (mountedRef.current) {
        setOpen(false);
      }
    }, 150);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.container}>
      <div className={styles.inputWrapper}>
        <Icon name="search" className={styles.icon} />
        <input
          ref={inputRef}
          className={styles.input}
          value={inputValue}
          onChange={onInputChange}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        {inputValue && (
          <button className={styles.clearBtn} onClick={onClear} title="Clear search">
            <Icon name="times" />
          </button>
        )}

        {/* Suggestion dropdown — also shown with zero `suggestions` while a Map column's keys are
            still loading (or failed), so the "Listing keys…" / error row has somewhere to render;
            plain field/operator/value/conjunction suggestions never carry mapKeyState. */}
        {open && (suggestions.length > 0 || mapKeyState) && (
          <ul className={styles.dropdown} role="listbox">
            {suggestions.map((s, idx) => (
              <li
                key={idx}
                role="option"
                aria-selected={idx === highlightIdx}
                className={`${styles.item} ${idx === highlightIdx ? styles.itemHighlight : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault(); // prevent blur before click
                  applySuggestion(s);
                }}
              >
                <span className={`${styles.itemBadge} ${styles[`badge_${s.type}`]}`}>
                  {SUGGESTION_TYPE_LABEL[s.type]}
                </span>
                <span className={styles.itemText}>{s.text}</span>
                {s.description && (
                  <span className={styles.itemDesc}>{s.description}</span>
                )}
              </li>
            ))}

            {mapKeyState?.loading && (
              <li className={styles.mapKeyStatus}>Listing keys…</li>
            )}
            {mapKeyState?.error && (
              <li className={`${styles.mapKeyStatus} ${styles.mapKeyError}`}>{mapKeyState.error}</li>
            )}
            {mapKeyState && !mapKeyState.loading && !mapKeyState.error && (
              <li className={styles.mapKeyCaption}>
                {mapKeyState.total > 0
                  ? `from ${mapKeyState.total.toLocaleString()} sampled records`
                  : 'No keys found in the sampled rows'}
              </li>
            )}
          </ul>
        )}

        {/* Parse-error banner — replaces the dropdown (commit() clears suggestions/open on
            failure) rather than stacking under it. Kibana shows an "Expected X but Y found" +
            caret diagram in the same spot; this mirrors that instead of silently guessing. */}
        {!open && parseError && (
          <div className={styles.errorBox} role="alert">
            <pre className={styles.errorText}>{parseError}</pre>
          </div>
        )}
      </div>

      {/* Icon-only — condensed to fit the merged single-line toolbar (see LogsExplorer.tsx's
          header row). Enter already commits the search (onKeyDown above); this is a visible
          affordance for that, not the only way to trigger it. */}
      <IconButton name="search" tooltip="Search (Enter)" aria-label="Search" onClick={commit} />
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    gap: ${theme.spacing(1)};
    align-items: center;
    width: 100%;
  `,
  inputWrapper: css`
    flex: 1;
    display: flex;
    align-items: center;
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    padding: 0 ${theme.spacing(1)};
    position: relative;
    &:focus-within {
      border-color: ${theme.colors.primary.border};
      box-shadow: 0 0 0 2px ${theme.colors.primary.transparent};
    }
  `,
  icon: css`
    color: ${theme.colors.text.secondary};
    margin-right: ${theme.spacing(0.5)};
    flex-shrink: 0;
  `,
  input: css`
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.fontSize}px;
    padding: ${theme.spacing(0.75)} 0;
    font-family: ${theme.typography.fontFamilyMonospace};
    &::placeholder {
      color: ${theme.colors.text.disabled};
      font-family: ${theme.typography.fontFamily};
    }
  `,
  clearBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
    color: ${theme.colors.text.secondary};
    display: flex;
    align-items: center;
    &:hover { color: ${theme.colors.text.primary}; }
  `,

  // ── Parse-error banner ──────────────────────────────────────────────────────
  errorBox: css`
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    z-index: 1000;
    background: ${theme.colors.error.transparent};
    border: 1px solid ${theme.colors.error.border};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z2};
    padding: ${theme.spacing(1)};
  `,
  errorText: css`
    margin: 0;
    color: ${theme.colors.error.text};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    white-space: pre-wrap;
    word-break: break-word;
  `,

  // ── Dropdown ──────────────────────────────────────────────────────────────
  dropdown: css`
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    z-index: 1000;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z2};
    list-style: none;
    margin: 0;
    padding: ${theme.spacing(0.5)} 0;
    max-height: 320px;
    overflow-y: auto;
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.5)} ${theme.spacing(1.5)};
    cursor: pointer;
    font-size: ${theme.typography.bodySmall.fontSize};
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  itemHighlight: css`
    background: ${theme.colors.action.focus};
  `,
  itemBadge: css`
    font-size: 10px;
    font-weight: ${theme.typography.fontWeightMedium};
    padding: 1px 6px;
    border-radius: 3px;
    flex-shrink: 0;
    min-width: 40px;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  `,
  // Per-type badge colors
  badge_field: css`
    background: ${theme.colors.primary.transparent};
    color: ${theme.colors.primary.text};
  `,
  badge_operator: css`
    background: ${theme.colors.warning.transparent};
    color: ${theme.colors.warning.text};
  `,
  badge_value: css`
    background: ${theme.colors.success.transparent};
    color: ${theme.colors.success.text};
  `,
  badge_conjunction: css`
    background: ${theme.colors.secondary?.transparent ?? theme.colors.action.selected};
    color: ${theme.colors.text.secondary};
  `,
  badge_mapkey: css`
    background: ${theme.colors.info?.transparent ?? theme.colors.primary.transparent};
    color: ${theme.colors.info?.text ?? theme.colors.primary.text};
  `,
  itemText: css`
    flex: 1;
    color: ${theme.colors.text.primary};
    font-family: ${theme.typography.fontFamilyMonospace};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  itemDesc: css`
    color: ${theme.colors.text.disabled};
    font-size: 11px;
    white-space: nowrap;
    flex-shrink: 0;
  `,

  // ── Map-key drilldown status rows (non-selectable) ─────────────────────────
  mapKeyStatus: css`
    padding: ${theme.spacing(0.5)} ${theme.spacing(1.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  mapKeyError: css`
    color: ${theme.colors.error.text};
  `,
  mapKeyCaption: css`
    padding: ${theme.spacing(0.5)} ${theme.spacing(1.5)};
    font-size: 11px;
    font-style: italic;
    color: ${theme.colors.text.disabled};
  `,
});
