import { GrafanaTheme2 } from '@grafana/data';
import { FieldType } from '../../sql/fieldModel';

// Kibana's field-type palette (EUI "Borealis" theme, verified against upstream source — see the
// "Kibana evidence" section of the plan this was built from): EUI's TOKEN_MAP assigns each field
// type one of the euiColorVisN hues (token_map.ts: tokenDate→vis8, tokenNumber→vis0,
// tokenString→vis2, tokenBoolean→vis4), and those hues resolve to fixed hex values, identical in
// light and dark mode (eui-theme-borealis/src/eui_theme_borealis_{light,dark}.json). Kibana
// renders these as tinted EuiToken chips, which makes all 9 of its type hues legible; our icons
// are bare glyphs, so only the saturated hues read cleanly — map/json/tuple/array (all "container"
// types) share vis6 and stay distinguishable from each other by icon shape (fieldIcons.ts), not
// color.
const COLOR_BY_TYPE: Record<FieldType, string> = {
  time: '#EAAE01',     // tokenDate      → euiColorVis8
  number: '#16C5C0',   // tokenNumber    → euiColorVis0
  string: '#61A2FF',   // tokenString    → euiColorVis2
  boolean: '#EE72A6',  // tokenBoolean   → euiColorVis4
  map: '#F6726A',      // euiColorVis6 — shared "container type" hue (Map/JSON/Tuple/Array)
  json: '#F6726A',
  tuple: '#F6726A',
  array: '#F6726A',
  unknown: '',
};

/** Maps each field type to a color, so type icons are scannable by color — a distinct hue per
 *  type instead of one flat gray. Kept separate from fieldIcons.ts (icon *shape*) since `unknown`
 *  still needs the theme for its gray fallback. */
export function fieldTypeColor(theme: GrafanaTheme2, type: FieldType): string {
  return COLOR_BY_TYPE[type] || theme.colors.text.secondary;
}
