/**
 * SSRF-Lite Data Service
 * Loads RF reference data published in the SSRF-Lite format (a simplified,
 * YAML-based Standard Spectrum Resource Format). Consumers publish a compiled,
 * browser-ready `data.json` (see https://github.com/Chicago-Offline/ssrf-lite)
 * whose top-level `channels[]` array is a flattened list of RF assignments.
 *
 * The data is open and served with permissive CORS from GitHub Pages /
 * raw.githubusercontent.com, so it can be fetched directly from the browser
 * without a proxy. Users may point NeonPlug at their own GitHub fork.
 */

import { calculateDistance } from '../services/repeaterFinder';

/** A single flattened channel/assignment from an SSRF-Lite `data.json`. */
export interface SsrfChannel {
  file: string;
  name: string;
  usage: string | null;
  service: string | null;
  notes: string;
  freq_mhz: number;           // RX / output frequency
  input_mhz: number | null;   // TX / repeater input (null = simplex)
  mode: string | null;        // "FM", "DMR", "D-STAR", "P25", ... (null = analog plan)
  mode_detail: string;        // e.g. "CTCSS 146.2 Hz", "DCS 546", "CC1 TS1,2", "NAC $125"
  call_sign?: string | null;
  org?: string | null;
  loc_name?: string | null;
  lat?: number | null;
  lon?: number | null;
}

/** Top-level shape of a compiled SSRF-Lite `data.json`. */
export interface SsrfDataDocument {
  generated?: string;
  repo?: string;
  channels: SsrfChannel[];
}

/** An SSRF-Lite channel annotated with distance from the search location. */
export type SsrfEntry = SsrfChannel & { distance: number };

/** Parsed digital/analog signalling extracted from `mode_detail`. */
export interface SsrfModeDetail {
  ctcss?: number;       // Hz
  dcs?: number;         // DCS code
  dcsPolarity?: 'N' | 'P';
  colorCode?: number;   // DMR color code
  timeslots?: number[]; // DMR timeslots, e.g. [1, 2]
}

/**
 * Hostnames NeonPlug is willing to fetch SSRF-Lite data from. Restricting to
 * GitHub-hosted origins matches the "bring your own fork" workflow and avoids
 * the app being pointed at arbitrary/internal endpoints.
 */
const ALLOWED_HOST_SUFFIXES = ['.github.io'];
const ALLOWED_HOSTS = ['raw.githubusercontent.com'];

/**
 * Validate that a user-supplied source URL is safe to fetch: HTTPS only and
 * limited to the GitHub-hosted origins used to publish SSRF-Lite data.
 */
export function isAllowedSsrfUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (ALLOWED_HOSTS.includes(host)) return true;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Normalise a source URL to the concrete `data.json` document URL. Accepts
 * either a full URL ending in `.json` or a site base (e.g.
 * `https://user.github.io/ssrf-lite/`).
 */
export function resolveSsrfDataUrl(sourceUrl: string): string {
  const trimmed = sourceUrl.trim().replace(/\/+$/, '');
  if (/\.json$/i.test(trimmed)) return trimmed;
  return `${trimmed}/data.json`;
}

/** Parse the compact `mode_detail` string into structured signalling. */
export function parseSsrfModeDetail(modeDetail: string | null | undefined): SsrfModeDetail {
  const result: SsrfModeDetail = {};
  if (!modeDetail) return result;
  const str = String(modeDetail);

  const ctcss = str.match(/CTCSS\s+(\d+(?:\.\d+)?)/i);
  if (ctcss) {
    const value = parseFloat(ctcss[1]);
    if (value >= 67 && value <= 254.1) result.ctcss = value;
  }

  const dcs = str.match(/DCS\s+(\d+)\s*([NP])?/i);
  if (dcs) {
    result.dcs = parseInt(dcs[1], 10);
    if (dcs[2]) result.dcsPolarity = dcs[2].toUpperCase() as 'N' | 'P';
  }

  const cc = str.match(/\bCC\s*(\d+)/i);
  if (cc) result.colorCode = parseInt(cc[1], 10);

  const ts = str.match(/\bTS\s*([\d,]+)/i);
  if (ts) {
    const slots = ts[1]
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => n === 1 || n === 2);
    if (slots.length > 0) result.timeslots = slots;
  }

  return result;
}

// Cache compiled documents per resolved URL so repeated searches are cheap.
const documentCache = new Map<string, SsrfChannel[]>();
const loadPromises = new Map<string, Promise<SsrfChannel[]>>();

/**
 * Load and cache the `channels[]` array from an SSRF-Lite source URL.
 * @throws Error if the URL is not an allowed origin or the fetch/parse fails.
 */
export async function loadSsrfData(sourceUrl: string): Promise<SsrfChannel[]> {
  if (!isAllowedSsrfUrl(sourceUrl)) {
    throw new Error(
      'SSRF-Lite source must be an HTTPS URL on github.io or raw.githubusercontent.com'
    );
  }

  const dataUrl = resolveSsrfDataUrl(sourceUrl);
  const cached = documentCache.get(dataUrl);
  if (cached) return cached;

  const inFlight = loadPromises.get(dataUrl);
  if (inFlight) return inFlight;

  const promise = (async () => {
    let response: Response;
    try {
      response = await fetch(dataUrl, { headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new Error(
        `Failed to reach SSRF-Lite source: ${err instanceof Error ? err.message : 'network error'}`
      );
    }
    if (!response.ok) {
      throw new Error(`SSRF-Lite source returned HTTP ${response.status}`);
    }
    let doc: SsrfDataDocument;
    try {
      doc = (await response.json()) as SsrfDataDocument;
    } catch {
      throw new Error('SSRF-Lite source did not return valid JSON');
    }
    if (!doc || !Array.isArray(doc.channels)) {
      throw new Error('SSRF-Lite data.json is missing a "channels" array');
    }
    documentCache.set(dataUrl, doc.channels);
    return doc.channels;
  })();

  loadPromises.set(dataUrl, promise);
  try {
    return await promise;
  } finally {
    loadPromises.delete(dataUrl);
  }
}

/**
 * Parse a local (pasted/uploaded) data.json string into its `channels[]`
 * array. Used for `kind: 'local'` sources so private overlays never hit the
 * network. Throws on malformed input.
 */
export function parseSsrfDataText(jsonText: string): SsrfChannel[] {
  let doc: SsrfDataDocument;
  try {
    doc = JSON.parse(jsonText) as SsrfDataDocument;
  } catch {
    throw new Error('Local SSRF-Lite data is not valid JSON');
  }
  if (!doc || !Array.isArray(doc.channels)) {
    throw new Error('Local SSRF-Lite data.json is missing a "channels" array');
  }
  return doc.channels;
}

/**
 * Filter SSRF-Lite channels to those within `radius` miles of a location,
 * sorted nearest-first. Channels without coordinates get `distance: 0` and are
 * always included (simplex family/GMRS overlays often have no site fix), so
 * local overlays are never silently dropped by geographic search.
 */
export function selectNearbyOrCoordless(
  channels: SsrfChannel[],
  latitude: number,
  longitude: number,
  radius = 50
): SsrfEntry[] {
  const results: SsrfEntry[] = [];
  for (const ch of channels) {
    if (typeof ch.freq_mhz !== 'number' || Number.isNaN(ch.freq_mhz)) continue;
    const hasCoords =
      ch.lat != null &&
      ch.lon != null &&
      ch.lat >= -90 &&
      ch.lat <= 90 &&
      ch.lon >= -180 &&
      ch.lon <= 180;
    if (!hasCoords) {
      // Coord-less channel (e.g. simplex family net) — always include.
      results.push({ ...ch, distance: 0 });
      continue;
    }
    const distance = calculateDistance(latitude, longitude, ch.lat as number, ch.lon as number);
    if (distance <= radius) results.push({ ...ch, distance });
  }
  results.sort((a, b) => a.distance - b.distance);
  return results;
}

/** Clear the in-memory cache (e.g. to force a refresh of a source). */
export function clearSsrfCache(sourceUrl?: string): void {
  if (sourceUrl) {
    documentCache.delete(resolveSsrfDataUrl(sourceUrl));
  } else {
    documentCache.clear();
  }
}

/**
 * Find SSRF-Lite entries with coordinates within `radius` miles of a location,
 * sorted nearest-first. Location-less channel plans are excluded from
 * geographic search.
 */
export async function findNearbySsrf(
  sourceUrl: string,
  latitude: number,
  longitude: number,
  radius = 50
): Promise<SsrfEntry[]> {
  const channels = await loadSsrfData(sourceUrl);
  const results: SsrfEntry[] = [];

  for (const ch of channels) {
    if (ch.lat == null || ch.lon == null) continue;
    if (ch.lat < -90 || ch.lat > 90 || ch.lon < -180 || ch.lon > 180) continue;
    if (typeof ch.freq_mhz !== 'number' || Number.isNaN(ch.freq_mhz)) continue;

    const distance = calculateDistance(latitude, longitude, ch.lat, ch.lon);
    if (distance <= radius) {
      results.push({ ...ch, distance });
    }
  }

  results.sort((a, b) => a.distance - b.distance);
  return results;
}
