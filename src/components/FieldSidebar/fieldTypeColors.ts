import { GrafanaTheme2 } from '@grafana/data';
import { FieldType } from '../../sql/fieldModel';

const HUE_BY_TYPE: Record<FieldType, string> = {
  time: 'blue',
  number: 'green',
  string: 'purple',
  boolean: 'orange',
  map: 'yellow',
  json: 'red',
  tuple: 'semi-dark-blue',
  array: 'light-green',
  unknown: '',
};

/** Maps each field type to a Grafana visualization hue, so the sidebar's type icons are
 *  scannable by color — a distinct hue per type instead of one flat gray. Kept separate from
 *  fieldIcons.ts (icon *shape*) since this needs the theme. */
export function fieldTypeColor(theme: GrafanaTheme2, type: FieldType): string {
  const hue = HUE_BY_TYPE[type];
  return hue ? theme.visualization.getColorByName(hue) : theme.colors.text.secondary;
}
