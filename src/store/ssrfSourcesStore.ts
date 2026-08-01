/**
 * SSRF-Lite Sources Store
 * Persists the list of SSRF-Lite data sources the user can search, including
 * their own GitHub fork. Sources are validated against an allowlist of
 * GitHub-hosted origins before being stored.
 */

import { create } from 'zustand';
import { isAllowedSsrfUrl } from '../data/ssrfData';

export interface SsrfSource {
  id: string;
  name: string;
  /**
   * For `kind: 'url'` (default) this is the HTTPS data.json/site URL that is
   * fetched at search time. For `kind: 'local'` it is unused (empty string).
   */
  url: string;
  /**
   * Source kind. `'url'` fetches a remote data.json (allowlisted origins);
   * `'local'` holds a pasted/uploaded data.json in memory so private overlays
   * (e.g. family channels) never leave the machine.
   */
  kind?: 'url' | 'local';
  /** Raw data.json text for `kind: 'local'` sources (persisted locally). */
  localData?: string;
  /** Built-in default sources cannot be removed. */
  builtIn?: boolean;
}

interface SsrfSourcesState {
  sources: SsrfSource[];
  selectedSourceId: string;
  selectSource: (id: string) => void;
  /** Add a custom URL source. Returns an error message, or null on success. */
  addSource: (name: string, url: string) => string | null;
  /**
   * Add a local (in-memory) source from pasted/uploaded data.json text.
   * Returns an error message, or null on success.
   */
  addLocalSource: (name: string, jsonText: string) => string | null;
  removeSource: (id: string) => void;
  getSelectedSource: () => SsrfSource | undefined;
}

const DEFAULT_SOURCES: SsrfSource[] = [
  {
    id: 'chicago-offline',
    name: 'Chicago-Offline (default)',
    url: 'https://chicago-offline.github.io/ssrf-lite/data.json',
    builtIn: true,
  },
];

const SOURCES_KEY = 'neonplug-ssrf-sources';
const SELECTED_KEY = 'neonplug-ssrf-selected';

function loadSources(): SsrfSource[] {
  try {
    const stored = localStorage.getItem(SOURCES_KEY);
    if (!stored) return DEFAULT_SOURCES;
    const custom = JSON.parse(stored) as SsrfSource[];
    if (!Array.isArray(custom)) return DEFAULT_SOURCES;
    // Keep only valid, non-built-in custom sources and merge with defaults.
    const validCustom = custom.filter(
      (s) =>
        s &&
        !s.builtIn &&
        (s.kind === 'local'
          ? typeof s.localData === 'string' && s.localData.length > 0
          : typeof s.url === 'string' && isAllowedSsrfUrl(s.url))
    );
    return [...DEFAULT_SOURCES, ...validCustom];
  } catch {
    return DEFAULT_SOURCES;
  }
}

function saveSources(sources: SsrfSource[]): void {
  try {
    const custom = sources.filter((s) => !s.builtIn);
    localStorage.setItem(SOURCES_KEY, JSON.stringify(custom));
  } catch {
    // Ignore localStorage errors
  }
}

function loadSelectedId(available: SsrfSource[]): string {
  try {
    const stored = localStorage.getItem(SELECTED_KEY);
    if (stored && available.some((s) => s.id === stored)) return stored;
  } catch {
    // Ignore localStorage errors
  }
  return available[0]?.id ?? '';
}

function saveSelectedId(id: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    // Ignore localStorage errors
  }
}

const initialSources = loadSources();

export const useSsrfSourcesStore = create<SsrfSourcesState>((set, get) => ({
  sources: initialSources,
  selectedSourceId: loadSelectedId(initialSources),

  selectSource: (id) => {
    if (!get().sources.some((s) => s.id === id)) return;
    saveSelectedId(id);
    set({ selectedSourceId: id });
  },

  addSource: (name, url) => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) return 'Please enter a name for the source';
    if (!isAllowedSsrfUrl(trimmedUrl)) {
      return 'URL must be HTTPS on github.io or raw.githubusercontent.com';
    }
    if (get().sources.some((s) => s.kind !== 'local' && s.url === trimmedUrl)) {
      return 'A source with this URL already exists';
    }

    const newSource: SsrfSource = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmedName,
      url: trimmedUrl,
      kind: 'url',
    };
    const sources = [...get().sources, newSource];
    saveSources(sources);
    saveSelectedId(newSource.id);
    set({ sources, selectedSourceId: newSource.id });
    return null;
  },

  addLocalSource: (name, jsonText) => {
    const trimmedName = name.trim();
    const text = jsonText.trim();
    if (!trimmedName) return 'Please enter a name for the source';
    if (!text) return 'Paste or upload a data.json first';
    // Validate the payload shape up front so bad data fails at add-time, not
    // silently at search-time.
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return 'Local data is not valid JSON';
    }
    if (
      !doc ||
      typeof doc !== 'object' ||
      !Array.isArray((doc as { channels?: unknown }).channels)
    ) {
      return 'Local data.json is missing a "channels" array';
    }

    const newSource: SsrfSource = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmedName,
      url: '',
      kind: 'local',
      localData: text,
    };
    const sources = [...get().sources, newSource];
    saveSources(sources);
    saveSelectedId(newSource.id);
    set({ sources, selectedSourceId: newSource.id });
    return null;
  },

  removeSource: (id) => {
    const target = get().sources.find((s) => s.id === id);
    if (!target || target.builtIn) return;
    const sources = get().sources.filter((s) => s.id !== id);
    saveSources(sources);
    let selectedSourceId = get().selectedSourceId;
    if (selectedSourceId === id) {
      selectedSourceId = sources[0]?.id ?? '';
      saveSelectedId(selectedSourceId);
    }
    set({ sources, selectedSourceId });
  },

  getSelectedSource: () => {
    const { sources, selectedSourceId } = get();
    return sources.find((s) => s.id === selectedSourceId) ?? sources[0];
  },
}));
