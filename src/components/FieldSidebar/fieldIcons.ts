import { FieldType } from '../../sql/fieldModel';

// `map` and `json` used to share the same icon ('brackets-curly'), so a plain Map(String,String)
// column visually read as JSON — the reported symptom being a Map column named "A project"
// appearing to be a JSON field. Map now gets its own icon (key→value list) distinct from JSON's
// curly braces.
export const FIELD_TYPE_ICONS: Record<FieldType, string> = {
  time: 'clock-nine',
  number: 'calculator-alt',
  string: 'font',
  boolean: 'toggle-on',
  map: 'list-ul',
  json: 'brackets-curly',
  tuple: 'layer-group',
  array: 'list-ol',
  unknown: 'question-circle',
};
