import { SavedSearch } from '../types';

const STORAGE_KEY = 'poortuna-clickhouse-observe:saved-searches';

function readAll(): SavedSearch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedSearch[]) : [];
  } catch {
    return [];
  }
}

function writeAll(searches: SavedSearch[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(searches));
  } catch {
    // Storage full or unavailable — silently swallow.
  }
}

export function loadSavedSearches(): SavedSearch[] {
  return readAll();
}

export function saveSearch(search: Omit<SavedSearch, 'id' | 'createdAt'>): SavedSearch {
  const all = readAll();
  const entry: SavedSearch = {
    ...search,
    id: `ss_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };
  writeAll([...all, entry]);
  return entry;
}

export function updateSearch(id: string, patch: Partial<Omit<SavedSearch, 'id' | 'createdAt'>>): void {
  const all = readAll();
  writeAll(all.map((s) => (s.id === id ? { ...s, ...patch } : s)));
}

export function deleteSearch(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id));
}
