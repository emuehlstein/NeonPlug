/**
 * SSRF-Lite Channels Service
 * Converts SSRF-Lite reference entries into NeonPlug channels and zones.
 */

import type { Channel, Zone } from '../models';
import type { CTCSSDCS } from '../models/Channel';
import { createDefaultChannel } from '../utils/channelHelpers';
import { generateZoneId } from '../utils/zoneHelpers';
import { isValidFrequencyRange } from './validation/frequencyValidator';
import { parseSsrfModeDetail, type SsrfEntry } from '../data/ssrfData';

export type SsrfZoneGrouping = 'single' | 'location' | 'service';

export interface GenerateSsrfResult {
  channels: Channel[];
  zones: Zone[];
  summary: {
    entriesSelected: number;
    channelsCreated: number;
    zonesCreated: number;
    skipped: number;
  };
}

/** Build a 16-char-safe channel name, preferring the callsign. */
function buildChannelName(entry: SsrfEntry): string {
  const base = (entry.call_sign || entry.name || 'SSRF').trim();
  return base.length > 16 ? base.substring(0, 16) : base;
}

/** Resolve the zone label for an entry under the chosen grouping. */
function zoneLabelFor(entry: SsrfEntry, grouping: SsrfZoneGrouping): string {
  if (grouping === 'service') {
    return (entry.service || 'Other').toString();
  }
  // 'location'
  return (entry.loc_name || entry.org || entry.service || 'SSRF').toString();
}

function toCtcssDcs(detail: ReturnType<typeof parseSsrfModeDetail>): CTCSSDCS {
  if (detail.ctcss != null) return { type: 'CTCSS', value: detail.ctcss };
  if (detail.dcs != null) {
    return { type: 'DCS', value: detail.dcs, polarity: detail.dcsPolarity || 'N' };
  }
  return { type: 'None' };
}

/**
 * Generate channels and zones from selected SSRF-Lite entries.
 *
 * @param startChannelNumber First channel number to assign.
 * @param selected           Entries chosen by the user.
 * @param grouping           How to group generated channels into zones.
 * @param separateTimeslots  For DMR entries, create one channel per timeslot.
 */
export function generateSsrfChannels(
  startChannelNumber: number,
  selected: SsrfEntry[],
  grouping: SsrfZoneGrouping = 'location',
  separateTimeslots = true
): GenerateSsrfResult {
  if (!selected || selected.length === 0) {
    throw new Error('No SSRF-Lite entries provided.');
  }

  const channels: Channel[] = [];
  const zones: Zone[] = [];
  const zoneByLabel = new Map<string, Zone>();
  const singleZoneChannels: number[] = [];
  let channelNumber = startChannelNumber;
  let skipped = 0;

  const addToZone = (entry: SsrfEntry, channelNum: number) => {
    if (grouping === 'single') {
      if (!singleZoneChannels.includes(channelNum)) singleZoneChannels.push(channelNum);
      return;
    }
    const label = zoneLabelFor(entry, grouping).substring(0, 10) || 'SSRF';
    let zone = zoneByLabel.get(label);
    if (!zone) {
      zone = { id: generateZoneId(), name: label, channels: [] };
      zoneByLabel.set(label, zone);
      zones.push(zone);
    }
    if (!zone.channels.includes(channelNum)) zone.channels.push(channelNum);
  };

  for (const entry of selected) {
    const rxFrequency = entry.freq_mhz;
    const txFrequency = entry.input_mhz ?? entry.freq_mhz; // simplex if no input

    if (!isValidFrequencyRange(rxFrequency) || !isValidFrequencyRange(txFrequency)) {
      skipped++;
      continue;
    }

    const isDmr = String(entry.mode).toUpperCase() === 'DMR';
    const detail = parseSsrfModeDetail(entry.mode_detail);
    const baseName = buildChannelName(entry);

    if (isDmr) {
      const timeslots =
        separateTimeslots && detail.timeslots && detail.timeslots.length > 0
          ? detail.timeslots
          : [detail.timeslots?.[0] ?? 1];

      for (const ts of timeslots) {
        let name = baseName;
        if (separateTimeslots && (detail.timeslots?.length ?? 0) > 1) {
          name = `${baseName}-${ts}`.substring(0, 16);
        }
        const channel = createDefaultChannel({
          number: channelNumber++,
          name,
          rxFrequency,
          txFrequency,
          mode: 'Digital',
          bandwidth: '12.5kHz',
          power: 'High',
          scanAdd: true,
          colorCode: detail.colorCode ?? 0,
          source: 'SSRF-Lite',
        });
        channel.slotOperation = ts === 2 ? 1 : 0;
        channels.push(channel);
        addToZone(entry, channel.number);
      }
    } else {
      // Analog / FM (and other modes imported as analog receive).
      const tone = toCtcssDcs(detail);
      const channel = createDefaultChannel({
        number: channelNumber++,
        name: baseName,
        rxFrequency,
        txFrequency,
        mode: 'Analog',
        bandwidth: '25kHz',
        power: 'High',
        scanAdd: true,
        // TX tone keys the repeater; leave RX open so all traffic is heard.
        txCtcssDcs: tone,
        rxCtcssDcs: { type: 'None' },
        source: 'SSRF-Lite',
      });
      channels.push(channel);
      addToZone(entry, channel.number);
    }
  }

  if (grouping === 'single' && singleZoneChannels.length > 0) {
    zones.push({
      id: generateZoneId(),
      name: 'SSRF',
      channels: Array.from(new Set(singleZoneChannels)),
    });
  }

  return {
    channels,
    zones,
    summary: {
      entriesSelected: selected.length,
      channelsCreated: channels.length,
      zonesCreated: zones.length,
      skipped,
    },
  };
}
