import React, { useEffect, useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange, dateTime, rangeUtil } from '@grafana/data';
import { Button, ConfirmModal, Icon, Input, Modal, useStyles2 } from '@grafana/ui';
import { SavedSearch, LogsQueryState } from '../../types';
import {
  deleteSearch,
  loadSavedSearches,
  saveSearch,
} from '../../data/savedSearches';

interface SavedSearchMenuProps {
  queryState: LogsQueryState;
  timeRange: TimeRange;
  onLoad: (search: SavedSearch, newTimeRange?: TimeRange) => void;
  /** Active data view ID; used to scope saved searches. Undefined = show all (legacy). */
  activeDataViewId?: string;
}

export function SavedSearchMenu({ queryState, timeRange, onLoad, activeDataViewId }: SavedSearchMenuProps) {
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState(false);
  const [searches, setSearches] = useState<SavedSearch[]>([]);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      const all = loadSavedSearches();
      // Show searches for the active view + legacy searches (no dataViewId) when a view is set;
      // show all when no view is active (shouldn't happen in practice).
      setSearches(
        activeDataViewId
          ? all.filter((s) => !s.dataViewId || s.dataViewId === activeDataViewId)
          : all
      );
    }
  }, [open, activeDataViewId]);

  useEffect(() => {
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

  function handleSave() {
    const name = saveName.trim();
    if (!name) {
      return;
    }
    saveSearch(
      {
        name,
        search: queryState.search,
        filters: queryState.filters,
        columns: queryState.columns,
        sort: queryState.sort,
        timeRange: {
          from: typeof timeRange.raw.from === 'string' ? timeRange.raw.from : String(timeRange.from.valueOf()),
          to: typeof timeRange.raw.to === 'string' ? timeRange.raw.to : String(timeRange.to.valueOf()),
        },
      },
      activeDataViewId
    );
    setSaveName('');
    setSaveModalOpen(false);
  }

  function handleLoad(s: SavedSearch) {
    let tr: TimeRange | undefined;
    if (s.timeRange) {
      try {
        // Preserve relative strings (e.g. 'now-1h') so dateMath can resolve them;
        // convert absolute epoch-ms strings to DateTime objects.
        const toRaw = (v: string) => (v.startsWith('now') ? v : dateTime(Number(v)));
        tr = rangeUtil.convertRawToRange({ from: toRaw(s.timeRange.from), to: toRaw(s.timeRange.to) });
      } catch {
        tr = undefined;
      }
    }
    onLoad(s, tr);
    setOpen(false);
  }

  function handleDelete(id: string) {
    deleteSearch(id);
    setSearches((prev) => prev.filter((s) => s.id !== id));
    setDeleteId(null);
  }

  return (
    <div className={styles.wrapper} ref={menuRef}>
      <Button
        variant="secondary"
        size="sm"
        icon="save"
        onClick={() => setOpen((v) => !v)}
        tooltip="Saved searches"
      >
        Saved
      </Button>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownHeader}>
            <span className={styles.dropdownTitle}>Saved searches</span>
            <Button
              size="sm"
              variant="secondary"
              icon="plus"
              onClick={() => {
                setSaveModalOpen(true);
                setOpen(false);
              }}
            >
              Save current
            </Button>
          </div>
          {searches.length === 0 && (
            <div className={styles.empty}>No saved searches yet</div>
          )}
          {searches.map((s) => (
            <div key={s.id} className={styles.item}>
              <button className={styles.itemName} onClick={() => handleLoad(s)}>
                <Icon name="search" size="sm" />
                <span>{s.name}</span>
              </button>
              <button
                className={styles.deleteBtn}
                title="Delete"
                onClick={() => setDeleteId(s.id)}
              >
                <Icon name="trash-alt" size="xs" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Modal
        title="Save search"
        isOpen={saveModalOpen}
        onDismiss={() => setSaveModalOpen(false)}
      >
        <div className={styles.saveForm}>
          <Input
            placeholder="Search name"
            value={saveName}
            onChange={(e) => setSaveName(e.currentTarget.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') { handleSave(); } }}
          />
          <div className={styles.saveActions}>
            <Button variant="secondary" onClick={() => setSaveModalOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!saveName.trim()} onClick={handleSave}>Save</Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={deleteId !== null}
        title="Delete saved search"
        body="This cannot be undone."
        confirmText="Delete"
        icon={'trash-alt' as any}
        onConfirm={() => { if (deleteId) { handleDelete(deleteId); } }}
        onDismiss={() => setDeleteId(null)}
      />
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    position: relative;
  `,
  dropdown: css`
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 260px;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z2};
    z-index: 100;
    overflow: hidden;
  `,
  dropdownHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  dropdownTitle: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
  `,
  empty: css`
    padding: ${theme.spacing(2)};
    text-align: center;
    color: ${theme.colors.text.disabled};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  item: css`
    display: flex;
    align-items: center;
    border-bottom: 1px solid ${theme.colors.border.weak};
    &:last-child { border-bottom: none; }
    &:hover { background: ${theme.colors.action.hover}; }
  `,
  itemName: css`
    flex: 1;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.75)} ${theme.spacing(1.5)};
    background: transparent;
    border: none;
    cursor: pointer;
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
    text-align: left;
  `,
  deleteBtn: css`
    background: transparent;
    border: none;
    cursor: pointer;
    padding: ${theme.spacing(0.75)};
    color: ${theme.colors.text.disabled};
    &:hover { color: ${theme.colors.error.text}; }
  `,
  saveForm: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(2)};
  `,
  saveActions: css`
    display: flex;
    justify-content: flex-end;
    gap: ${theme.spacing(1)};
  `,
});
