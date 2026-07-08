import React, { useContext, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Button, Icon, Input, useStyles2 } from '@grafana/ui';
import { DataView } from '../../types';
import { DataViewContext } from '../App/App';
import { CreateDataViewModal } from './CreateDataViewModal';

/**
 * Header dropdown for selecting the active data view.
 * Shows grouped Shared / Personal sections + a "+ Create data view" entry.
 */
export function DataViewPicker() {
  const styles = useStyles2(getStyles);
  const { views, activeView, setActiveViewId, deletePersonalView } = useContext(DataViewContext);
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingView, setEditingView] = useState<DataView | undefined>(undefined);
  const [search, setSearch] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const filteredViews = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? views.filter(
          (v) => v.name.toLowerCase().includes(q) || `${v.database}.${v.logsTable}`.toLowerCase().includes(q)
        )
      : views;
  }, [views, search]);
  const sharedViews = filteredViews.filter((v) => v.origin === 'shared');
  const personalViews = filteredViews.filter((v) => v.origin === 'personal');

  function selectView(id: string) {
    setActiveViewId(id);
    setOpen(false);
  }

  return (
    <>
      <div className={styles.wrapper} ref={menuRef}>
        <button className={styles.trigger} onClick={() => setOpen((v) => !v)} title="Switch data view">
          <Icon name="layers-alt" size="sm" />
          <span className={styles.triggerLabel}>{activeView?.name ?? 'No data view'}</span>
          <Icon name={open ? 'angle-up' : 'angle-down'} size="sm" />
        </button>

        {open && (
          <div className={styles.dropdown}>
            <div className={styles.searchRow}>
              <Input
                autoFocus
                prefix={<Icon name="search" />}
                placeholder="Search data views"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
              />
            </div>
            {sharedViews.length > 0 && (
              <>
                <div className={styles.groupHeader}>Shared</div>
                {sharedViews.map((v) => (
                  <div
                    key={v.id}
                    className={`${styles.item} ${v.id === activeView?.id ? styles.itemActive : ''}`}
                  >
                    <button className={styles.itemName} onClick={() => selectView(v.id)}>
                      <Icon name="database" size="sm" />
                      <span>{v.name}</span>
                      <span className={styles.itemSub}>{v.database}.{v.logsTable}</span>
                    </button>
                  </div>
                ))}
              </>
            )}

            {personalViews.length > 0 && (
              <>
                <div className={styles.groupHeader}>Personal</div>
                {personalViews.map((v) => (
                  <div
                    key={v.id}
                    className={`${styles.item} ${v.id === activeView?.id ? styles.itemActive : ''}`}
                  >
                    <button className={styles.itemName} onClick={() => selectView(v.id)}>
                      <Icon name="user" size="sm" />
                      <span>{v.name}</span>
                      <span className={styles.itemSub}>{v.database}.{v.logsTable}</span>
                    </button>
                    <button
                      className={styles.deleteBtn}
                      title="Edit data view"
                      onClick={() => {
                        setOpen(false);
                        setEditingView(v);
                      }}
                    >
                      <Icon name="pen" size="xs" />
                    </button>
                    <button
                      className={styles.deleteBtn}
                      title="Delete personal view"
                      onClick={() => deletePersonalView(v.id)}
                    >
                      <Icon name="trash-alt" size="xs" />
                    </button>
                  </div>
                ))}
              </>
            )}

            {filteredViews.length === 0 && (
              <div className={styles.empty}>
                {views.length === 0 ? 'No data views configured' : 'No data views match your search'}
              </div>
            )}

            <div className={styles.footer}>
              <Button
                variant="secondary"
                size="sm"
                icon="plus"
                fullWidth
                onClick={() => {
                  setOpen(false);
                  setCreateOpen(true);
                }}
              >
                Create data view
              </Button>
            </div>
          </div>
        )}
      </div>

      <CreateDataViewModal isOpen={createOpen} onDismiss={() => setCreateOpen(false)} />
      <CreateDataViewModal
        isOpen={editingView !== undefined}
        onDismiss={() => setEditingView(undefined)}
        editingView={editingView}
      />
    </>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    position: relative;
    flex-shrink: 0;
  `,
  trigger: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    cursor: pointer;
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
    max-width: 220px;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  triggerLabel: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  `,
  dropdown: css`
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 280px;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z2};
    z-index: 200;
    overflow: hidden;
  `,
  searchRow: css`
    padding: ${theme.spacing(1)} ${theme.spacing(1)} ${theme.spacing(0.5)};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  groupHeader: css`
    padding: ${theme.spacing(0.5)} ${theme.spacing(1.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.secondary};
    text-transform: uppercase;
    letter-spacing: 0.04em;
  `,
  item: css`
    display: flex;
    align-items: center;
    border-bottom: 1px solid ${theme.colors.border.weak};
    &:last-of-type { border-bottom: none; }
    &:hover { background: ${theme.colors.action.hover}; }
  `,
  itemActive: css`
    background: ${theme.colors.action.selected};
  `,
  itemName: css`
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: ${theme.spacing(0.75)};
    padding: ${theme.spacing(0.75)} ${theme.spacing(1.5)};
    background: transparent;
    border: none;
    cursor: pointer;
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
    text-align: left;
    overflow: hidden;
  `,
  itemSub: css`
    color: ${theme.colors.text.disabled};
    font-size: 0.75em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  deleteBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: ${theme.spacing(0.75)};
    color: ${theme.colors.text.disabled};
    flex-shrink: 0;
    &:hover { color: ${theme.colors.error.text}; }
  `,
  empty: css`
    padding: ${theme.spacing(1.5)};
    text-align: center;
    color: ${theme.colors.text.disabled};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  footer: css`
    padding: ${theme.spacing(1)};
    border-top: 1px solid ${theme.colors.border.weak};
  `,
});
