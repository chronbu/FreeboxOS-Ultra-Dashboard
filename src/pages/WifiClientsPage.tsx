import React, { useCallback, useMemo, useState } from 'react';
import {
  ChevronLeft,
  Wifi,
  Router,
  RadioTower,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  Clock,
  ArrowDownWideNarrow,
  Info
} from 'lucide-react';
import { useLanStore } from '../stores/lanStore';
import { useCapabilitiesStore } from '../stores/capabilitiesStore';
import { usePolling } from '../hooks/usePolling';
import { POLLING_INTERVALS } from '../utils/constants';
import {
  formatMbps,
  formatSessionDuration,
  getSignalBars,
  SIGNAL_QUALITY_LABELS,
  type SignalQuality,
  type WifiBand,
  type WifiGeneration
} from '../utils/wifi';
import {
  enrichDevicesWithStations,
  filterWifiDevices,
  getRepeaterMacs,
  groupWifiDevicesByAccessPoint,
  sortWifiDevices,
  type AccessPointGroup,
  type WifiDeviceSort
} from '../utils/wifiMapping';
import type { Device } from '../types';

interface WifiClientsPageProps {
  onBack: () => void;
}

// ──── Styles ────

const GENERATION_STYLES: Record<WifiGeneration, string> = {
  wifi7: 'bg-purple-500/15 text-purple-300 border-purple-500/40',
  wifi6e: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40',
  wifi6: 'bg-blue-500/15 text-blue-300 border-blue-500/40',
  wifi5: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  wifi4: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  legacy: 'bg-orange-500/15 text-orange-300 border-orange-500/40',
  unknown: 'bg-gray-700/40 text-gray-300 border-gray-600'
};

const BAND_STYLES: Record<WifiBand, string> = {
  '6GHz': 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30',
  '5GHz': 'bg-blue-500/10 text-blue-300 border-blue-500/30',
  '2.4GHz': 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  unknown: 'bg-gray-700/40 text-gray-300 border-gray-600'
};

const SIGNAL_COLORS: Record<SignalQuality, string> = {
  excellent: 'bg-emerald-400',
  good: 'bg-green-400',
  fair: 'bg-amber-400',
  weak: 'bg-red-400',
  unknown: 'bg-gray-600'
};

const SIGNAL_TEXT: Record<SignalQuality, string> = {
  excellent: 'text-emerald-400',
  good: 'text-green-400',
  fair: 'text-amber-400',
  weak: 'text-red-400',
  unknown: 'text-gray-500'
};

const SORT_OPTIONS: { id: WifiDeviceSort; label: string }[] = [
  { id: 'signal', label: 'Signal' },
  { id: 'name', label: 'Nom' },
  { id: 'standard', label: 'Norme' }
];

const BAND_FILTERS: { id: WifiBand | 'all'; label: string }[] = [
  { id: 'all', label: 'Toutes' },
  { id: '2.4GHz', label: '2,4 GHz' },
  { id: '5GHz', label: '5 GHz' },
  { id: '6GHz', label: '6 GHz' }
];

const GENERATION_FILTERS: { id: WifiGeneration | 'all'; label: string }[] = [
  { id: 'all', label: 'Toutes' },
  { id: 'wifi7', label: 'Wi-Fi 7' },
  { id: 'wifi6e', label: 'Wi-Fi 6E' },
  { id: 'wifi6', label: 'Wi-Fi 6' },
  { id: 'wifi5', label: 'Wi-Fi 5' },
  { id: 'wifi4', label: 'Wi-Fi 4' },
  { id: 'legacy', label: 'Legacy' }
];

const REPEATER_STATUS_LABELS: Record<string, string> = {
  starting: 'Démarrage',
  running: 'En ligne',
  rebooting: 'Redémarrage',
  reboot: 'Redémarrage',
  updating: 'Mise à jour',
  reboot_failure: 'Échec du redémarrage',
  update_failure: 'Échec de la mise à jour',
  disconnected: 'Déconnecté'
};

// ──── Small UI pieces ────

const Pill: React.FC<{ className: string; title?: string; children: React.ReactNode }> = ({ className, title, children }) => (
  <span title={title} className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full border whitespace-nowrap ${className}`}>
    {children}
  </span>
);

const SignalIndicator: React.FC<{ signal?: number; quality: SignalQuality }> = ({ signal, quality }) => {
  const bars = getSignalBars(quality);
  return (
    <div className="flex items-center gap-2" title={`Qualité : ${SIGNAL_QUALITY_LABELS[quality]}`}>
      <div className="flex items-end gap-[2px] h-4" aria-hidden="true">
        {[1, 2, 3, 4].map((level) => (
          <div
            key={level}
            className={`w-[4px] rounded-sm ${level <= bars ? SIGNAL_COLORS[quality] : 'bg-gray-800'}`}
            style={{ height: `${level * 25}%` }}
          />
        ))}
      </div>
      <div className="leading-tight">
        <div className={`text-sm font-mono ${SIGNAL_TEXT[quality]}`}>
          {signal !== undefined ? `${signal} dBm` : '—'}
        </div>
        <div className="text-[10px] text-gray-500">{SIGNAL_QUALITY_LABELS[quality]}</div>
      </div>
    </div>
  );
};

const RatePair: React.FC<{ down: string; up: string }> = ({ down, up }) => (
  <div className="text-xs font-mono leading-tight">
    <div className="flex items-center gap-1 text-blue-300">
      <ArrowDown size={11} className="shrink-0" /> {down}
    </div>
    <div className="flex items-center gap-1 text-emerald-300">
      <ArrowUp size={11} className="shrink-0" /> {up}
    </div>
  </div>
);

const MetricLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5 md:hidden">{children}</div>
);

// Live rates from lanStore are in Mb/s; small values are shown in kb/s
const formatLive = (mbps: number): string => {
  if (!mbps) return '0';
  if (mbps < 1) return `${Math.round(mbps * 1000)} kb/s`;
  return formatMbps(mbps);
};

// Negotiated link details, only known for clients of the box
// (repeaters do not expose their stations)
const getLinkDetails = (device: Device): string | null => {
  const wifi = device.wifi;
  if (!wifi) return null;
  const parts: string[] = [];
  if (wifi.channelWidth) parts.push(`${wifi.channelWidth} MHz`);
  else if (wifi.channelWidthRaw) parts.push(wifi.channelWidthRaw);
  if (wifi.mcs !== undefined) parts.push(`MCS ${wifi.mcs}`);
  if (wifi.nss) parts.push(`${wifi.nss}x${wifi.nss}`);
  return parts.length > 0 ? parts.join(' · ') : null;
};

// ──── Device row (stacked card on mobile, grid row on desktop) ────

const GRID_COLUMNS = 'md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)] md:items-center md:gap-4';

const DeviceRow: React.FC<{ device: Device; isBackhaul: boolean }> = ({ device, isBackhaul }) => {
  const wifi = device.wifi;
  if (!wifi) return null;
  const linkDetails = getLinkDetails(device);

  return (
    <div className={`bg-[#1a1a1a] rounded-lg border border-gray-700/50 p-3 ${GRID_COLUMNS}`}>
      {/* Name */}
      <div className="min-w-0 mb-2 md:mb-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-white truncate" title={device.name}>{device.name}</span>
          {isBackhaul && <Pill className="bg-gray-700/40 text-gray-300 border-gray-600">Répéteur</Pill>}
        </div>
        <div className="text-[11px] text-gray-500 font-mono truncate">
          {[device.ip, device.mac].filter(Boolean).join(' · ') || '—'}
        </div>
      </div>

      {/* Norme + bande */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3 md:mb-0">
        <Pill className={GENERATION_STYLES[wifi.generation]} title={wifi.standard ? `802.11${wifi.standard}` : 'Norme inconnue'}>
          {wifi.standardLabel}
        </Pill>
        <Pill className={BAND_STYLES[wifi.band]}>{wifi.bandLabel}</Pill>
        {linkDetails && <span className="text-[10px] text-gray-500 font-mono w-full md:w-auto">{linkDetails}</span>}
      </div>

      {/* Metrics: 2 columns on mobile, inline cells on desktop */}
      <div className="grid grid-cols-2 gap-3 md:contents">
        <div>
          <MetricLabel>Signal</MetricLabel>
          <SignalIndicator signal={wifi.signal} quality={wifi.signalQuality} />
        </div>
        <div title="Débit PHY négocié (↓ vers l'appareil, ↑ depuis l'appareil)">
          <MetricLabel>Débit PHY</MetricLabel>
          <RatePair down={formatMbps(wifi.phyDownMbps)} up={formatMbps(wifi.phyUpMbps)} />
        </div>
        <div title="Débit instantané">
          <MetricLabel>Débit actuel</MetricLabel>
          <RatePair down={formatLive(wifi.liveDownMbps)} up={formatLive(wifi.liveUpMbps)} />
        </div>
        <div>
          <MetricLabel>Connecté depuis</MetricLabel>
          <div className="flex items-center gap-1 text-xs text-gray-300 font-mono">
            <Clock size={11} className="text-gray-500 shrink-0" />
            {formatSessionDuration(wifi.sessionDuration)}
          </div>
        </div>
      </div>
    </div>
  );
};

// ──── Access point section ────

const AccessPointSection: React.FC<{
  group: AccessPointGroup;
  devices: Device[];
  repeaterMacs: Set<string>;
  boxName: string;
}> = ({ group, devices, repeaterMacs, boxName }) => {
  const isGateway = group.type === 'gateway';
  const Icon = isGateway ? Router : RadioTower;
  const repeater = group.repeater;
  const total = group.devices.length;

  const bandCounts = useMemo(() => {
    const counts: Record<WifiBand, number> = { '2.4GHz': 0, '5GHz': 0, '6GHz': 0, unknown: 0 };
    for (const d of group.devices) if (d.wifi) counts[d.wifi.band]++;
    return counts;
  }, [group.devices]);

  const subtitle = isGateway
    ? 'Box'
    : [
        repeater?.model?.toUpperCase(),
        repeater?.status ? (REPEATER_STATUS_LABELS[repeater.status] || repeater.status) : undefined,
        repeater?.firmware_version ? `v${repeater.firmware_version}` : undefined
      ].filter(Boolean).join(' · ') || `Répéteur (id ${group.uid || '?'})`;

  return (
    <section className="bg-[#121212] rounded-xl border border-gray-800 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`p-2 rounded-lg ${isGateway ? 'bg-red-500/15' : 'bg-blue-500/15'}`}>
            <Icon size={20} className={isGateway ? 'text-red-400' : 'text-blue-400'} />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-base sm:text-lg text-gray-200 truncate">{isGateway ? boxName : group.name}</h2>
            <p className="text-xs text-gray-500 truncate">{subtitle}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(['2.4GHz', '5GHz', '6GHz', 'unknown'] as WifiBand[])
            .filter((band) => bandCounts[band] > 0)
            .map((band) => (
              <Pill key={band} className={BAND_STYLES[band]}>
                {band === 'unknown' ? 'Autre' : band.replace('2.4', '2,4').replace('GHz', ' GHz')} · {bandCounts[band]}
              </Pill>
            ))}
          <span className="text-xs bg-emerald-900/30 border border-emerald-700 text-emerald-400 px-2 py-0.5 rounded-full whitespace-nowrap">
            {devices.length !== total ? `${devices.length} / ${total}` : total} appareil{total > 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {devices.length > 0 ? (
        <>
          {/* Column headers (desktop only) */}
          <div className={`hidden px-3 pb-2 text-[10px] uppercase tracking-wide text-gray-500 ${GRID_COLUMNS}`}>
            <span>Appareil</span>
            <span>Norme / bande</span>
            <span>Signal</span>
            <span>Débit PHY</span>
            <span>Débit actuel</span>
            <span>Connecté depuis</span>
          </div>
          <div className="space-y-2">
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                isBackhaul={device.type === 'repeater' || repeaterMacs.has((device.mac || '').toLowerCase())}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="text-center text-gray-500 text-sm py-6">
          {total > 0 ? 'Aucun appareil ne correspond aux filtres' : 'Aucun appareil connecté'}
        </div>
      )}
    </section>
  );
};

const FilterChips = <T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) => (
  <div className="flex items-center gap-2 min-w-0">
    <span className="text-xs text-gray-500 shrink-0">{label}</span>
    <div className="flex gap-1 overflow-x-auto no-scrollbar">
      {options.map((option) => (
        <button
          key={option.id}
          onClick={() => onChange(option.id)}
          className={`text-xs px-2 py-1 rounded border transition-colors whitespace-nowrap ${
            value === option.id
              ? 'bg-blue-900/30 border-blue-700 text-blue-400'
              : 'bg-[#1a1a1a] border-gray-700 text-gray-400 hover:bg-[#252525]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  </div>
);

// ──── Page ────

export const WifiClientsPage: React.FC<WifiClientsPageProps> = ({ onBack }) => {
  const { devices, apStations, repeaters, repeatersAvailable, isLoading, fetchDevices, fetchWifiDetails } = useLanStore();
  const { getModelName } = useCapabilitiesStore();

  const [sort, setSort] = useState<WifiDeviceSort>('signal');
  const [bandFilter, setBandFilter] = useState<WifiBand | 'all'>('all');
  const [generationFilter, setGenerationFilter] = useState<WifiGeneration | 'all'>('all');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Devices are already polled by the dashboard; repeaters / box stations
  // are only fetched while this page is open.
  usePolling(fetchWifiDetails, { interval: POLLING_INTERVALS.devices });

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.all([fetchDevices(), fetchWifiDetails()]);
    setIsRefreshing(false);
  }, [fetchDevices, fetchWifiDetails]);

  const groups = useMemo(
    () => groupWifiDevicesByAccessPoint(enrichDevicesWithStations(devices, apStations), repeaters),
    [devices, apStations, repeaters]
  );
  const repeaterMacs = useMemo(() => getRepeaterMacs(repeaters), [repeaters]);

  const visibleByGroup = useMemo(
    () => groups.map((group) => sortWifiDevices(
      filterWifiDevices(group.devices, { band: bandFilter, generation: generationFilter }),
      sort
    )),
    [groups, bandFilter, generationFilter, sort]
  );

  const totalWifi = groups.reduce((sum, g) => sum + g.devices.length, 0);
  const repeaterCount = groups.length - 1;

  return (
    <div className="min-h-screen bg-[#050505] text-gray-300">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-[#0a0a0a]/95 backdrop-blur-sm border-b border-gray-800">
        <div className="max-w-[1920px] mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 sm:gap-4 min-w-0">
              <button onClick={onBack} className="p-2 hover:bg-gray-800 rounded-lg transition-colors shrink-0">
                <ChevronLeft size={24} />
              </button>
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 bg-blue-500/20 rounded-lg shrink-0">
                  <Wifi size={24} className="text-blue-400" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-lg sm:text-xl font-bold text-white truncate">Wi-Fi par point d'accès</h1>
                  <p className="text-xs sm:text-sm text-gray-500 truncate">
                    {totalWifi} appareil{totalWifi > 1 ? 's' : ''} · box{repeaterCount > 0 ? ` + ${repeaterCount} répéteur${repeaterCount > 1 ? 's' : ''}` : ''}
                  </p>
                </div>
              </div>
            </div>
            <button
              onClick={handleRefresh}
              className="p-2 hover:bg-gray-800 rounded-lg transition-colors shrink-0"
              title="Rafraîchir"
            >
              <RefreshCw size={18} className={isRefreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1920px] mx-auto px-4 py-6 pb-24 space-y-4">
        {/* Toolbar */}
        <div className="bg-[#121212] rounded-xl border border-gray-800 p-3 flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-6">
          <div className="flex items-center gap-2">
            <ArrowDownWideNarrow size={14} className="text-gray-500 shrink-0" />
            <FilterChips label="Tri" options={SORT_OPTIONS} value={sort} onChange={setSort} />
          </div>
          <FilterChips label="Bande" options={BAND_FILTERS} value={bandFilter} onChange={setBandFilter} />
          <FilterChips label="Norme" options={GENERATION_FILTERS} value={generationFilter} onChange={setGenerationFilter} />
        </div>

        {repeatersAvailable === false && repeaterCount > 0 && (
          <div className="flex items-start gap-2 text-xs text-gray-400 bg-[#121212] border border-gray-800 rounded-lg p-3">
            <Info size={14} className="text-gray-500 shrink-0 mt-0.5" />
            <span>
              La liste des répéteurs (/repeater/) n'est pas accessible : les répéteurs sont affichés par identifiant.
            </span>
          </div>
        )}

        {isLoading && devices.length === 0 ? (
          <div className="text-center text-gray-500 py-12">Chargement...</div>
        ) : (
          groups.map((group, i) => (
            <AccessPointSection
              key={group.key}
              group={group}
              devices={visibleByGroup[i]}
              repeaterMacs={repeaterMacs}
              boxName={getModelName()}
            />
          ))
        )}

        <p className="text-[11px] text-gray-600 leading-relaxed">
          Débit PHY : débit de liaison radio négocié (↓ vers l'appareil, ↑ depuis l'appareil). Le MCS et la largeur de canal
          ne sont disponibles que pour les appareils connectés directement à la box ; l'API ne les expose pas pour les clients
          des répéteurs.
        </p>
      </main>
    </div>
  );
};
