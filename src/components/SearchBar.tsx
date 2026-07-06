/**
 * KQL search bar with Kibana-style autocomplete.
 *
 * Suggestion types mirror elastic/kibana kql/public/autocomplete/providers/:
 *   field       – field names from useFields(), insert "name " (trailing space)
 *   operator    – :  :*  >=  <=  >  <   with Kibana-exact insert-text
 *   value       – top values fetched from ClickHouse (debounced 250ms, cached)
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
import { Button, Icon, useStyles2 } from '@grafana/ui';
import { useFields } from './FieldsContext';
import { getSuggestions, resolveValueContext, Suggestion } from '../sql/kql/suggest';
import { FieldValue } from '../sql/kql/_values';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: () => void;
  /** Page-supplied value lookup (Logs and Traces each bind their own table/filters). */
  loadValues: (sqlExpr: string) => Promise<FieldValue[]>;
  placeholder?: string;
}

/** Readable short labels for the autocomplete badge — replaces the old single-letter badge. */
const SUGGESTION_TYPE_LABEL: Record<Suggestion['type'], string> = {
  field: 'field',
  operator: 'op',
  value: 'value',
  conjunction: 'and/or',
};

export function SearchBar({
  value,
  onChange,
  onSearch,
  loadValues,
  placeholder = 'Filter logs with KQL  ·  level:error and service:payment*  ·  responseTime > 500',
}: SearchBarProps) {
  const styles = useStyles2(getStyles);
  const { fields } = useFields();

  const [inputValue, setInputValue] = useState(value);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [open, setOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

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

  const computeSuggestions = useCallback(
    async (query: string, cursor: number) => {
      if (!query && cursor === 0) {
        // Empty bar: show all fields
        const result = getSuggestions(query, cursor, fields, []);
        if (mountedRef.current) {
          setSuggestions(result.suggestions.slice(0, 12));
          setHighlightIdx(-1);
          setOpen(result.suggestions.length > 0);
        }
        return;
      }

      // Sync pass: fields / operators / conjunctions — no async needed
      const syncResult = getSuggestions(query, cursor, fields, []);

      if (mountedRef.current) {
        setSuggestions(syncResult.suggestions.slice(0, 12));
        setHighlightIdx(-1);
        setOpen(syncResult.suggestions.length > 0 || Boolean(syncResult.valueContext));
      }

      // Async pass: fetch values if we're in a value context
      const vctx = syncResult.valueContext ?? resolveValueContext(query, cursor, fields);
      if (!vctx) {
        return;
      }

      // Debounce the value fetch
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(async () => {
        const fetched = await loadValues(vctx.sqlExpr);
        if (!mountedRef.current) {
          return;
        }
        // Re-run suggestions with now-loaded values
        const withValues = getSuggestions(query, cursor, fields, fetched);
        setSuggestions(withValues.suggestions.slice(0, 12));
        setHighlightIdx(-1);
        setOpen(withValues.suggestions.length > 0);
      }, 250);
    },
    [fields, loadValues]
  );

  // ── Input handlers ────────────────────────────────────────────────────────

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setInputValue(v);
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

  const commit = useCallback(() => {
    setSuggestions([]);
    setOpen(false);
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
    setSuggestions([]);
    setOpen(false);
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

        {/* Suggestion dropdown */}
        {open && suggestions.length > 0 && (
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
          </ul>
        )}
      </div>

      <Button variant="secondary" onClick={commit} size="md">
        Search
      </Button>
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
  // Per-type badge colors (Kibana-inspired)
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
});
