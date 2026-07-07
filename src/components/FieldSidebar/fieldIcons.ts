import { FieldType } from '../../sql/fieldModel';

export const FIELD_TYPE_ICONS: Record<FieldType, string> = {
  time: 'clock-nine',
  number: 'calculator-alt',
  string: 'font',
  boolean: 'toggle-on',
  map: 'brackets-curly',
  json: 'brackets-curly',
  unknown: 'question-circle',
};
