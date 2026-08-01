import { describe, it, expect } from 'vitest';
import {
  parseSsrfModeDetail,
  isAllowedSsrfUrl,
  resolveSsrfDataUrl,
  parseSsrfDataText,
  selectNearbyOrCoordless,
  type SsrfChannel,
  type SsrfEntry,
} from '../../src/data/ssrfData';
import { generateSsrfChannels } from '../../src/services/ssrfChannels';

function entry(overrides: Partial<SsrfEntry> = {}): SsrfEntry {
  return {
    file: 'plans/US/amateur/test.yml',
    name: 'test',
    usage: 'repeater',
    service: 'amateur',
    notes: '',
    freq_mhz: 147.0,
    input_mhz: 147.6,
    mode: 'FM',
    mode_detail: '',
    call_sign: 'W1ABC',
    org: 'Test Club',
    loc_name: 'Boston',
    lat: 42.36,
    lon: -71.06,
    distance: 5,
    ...overrides,
  };
}

describe('parseSsrfModeDetail', () => {
  it('parses CTCSS tone', () => {
    expect(parseSsrfModeDetail('CTCSS 146.2 Hz')).toEqual({ ctcss: 146.2 });
  });

  it('parses DCS code', () => {
    expect(parseSsrfModeDetail('DCS 546')).toMatchObject({ dcs: 546 });
  });

  it('parses DMR color code and timeslots', () => {
    expect(parseSsrfModeDetail('CC1 TS1,2')).toEqual({ colorCode: 1, timeslots: [1, 2] });
  });

  it('parses single timeslot', () => {
    expect(parseSsrfModeDetail('CC10 TS1')).toEqual({ colorCode: 10, timeslots: [1] });
  });

  it('does not misread a P25 NAC as a CTCSS tone', () => {
    expect(parseSsrfModeDetail('NAC $125')).toEqual({});
  });

  it('returns empty for blank detail', () => {
    expect(parseSsrfModeDetail('')).toEqual({});
    expect(parseSsrfModeDetail(null)).toEqual({});
  });
});

describe('parseSsrfDataText (local overlay)', () => {
  it('parses a valid data.json into channels[]', () => {
    const text = JSON.stringify({
      generated: '2026-08-01',
      channels: [
        { file: 'x.yml', name: 'FAM GMRS16', freq_mhz: 462.575, input_mhz: null, mode: 'FM', mode_detail: 'CTCSS 141.3 Hz', notes: '', usage: 'simplex', service: 'gmrs' },
      ],
    });
    const channels = parseSsrfDataText(text);
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('FAM GMRS16');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseSsrfDataText('{not json')).toThrow(/not valid JSON/i);
  });

  it('throws when channels array is missing', () => {
    expect(() => parseSsrfDataText(JSON.stringify({ foo: 1 }))).toThrow(/channels/i);
  });
});

describe('selectNearbyOrCoordless', () => {
  const chan = (o: Partial<SsrfChannel> = {}): SsrfChannel => ({
    file: 'x.yml',
    name: 'ch',
    usage: 'simplex',
    service: 'gmrs',
    notes: '',
    freq_mhz: 462.575,
    input_mhz: null,
    mode: 'FM',
    mode_detail: '',
    lat: null,
    lon: null,
    ...o,
  });

  it('always includes coord-less channels (simplex family net)', () => {
    const out = selectNearbyOrCoordless([chan({ name: 'FAM GMRS16' })], 41.9, -87.6, 5);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('FAM GMRS16');
    expect(out[0].distance).toBe(0);
  });

  it('filters coord-bearing channels by radius', () => {
    const near = chan({ name: 'near', lat: 41.9, lon: -87.6 });
    const far = chan({ name: 'far', lat: 25.0, lon: -80.0 });
    const out = selectNearbyOrCoordless([near, far], 41.9, -87.6, 50);
    const names = out.map((e) => e.name);
    expect(names).toContain('near');
    expect(names).not.toContain('far');
  });

  it('sorts nearest-first with coord-less pinned at distance 0', () => {
    const coordless = chan({ name: 'coordless' });
    const near = chan({ name: 'near', lat: 41.95, lon: -87.65 });
    const out = selectNearbyOrCoordless([near, coordless], 41.9, -87.6, 50);
    expect(out[0].distance).toBe(0);
    expect(out[0].name).toBe('coordless');
  });

  it('drops channels with non-numeric freq', () => {
    const bad = chan({ freq_mhz: NaN });
    expect(selectNearbyOrCoordless([bad], 41.9, -87.6, 50)).toHaveLength(0);
  });
});

describe('isAllowedSsrfUrl', () => {
  it('allows github.io https URLs', () => {
    expect(isAllowedSsrfUrl('https://user.github.io/ssrf-lite/data.json')).toBe(true);
  });

  it('allows raw.githubusercontent.com', () => {
    expect(isAllowedSsrfUrl('https://raw.githubusercontent.com/u/r/main/data.json')).toBe(true);
  });

  it('rejects non-https', () => {
    expect(isAllowedSsrfUrl('http://user.github.io/data.json')).toBe(false);
  });

  it('rejects disallowed hosts', () => {
    expect(isAllowedSsrfUrl('https://evil.example.com/data.json')).toBe(false);
    expect(isAllowedSsrfUrl('https://localhost/data.json')).toBe(false);
  });

  it('rejects hosts that only contain github.io as a substring', () => {
    expect(isAllowedSsrfUrl('https://github.io.evil.com/data.json')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedSsrfUrl('not a url')).toBe(false);
  });
});

describe('resolveSsrfDataUrl', () => {
  it('appends data.json to a base URL', () => {
    expect(resolveSsrfDataUrl('https://user.github.io/ssrf-lite/')).toBe(
      'https://user.github.io/ssrf-lite/data.json'
    );
  });

  it('leaves an explicit .json URL unchanged', () => {
    expect(resolveSsrfDataUrl('https://user.github.io/ssrf-lite/data.json')).toBe(
      'https://user.github.io/ssrf-lite/data.json'
    );
  });
});

describe('generateSsrfChannels', () => {
  it('throws when no entries provided', () => {
    expect(() => generateSsrfChannels(1, [])).toThrow();
  });

  it('creates an analog channel with TX tone for an FM repeater', () => {
    const result = generateSsrfChannels(1, [entry({ mode_detail: 'CTCSS 146.2 Hz' })]);
    expect(result.channels).toHaveLength(1);
    const ch = result.channels[0];
    expect(ch.mode).toBe('Analog');
    expect(ch.rxFrequency).toBe(147.0);
    expect(ch.txFrequency).toBe(147.6);
    expect(ch.txCtcssDcs).toEqual({ type: 'CTCSS', value: 146.2 });
    expect(ch.rxCtcssDcs).toEqual({ type: 'None' });
  });

  it('treats a null input_mhz as simplex', () => {
    const result = generateSsrfChannels(1, [entry({ input_mhz: null, freq_mhz: 446.0 })]);
    expect(result.channels[0].rxFrequency).toBe(446.0);
    expect(result.channels[0].txFrequency).toBe(446.0);
  });

  it('creates two DMR channels when separateTimeslots and TS1,2', () => {
    const dmr = entry({ mode: 'DMR', mode_detail: 'CC1 TS1,2', freq_mhz: 439.0, input_mhz: 430.0 });
    const result = generateSsrfChannels(1, [dmr], 'single', true);
    expect(result.channels).toHaveLength(2);
    expect(result.channels.every((c) => c.mode === 'Digital')).toBe(true);
    expect(result.channels[0].colorCode).toBe(1);
    expect(result.channels.map((c) => c.slotOperation)).toEqual([0, 1]);
  });

  it('creates one DMR channel when separateTimeslots is false', () => {
    const dmr = entry({ mode: 'DMR', mode_detail: 'CC1 TS1,2', freq_mhz: 439.0, input_mhz: 430.0 });
    const result = generateSsrfChannels(1, [dmr], 'single', false);
    expect(result.channels).toHaveLength(1);
  });

  it('groups into a single zone when grouping is single', () => {
    const result = generateSsrfChannels(
      1,
      [entry({ loc_name: 'Boston' }), entry({ loc_name: 'Chicago' })],
      'single'
    );
    expect(result.zones).toHaveLength(1);
    expect(result.zones[0].name).toBe('SSRF');
  });

  it('groups by location', () => {
    const result = generateSsrfChannels(
      1,
      [entry({ loc_name: 'Boston' }), entry({ loc_name: 'Chicago' })],
      'location'
    );
    expect(result.zones).toHaveLength(2);
  });

  it('skips entries outside supported frequency ranges', () => {
    const result = generateSsrfChannels(1, [entry({ freq_mhz: 10.0, input_mhz: null })]);
    expect(result.channels).toHaveLength(0);
    expect(result.summary.skipped).toBe(1);
  });

  it('assigns channel numbers starting at startChannelNumber', () => {
    const result = generateSsrfChannels(10, [entry()]);
    expect(result.channels[0].number).toBe(10);
  });
});
