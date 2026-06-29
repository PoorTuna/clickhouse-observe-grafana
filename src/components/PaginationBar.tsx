import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Pagination, Select, Spinner, useStyles2 } from '@grafana/ui';
import { SelectableValue } from '@grafana/data';

interface PaginationBarProps {
  page: number; // 0-based
  pageSize: number;
  pageSizeOptions: number[];
  totalLoaded: number;
  hasMore: boolean;
  fetchingMore: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function PaginationBar({
  page,
  pageSize,
  pageSizeOptions,
  totalLoaded,
  hasMore,
  fetchingMore,
  onPageChange,
  onPageSizeChange,
}: PaginationBarProps) {
  const styles = useStyles2(getStyles);

  const knownPages = Math.max(1, Math.ceil(totalLoaded / pageSize));
  // Show one extra page when more rows may exist so the user can navigate forward.
  const numberOfPages = hasMore ? knownPages + 1 : knownPages;

  const sizeOptions: Array<SelectableValue<number>> = pageSizeOptions.map((n) => ({
    label: String(n),
    value: n,
  }));

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <span className={styles.label}>Rows per page</span>
        <Select
          value={pageSize}
          options={sizeOptions}
          onChange={(v) => v.value != null && onPageSizeChange(v.value)}
          width={8}
          menuPlacement="top"
        />
        {fetchingMore && <Spinner size="sm" />}
      </div>
      <div className={styles.right}>
        <span className={styles.info}>
          {totalLoaded.toLocaleString()} rows loaded
          {hasMore ? '+' : ''}
        </span>
        <Pagination
          currentPage={page + 1}
          numberOfPages={numberOfPages}
          onNavigate={(p) => onPageChange(p - 1)}
          hideWhenSinglePage
        />
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  bar: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    border-top: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.primary};
    flex-shrink: 0;
    gap: ${theme.spacing(2)};
  `,
  left: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  label: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
  right: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(2)};
  `,
  info: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  `,
});
