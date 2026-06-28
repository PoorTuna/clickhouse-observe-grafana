import React, { useState, KeyboardEvent } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Input, Button, useStyles2, Icon } from '@grafana/ui';
import { FilterPill, FilterOp } from '../types';
import { parseFilterShorthand, makeFilter } from '../sql/filters';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: () => void;
  onAddFilter: (filter: FilterPill) => void;
  placeholder?: string;
}

export function SearchBar({
  value,
  onChange,
  onSearch,
  onAddFilter,
  placeholder = 'Search logs… (text, field:value, field!=value)',
}: SearchBarProps) {
  const styles = useStyles2(getStyles);
  const [inputValue, setInputValue] = useState(value);

  const commit = (raw: string) => {
    const shorthand = parseFilterShorthand(raw);
    if (shorthand) {
      onAddFilter(makeFilter(shorthand.field, shorthand.value, shorthand.op as FilterOp));
      setInputValue('');
      onChange('');
    } else {
      onChange(raw);
      onSearch();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit(inputValue);
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const onClear = () => {
    setInputValue('');
    onChange('');
    onSearch();
  };

  return (
    <div className={styles.container}>
      <div className={styles.inputWrapper}>
        <Icon name="search" className={styles.icon} />
        <input
          className={styles.input}
          value={inputValue}
          onChange={onInputChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
        />
        {inputValue && (
          <button className={styles.clearBtn} onClick={onClear} title="Clear search">
            <Icon name="times" />
          </button>
        )}
      </div>
      <Button variant="secondary" onClick={() => commit(inputValue)} size="md">
        Search
      </Button>
    </div>
  );
}

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
    &::placeholder {
      color: ${theme.colors.text.disabled};
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
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
});
