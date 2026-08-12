/**
 * Shared trigger/dropdown/menu-item styling for the histogram toolbar's picker buttons
 * (IntervalPicker, BreakdownPicker) — pulled out because both duplicated the same `trigger` style
 * verbatim. Buttons are 32px tall with a 1px border, 14px/500 label, and a trailing chevron only
 * (no leading icon) — a cleaner, less cramped toolbar than the previous small bordered pills.
 */
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';

export const getToolbarButtonStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    position: relative;
    flex-shrink: 0;
  `,
  trigger: css`
    display: flex;
    align-items: center;
    height: 32px;
    gap: ${theme.spacing(1)};
    padding: 0 ${theme.spacing(1.5)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: 4px;
    cursor: pointer;
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.body.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    white-space: nowrap;
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:focus-visible {
      outline: 2px solid ${theme.colors.primary.border};
      outline-offset: 1px;
    }
  `,
  dropdown: css`
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 200px;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    box-shadow: ${theme.shadows.z2};
    z-index: 200;
    overflow: hidden;
  `,
  menuHeader: css`
    padding: ${theme.spacing(0.75)} ${theme.spacing(1.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  item: css`
    display: flex;
    align-items: center;
    width: 100%;
    padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
    background: transparent;
    border: none;
    cursor: pointer;
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.body.fontSize};
    text-align: left;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  itemActive: css`
    color: ${theme.colors.primary.text};
  `,
  itemDisabled: css`
    opacity: 0.4;
    cursor: not-allowed;
    &:hover {
      background: transparent;
    }
  `,
  itemCheck: css`
    width: 16px;
    margin-right: ${theme.spacing(0.5)};
    flex-shrink: 0;
    display: flex;
    align-items: center;
    color: ${theme.colors.primary.text};
  `,
});
