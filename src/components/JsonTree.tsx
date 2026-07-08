import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon, ClipboardButton } from '@grafana/ui';

interface JsonTreeProps {
  data: unknown;
  /** Node paths to start expanded, e.g. new Set(['root', 'root.attrs']). Defaults to root only. */
  defaultExpanded?: Set<string>;
}

type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

function kindOf(v: unknown): Kind {
  if (v === null) {
    return 'null';
  }
  if (Array.isArray(v)) {
    return 'array';
  }
  const t = typeof v;
  if (t === 'object') {
    return 'object';
  }
  return t as Kind;
}

function preview(v: unknown, kind: Kind): string {
  if (kind === 'array') {
    return `Array(${(v as unknown[]).length})`;
  }
  if (kind === 'object') {
    return `{${Object.keys(v as object).length}}`;
  }
  return '';
}

/** Every object/array node's path, so a caller can pass this as `defaultExpanded` to fully
 *  auto-expand the tree (Kibana's JSON view default) instead of collapsing anything nested. */
export function allContainerPaths(data: unknown, prefix = 'root'): Set<string> {
  const paths = new Set<string>();
  const walk = (value: unknown, path: string) => {
    const kind = kindOf(value);
    if (kind !== 'object' && kind !== 'array') {
      return;
    }
    paths.add(path);
    const entries: Array<[string, unknown]> =
      kind === 'array' ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value as object);
    for (const [k, v] of entries) {
      walk(v, `${path}.${k}`);
    }
  };
  walk(data, prefix);
  return paths;
}

/** Kibana-style collapsible JSON tree — click any brace/bracket row to fold just that subtree. */
export function JsonTree({ data, defaultExpanded }: JsonTreeProps) {
  const styles = useStyles2(getStyles);
  const [expanded, setExpanded] = useState<Set<string>>(defaultExpanded ?? new Set(['root']));

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const renderNode = (key: string | null, value: unknown, path: string, depth: number, isLast: boolean) => {
    const kind = kindOf(value);
    const isContainer = kind === 'object' || kind === 'array';
    const isOpen = expanded.has(path);
    const keyLabel = key !== null && (
      <span className={styles.key}>
        {JSON.stringify(key)}
        <span className={styles.colon}>:</span>
      </span>
    );

    if (!isContainer) {
      return (
        <div key={path} className={styles.line} style={{ paddingLeft: depth * 16 }}>
          <span className={styles.gutter} />
          {keyLabel}
          <span className={styles[kind === 'string' ? 'valString' : kind === 'number' ? 'valNumber' : kind === 'boolean' ? 'valBool' : 'valNull']}>
            {kind === 'string' ? JSON.stringify(value) : String(value)}
          </span>
          {!isLast && <span className={styles.comma}>,</span>}
        </div>
      );
    }

    const entries: Array<[string, unknown]> =
      kind === 'array' ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value as object);
    const openBrace = kind === 'array' ? '[' : '{';
    const closeBrace = kind === 'array' ? ']' : '}';

    return (
      <div key={path}>
        <div className={styles.line} style={{ paddingLeft: depth * 16 }}>
          <button
            type="button"
            className={styles.gutterToggle}
            onClick={() => toggle(path)}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
          >
            <Icon name={isOpen ? 'angle-down' : 'angle-right'} size="sm" />
          </button>
          {keyLabel}
          <span className={styles.brace}>{openBrace}</span>
          {!isOpen && (
            <>
              <span className={styles.collapsedPreview}>{preview(value, kind)}</span>
              <span className={styles.brace}>{closeBrace}</span>
              {!isLast && <span className={styles.comma}>,</span>}
            </>
          )}
        </div>
        {isOpen && (
          <>
            {entries.length === 0 ? (
              <div className={styles.line} style={{ paddingLeft: (depth + 1) * 16 }}>
                <span className={styles.gutter} />
                <span className={styles.collapsedPreview}>(empty)</span>
              </div>
            ) : (
              entries.map(([k, v], i) => renderNode(k, v, `${path}.${k}`, depth + 1, i === entries.length - 1))
            )}
            <div className={styles.line} style={{ paddingLeft: depth * 16 }}>
              <span className={styles.gutter} />
              <span className={styles.brace}>{closeBrace}</span>
              {!isLast && <span className={styles.comma}>,</span>}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.copyRow}>
        <ClipboardButton
          icon="clipboard-alt"
          size="sm"
          variant="secondary"
          getText={() => JSON.stringify(data, null, 2)}
        >
          Copy JSON
        </ClipboardButton>
      </div>
      <div className={styles.tree}>{renderNode(null, data, 'root', 0, true)}</div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    height: 100%;
  `,
  copyRow: css`
    display: flex;
    justify-content: flex-end;
  `,
  tree: css`
    flex: 1;
    overflow: auto;
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    background: ${theme.colors.background.canvas};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)} 0;
  `,
  line: css`
    display: flex;
    align-items: flex-start;
    gap: 2px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 20px;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  gutter: css`
    display: inline-block;
    width: 16px;
    flex-shrink: 0;
  `,
  gutterToggle: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 20px;
    flex-shrink: 0;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    color: ${theme.colors.text.secondary};
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  key: css`
    color: ${theme.colors.text.primary};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  colon: css`
    color: ${theme.colors.text.secondary};
    margin-right: 4px;
  `,
  brace: css`
    color: ${theme.colors.text.secondary};
  `,
  comma: css`
    color: ${theme.colors.text.secondary};
  `,
  collapsedPreview: css`
    color: ${theme.colors.text.disabled};
    font-style: italic;
    margin: 0 4px;
  `,
  valString: css`
    color: ${theme.visualization.getColorByName('green')};
  `,
  valNumber: css`
    color: ${theme.visualization.getColorByName('blue')};
  `,
  valBool: css`
    color: ${theme.visualization.getColorByName('orange')};
  `,
  valNull: css`
    color: ${theme.colors.text.disabled};
  `,
});
