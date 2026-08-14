import { isEnrichmentEnabled, setEnrichmentEnabled } from '../enrichment';

beforeEach(() => {
  window.localStorage.clear();
});

describe('enrichment toggle', () => {
  it('defaults to disabled', () => {
    expect(isEnrichmentEnabled()).toBe(false);
  });

  it('persists true across reads', () => {
    setEnrichmentEnabled(true);
    expect(isEnrichmentEnabled()).toBe(true);
  });

  it('can be turned back off', () => {
    setEnrichmentEnabled(true);
    setEnrichmentEnabled(false);
    expect(isEnrichmentEnabled()).toBe(false);
  });

  it('falls back to disabled rather than throwing when storage is unavailable', () => {
    const original = window.localStorage.getItem;
    (window.localStorage as any).getItem = () => {
      throw new Error('storage disabled');
    };
    expect(() => isEnrichmentEnabled()).not.toThrow();
    expect(isEnrichmentEnabled()).toBe(false);
    window.localStorage.getItem = original;
  });
});
