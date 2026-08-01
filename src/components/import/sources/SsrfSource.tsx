import React, { useState } from 'react';
import { formatPlural } from '../../../utils/formatPlural';
import { useImportStores } from '../../../hooks/useImportStores';
import { useSsrfSourcesStore } from '../../../store/ssrfSourcesStore';
import { getNextChannelNumber, selectionCardClass } from '../../../utils/importHelpers';
import { generateSsrfChannels, type SsrfZoneGrouping } from '../../../services/ssrfChannels';
import { mergeChannelSetsWithExisting } from '../../../services/channelMerger';
import type { SsrfEntry } from '../../../data/ssrfData';
import { SelectAllButtons } from '../SelectAllButtons';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { SectionTitle } from '../../ui/SectionTitle';

interface SsrfSourceProps {
  entries: SsrfEntry[];
  isSearching: boolean;
  supportsDigital: boolean;
  onError: (msg: string) => void;
  onGenerationResult: (r: { channels: number; zones: number }) => void;
}

export const SsrfSource: React.FC<SsrfSourceProps> = ({
  entries,
  isSearching: _isSearching,
  supportsDigital,
  onError,
  onGenerationResult,
}) => {
  const { channels, setChannels, zones, setZones } = useImportStores();
  const { sources, selectedSourceId, selectSource, addSource, addLocalSource, removeSource } =
    useSsrfSourcesStore();

  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [grouping, setGrouping] = useState<SsrfZoneGrouping>('location');
  const [separateTimeslots, setSeparateTimeslots] = useState(true);
  const [isAdding, setIsAdding] = useState(false);

  // Custom source management
  const [showManage, setShowManage] = useState(false);
  const [addMode, setAddMode] = useState<'url' | 'local'>('url');
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newLocalData, setNewLocalData] = useState('');

  // On analog-only radios, DMR entries cannot be programmed — hide them.
  const usableEntries = supportsDigital
    ? entries
    : entries.filter((e) => String(e.mode).toUpperCase() !== 'DMR');

  const matchesFilter = (e: SsrfEntry): boolean => {
    if (!filter.trim()) return true;
    const f = filter.toLowerCase();
    return (
      (e.call_sign || '').toLowerCase().includes(f) ||
      e.name.toLowerCase().includes(f) ||
      (e.org || '').toLowerCase().includes(f) ||
      (e.loc_name || '').toLowerCase().includes(f) ||
      (e.service || '').toLowerCase().includes(f) ||
      (e.mode || '').toLowerCase().includes(f)
    );
  };

  const handleToggle = (index: number) => {
    const next = new Set(selected);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setSelected(next);
  };

  const handleSelectAll = () => {
    setSelected(new Set(usableEntries.map((_, i) => i)));
  };

  const handleDeselectAll = () => setSelected(new Set());

  const handleAddSource = () => {
    const err =
      addMode === 'local'
        ? addLocalSource(newName, newLocalData)
        : addSource(newName, newUrl);
    if (err) {
      onError(err);
      return;
    }
    onError('');
    setNewName('');
    setNewUrl('');
    setNewLocalData('');
    setShowManage(false);
  };

  const handleLocalFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setNewLocalData(text);
      if (!newName.trim()) {
        setNewName(file.name.replace(/\.json$/i, ''));
      }
    } catch {
      onError('Could not read that file');
    } finally {
      // Allow re-selecting the same file.
      e.target.value = '';
    }
  };

  const handleAddChannels = async () => {
    if (selected.size === 0) {
      onError('Please select at least one SSRF-Lite entry');
      return;
    }
    setIsAdding(true);
    onError('');

    try {
      const selectedList = Array.from(selected)
        .map((i) => usableEntries[i])
        .filter(Boolean);

      if (selectedList.length === 0) {
        throw new Error('No SSRF-Lite entries selected');
      }

      const nextChannelNumber = getNextChannelNumber(channels);
      const result = generateSsrfChannels(
        nextChannelNumber,
        selectedList,
        grouping,
        separateTimeslots
      );

      if (result.channels.length === 0) {
        onError('No channels to add (selected entries were outside supported frequency ranges)');
        return;
      }

      const { channelsToAdd, channelMapping } = mergeChannelSetsWithExisting(
        channels,
        [result.channels],
        nextChannelNumber
      );
      setChannels([...channels, ...channelsToAdd]);

      const remappedZones = result.zones
        .map((zone) => ({
          ...zone,
          channels: [
            ...new Set(
              zone.channels
                .map((num) => channelMapping.get(num))
                .filter((num): num is number => num !== undefined)
            ),
          ].sort((a, b) => a - b),
        }))
        .filter((zone) => zone.channels.length > 0);
      setZones([...zones, ...remappedZones]);

      onGenerationResult({ channels: channelsToAdd.length, zones: remappedZones.length });
      setSelected(new Set());
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to add SSRF-Lite channels');
    } finally {
      setIsAdding(false);
    }
  };

  const filtered = usableEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => matchesFilter(entry));

  return (
    <Card padding="tight" className="mb-4">
      <SectionTitle as="h3" size="lg" className="mb-4">SSRF-Lite Repeaters &amp; Systems</SectionTitle>

      {/* Data source selector */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-cool-gray">Data source</label>
          <button
            type="button"
            onClick={() => setShowManage((v) => !v)}
            className="text-xs text-neon-cyan hover:underline"
          >
            {showManage ? 'Close' : 'Manage sources'}
          </button>
        </div>
        <select
          value={selectedSourceId}
          onChange={(e) => selectSource(e.target.value)}
          className="w-full bg-black border border-neon-cyan rounded px-3 py-2 text-white"
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        {showManage && (
          <div className="mt-3 space-y-3 border border-neon-cyan border-opacity-30 rounded p-3">
            {sources.filter((s) => !s.builtIn).length > 0 && (
              <div className="space-y-1">
                {sources
                  .filter((s) => !s.builtIn)
                  .map((s) => (
                    <div key={s.id} className="flex items-center justify-between text-sm">
                      <span className="text-cool-gray truncate mr-2" title={s.url}>{s.name}</span>
                      <button
                        type="button"
                        onClick={() => removeSource(s.id)}
                        className="text-xs text-red-400 hover:underline flex-shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
              </div>
            )}
            <div className="space-y-2">
              {/* URL vs. local (private overlay) toggle */}
              <div className="flex gap-4 text-sm">
                {(['url', 'local'] as const).map((m) => (
                  <label key={m} className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="ssrfAddMode"
                      value={m}
                      checked={addMode === m}
                      onChange={() => setAddMode(m)}
                    />
                    <span className="text-cool-gray">
                      {m === 'url' ? 'GitHub URL' : 'Local file (private)'}
                    </span>
                  </label>
                ))}
              </div>

              <input
                type="text"
                placeholder={addMode === 'local' ? 'Source name (e.g. Family Net)' : 'Source name (e.g. My Fork)'}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-black border border-neon-cyan rounded px-3 py-2 text-white text-sm"
              />

              {addMode === 'url' ? (
                <>
                  <p className="text-xs text-cool-gray">
                    Add your own GitHub fork. The URL must be an HTTPS link on
                    <span className="text-neon-cyan"> github.io </span> or
                    <span className="text-neon-cyan"> raw.githubusercontent.com</span>.
                  </p>
                  <input
                    type="text"
                    placeholder="https://you.github.io/ssrf-lite/data.json"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    className="w-full bg-black border border-neon-cyan rounded px-3 py-2 text-white text-sm"
                  />
                </>
              ) : (
                <>
                  <p className="text-xs text-cool-gray">
                    Load a compiled <span className="text-neon-cyan">data.json</span> you built
                    locally (e.g. with <span className="text-neon-cyan">--extra-ssrf-root</span> for
                    private overlays). Nothing is uploaded — the data stays in this browser.
                  </p>
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={handleLocalFile}
                    className="w-full text-sm text-cool-gray file:mr-2 file:rounded file:border file:border-neon-cyan file:bg-black file:px-3 file:py-1 file:text-neon-cyan"
                  />
                  <textarea
                    placeholder='...or paste data.json here: {"channels":[...]}'
                    value={newLocalData}
                    onChange={(e) => setNewLocalData(e.target.value)}
                    rows={4}
                    className="w-full bg-black border border-neon-cyan rounded px-3 py-2 text-white text-xs font-mono"
                  />
                </>
              )}

              <Button
                onClick={handleAddSource}
                disabled={
                  !newName.trim() ||
                  (addMode === 'url' ? !newUrl.trim() : !newLocalData.trim())
                }
                className="bg-neon-cyan text-dark-charcoal hover:bg-neon-cyan-bright"
              >
                Add source
              </Button>
            </div>
          </div>
        )}
      </div>

      {usableEntries.length === 0 ? (
        <p className="text-sm text-cool-gray">
          {_isSearching
            ? 'Searching SSRF-Lite data...'
            : 'Select "SSRF-Lite" in the search types above and search a location to find nearby entries.'}
        </p>
      ) : (
        <>
          <div className="mb-4">
            <input
              type="text"
              placeholder="Filter by callsign, name, location, or service..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full bg-black border border-neon-cyan rounded px-3 py-2 text-white"
            />
          </div>

          <div className="flex justify-between items-center mb-4">
            <SectionTitle as="h4" size="md">
              {filtered.length} of {usableEntries.length} {formatPlural(usableEntries.length, 'Entry', 'Entries')}
              {filter.trim() && ' (filtered)'}
            </SectionTitle>
            <SelectAllButtons onSelectAll={handleSelectAll} onDeselectAll={handleDeselectAll} />
          </div>

          <div className="space-y-2 max-h-96 overflow-y-auto mb-4">
            {filtered.map(({ entry, index }) => (
              <div
                key={index}
                className={selectionCardClass(selected.has(index))}
                onClick={() => handleToggle(index)}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(index)}
                    onChange={() => handleToggle(index)}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-neon-cyan">
                        {entry.call_sign || entry.name}
                      </span>
                      {entry.mode && <span className="text-cool-gray text-sm">{entry.mode}</span>}
                      {entry.mode_detail && (
                        <span className="text-cool-gray text-xs">{entry.mode_detail}</span>
                      )}
                    </div>
                    <div className="text-sm text-cool-gray">
                      <div>
                        {entry.freq_mhz.toFixed(4)} MHz
                        {entry.input_mhz != null && ` (in ${entry.input_mhz.toFixed(4)})`}
                      </div>
                      <div>
                        {entry.loc_name || entry.org || entry.service || '—'}
                        {` (${entry.distance.toFixed(1)} mi)`}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {selected.size > 0 && (
            <div className="space-y-3">
              <div className="flex flex-col gap-2">
                <label className="text-sm text-cool-gray">Zone Grouping:</label>
                {(['location', 'service', 'single'] as SsrfZoneGrouping[]).map((g) => (
                  <label key={g} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="ssrfZoneGrouping"
                      value={g}
                      checked={grouping === g}
                      onChange={() => setGrouping(g)}
                    />
                    <span className="text-cool-gray">
                      {g === 'location'
                        ? 'Group by location'
                        : g === 'service'
                        ? 'Group by service'
                        : 'Single zone (all entries together)'}
                    </span>
                  </label>
                ))}
              </div>
              {supportsDigital && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={separateTimeslots}
                    onChange={(e) => setSeparateTimeslots(e.target.checked)}
                  />
                  <span className="text-cool-gray">Create separate DMR channels for each timeslot (TS1, TS2)</span>
                </label>
              )}
              <Button
                onClick={handleAddChannels}
                disabled={isAdding}
                className="bg-neon-cyan text-dark-charcoal hover:bg-neon-cyan-bright w-full"
              >
                {isAdding ? 'Adding...' : `Add ${selected.size} Selected ${formatPlural(selected.size, 'Entry', 'Entries')}`}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
};
