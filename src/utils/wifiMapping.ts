// Mapping of raw Freebox LAN hosts / Wi-Fi stations / repeaters to the
// dashboard models. Pure functions only (no store, no fetch) so they can be
// unit-tested against JSON fixtures and reused by the backend.

import type {
  ApStationEntry,
  AccessPointDeviceCount,
  Device,
  DeviceWifiInfo,
  FreeboxRepeater,
  LanHost,
  LanHostAccessPoint,
  WifiStationLinkStats
} from '../types';
import {
  bytesPerSecToMbps,
  getBandLabel,
  getGenerationRank,
  getSignalQuality,
  getStandardLabel,
  getWifiGeneration,
  normalizeBand,
  parseChannelWidth,
  phyRateToMbps,
  type WifiBand,
  type WifiGeneration
} from './wifi';

// ==================== Host -> Device ====================

// Map host type to device type
const mapHostType = (hostType?: string): Device['type'] => {
  const typeMap: Record<string, Device['type']> = {
    smartphone: 'phone',
    phone: 'phone',
    tablet: 'tablet',
    laptop: 'laptop',
    computer: 'desktop',
    workstation: 'desktop',
    desktop: 'desktop',
    multimedia: 'tv',
    tv: 'tv',
    television: 'tv',
    gaming_console: 'tv',
    networking_device: 'repeater',
    printer: 'iot',
    car: 'car',
    other: 'other'
  };
  return typeMap[hostType?.toLowerCase() || ''] || 'other';
};

/**
 * Live throughput of a host, from the DEVICE point of view, in Mb/s.
 *
 * `access_point.rx_*` / `tx_*` are counted from the access point side:
 * rx = received by the box/repeater (device upload), tx = sent by the
 * box/repeater (device download). Real capture: rx_bytes 331 MB vs tx_bytes
 * 32 GB for a phone over a 21-day session, which only makes sense if tx is
 * the downlink. If this turns out to be inverted, fix it here only.
 */
export const getLiveRates = (ap?: Partial<LanHostAccessPoint> | null): { downMbps: number; upMbps: number } => ({
  downMbps: bytesPerSecToMbps(ap?.tx_rate),
  upMbps: bytesPerSecToMbps(ap?.rx_rate)
});

/** Build the Wi-Fi details of a host, or undefined if it is not on Wi-Fi. */
export const mapWifiInfo = (ap?: Partial<LanHostAccessPoint> | null, active = true): DeviceWifiInfo | undefined => {
  if (!ap || ap.connectivity_type !== 'wifi') return undefined;
  const info = ap.wifi_information || {};
  const live = active ? getLiveRates(ap) : { downMbps: 0, upMbps: 0 };
  const signal = typeof info.signal === 'number' ? info.signal : undefined;

  return {
    band: normalizeBand(info.band),
    bandRaw: info.band || undefined,
    bandLabel: getBandLabel(info.band),
    standard: info.standard || undefined,
    standardLabel: getStandardLabel(info.standard, info.band),
    generation: getWifiGeneration(info.standard, info.band),
    signal,
    signalQuality: getSignalQuality(signal),
    // AP perspective: tx = AP -> device (download), rx = device -> AP (upload)
    phyDownMbps: phyRateToMbps(info.phy_tx_rate),
    phyUpMbps: phyRateToMbps(info.phy_rx_rate),
    liveDownMbps: live.downMbps,
    liveUpMbps: live.upMbps,
    sessionDuration: typeof info.sess_duration === 'number' ? info.sess_duration : undefined,
    ssid: info.ssid || undefined,
    bssid: info.bssid || undefined
  };
};

/** Map a raw LAN host (/lan/browser/{iface}/) to a dashboard Device. */
export const mapLanHostToDevice = (host: LanHost): Device => {
  const ipv4 = host.l3connectivities?.find((c) => c.af === 'ipv4' && c.active);
  const ap = host.access_point;
  const active = !!(host.active && host.reachable);

  // Get connection type from access_point.connectivity_type (most reliable)
  const connection: Device['connection'] = ap?.connectivity_type === 'wifi' ? 'wifi' : 'ethernet';

  // Speed from access_point (bytes/s -> Mbps), only while the device is active
  const speedDown = ap && host.active ? bytesPerSecToMbps(ap.rx_rate) : 0;
  const speedUp = ap && host.active ? bytesPerSecToMbps(ap.tx_rate) : 0;

  const accessPoint = ap && (ap.type === 'gateway' || ap.type === 'repeater')
    ? { type: ap.type, uid: ap.uid !== undefined && ap.uid !== null ? String(ap.uid) : '', mac: ap.mac || undefined }
    : undefined;

  return {
    id: host.id,
    name: host.primary_name || host.vendor_name || 'Unknown Device',
    type: mapHostType(host.host_type),
    connection,
    speedDown,
    speedUp,
    active,
    mac: host.l2ident?.id,
    ip: ipv4?.addr,
    vendor: host.vendor_name,
    accessPoint,
    wifi: connection === 'wifi' ? mapWifiInfo(ap, !!host.active) : undefined
  };
};

// ==================== Box stations enrichment ====================

const normalizeMac = (mac?: string | null): string => (mac || '').toLowerCase();

interface RawWifiAp {
  id: number;
  name?: string;
  config?: { band?: string };
  status?: { channel_width?: number };
}

/**
 * Flatten the stations of every box radio into ApStationEntry objects
 * (used by GET /api/wifi/ap-stations). `stationsByAp` maps an AP id to the
 * `result` of /wifi/ap/{id}/stations/ (anything that is not an array is ignored).
 */
export const buildApStationEntries = (aps: RawWifiAp[], stationsByAp: Record<string, unknown>): ApStationEntry[] => {
  const entries: ApStationEntry[] = [];
  for (const ap of aps || []) {
    const stations = stationsByAp[String(ap.id)];
    if (!Array.isArray(stations)) continue;
    for (const station of stations) {
      if (!station || typeof station !== 'object') continue;
      entries.push({
        apId: ap.id,
        apName: ap.name,
        apBand: ap.config?.band,
        apChannelWidth: ap.status?.channel_width,
        station
      });
    }
  }
  return entries;
};

/** Index /wifi/ap/{id}/stations/ entries by station MAC. */
export const buildStationIndex = (entries: ApStationEntry[]): Map<string, ApStationEntry> => {
  const index = new Map<string, ApStationEntry>();
  for (const entry of entries || []) {
    const station = entry?.station;
    if (!station) continue;
    const mac = normalizeMac(station.mac || station.host?.l2ident?.id);
    if (mac) index.set(mac, entry);
  }
  return index;
};

const isValidIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** MCS index of a link, picking the most recent generation field present. */
export const getStationMcs = (stats?: WifiStationLinkStats | null): number | undefined => {
  if (!stats) return undefined;
  for (const value of [stats.eht_mcs, stats.he_mcs, stats.vht_mcs, stats.mcs]) {
    if (isValidIndex(value)) return value;
  }
  return undefined;
};

/**
 * Add the negotiated link details (MCS, channel width, NSS) from the box
 * stations list. Only applies to devices attached to the box: repeaters do
 * not expose their stations, so their clients keep no width at all.
 */
export const enrichDeviceWithStation = (device: Device, entry?: ApStationEntry): Device => {
  if (!device.wifi || !entry || device.accessPoint?.type === 'repeater') return device;
  const { station } = entry;
  // Prefer the downlink (AP -> device) stats, fallback on uplink
  const tx = station.last_tx;
  const rx = station.last_rx;
  const rawWidth = tx?.width ?? rx?.width;
  const width = parseChannelWidth(rawWidth);
  const mcs = getStationMcs(tx) ?? getStationMcs(rx);
  const nss = tx?.nss ?? rx?.nss;

  return {
    ...device,
    wifi: {
      ...device.wifi,
      mcs,
      nss: isValidIndex(nss) && nss > 0 ? nss : undefined,
      channelWidth: width ?? undefined,
      channelWidthRaw: width === null && rawWidth !== undefined && rawWidth !== null && rawWidth !== '' ? String(rawWidth) : undefined,
      apId: entry.apId
    }
  };
};

export const enrichDevicesWithStations = (devices: Device[], entries: ApStationEntry[]): Device[] => {
  if (!entries || entries.length === 0) return devices;
  const index = buildStationIndex(entries);
  return devices.map((device) => enrichDeviceWithStation(device, index.get(normalizeMac(device.mac))));
};

// ==================== Grouping by access point ====================

export interface AccessPointGroup {
  key: string;                       // "gateway" | "repeater:<uid>"
  type: 'gateway' | 'repeater';
  uid: string;
  name: string;
  repeater?: FreeboxRepeater;        // details from /repeater/ when available
  devices: Device[];
}

export const getRepeaterLabel = (uid: string, repeaters?: FreeboxRepeater[]): string => {
  const repeater = findRepeater(uid, undefined, repeaters);
  return repeater?.name?.trim() || `Répéteur ${uid || '?'}`;
};

/** Find a repeater by access_point.uid (= repeater id), fallback on its MAC. */
export const findRepeater = (uid: string, apMac?: string, repeaters?: FreeboxRepeater[]): FreeboxRepeater | undefined => {
  if (!repeaters || repeaters.length === 0) return undefined;
  const byId = repeaters.find((r) => String(r.id) === uid);
  if (byId) return byId;
  const mac = normalizeMac(apMac);
  return mac ? repeaters.find((r) => normalizeMac(r.main_mac) === mac) : undefined;
};

/** MACs of the repeaters themselves (they show up as Wi-Fi clients of the box). */
export const getRepeaterMacs = (repeaters?: FreeboxRepeater[]): Set<string> =>
  new Set((repeaters || []).map((r) => normalizeMac(r.main_mac)).filter(Boolean));

/**
 * Group connected Wi-Fi devices by access point: the box first, then each
 * repeater (sorted by id). Repeaters known from /repeater/ are listed even
 * without any client.
 */
export const groupWifiDevicesByAccessPoint = (
  devices: Device[],
  repeaters: FreeboxRepeater[] = []
): AccessPointGroup[] => {
  const gateway: AccessPointGroup = { key: 'gateway', type: 'gateway', uid: '', name: 'Freebox', devices: [] };
  const repeaterGroups = new Map<string, AccessPointGroup>();

  const getRepeaterGroup = (uid: string, apMac?: string): AccessPointGroup => {
    const repeater = findRepeater(uid, apMac, repeaters);
    const groupUid = repeater ? String(repeater.id) : uid;
    let group = repeaterGroups.get(groupUid);
    if (!group) {
      group = {
        key: `repeater:${groupUid}`,
        type: 'repeater',
        uid: groupUid,
        name: repeater?.name?.trim() || `Répéteur ${groupUid || '?'}`,
        repeater,
        devices: []
      };
      repeaterGroups.set(groupUid, group);
    }
    return group;
  };

  for (const repeater of repeaters) getRepeaterGroup(String(repeater.id));

  for (const device of devices) {
    if (!device.active || device.connection !== 'wifi') continue;
    if (device.accessPoint?.type === 'repeater') {
      getRepeaterGroup(device.accessPoint.uid, device.accessPoint.mac).devices.push(device);
    } else {
      // gateway, or unknown access point: attached to the box
      gateway.devices.push(device);
    }
  }

  const sortedRepeaters = Array.from(repeaterGroups.values()).sort((a, b) => {
    const na = Number(a.uid);
    const nb = Number(b.uid);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.uid.localeCompare(b.uid);
  });

  return [gateway, ...sortedRepeaters];
};

// ==================== Sort / filter ====================

export type WifiDeviceSort = 'signal' | 'name' | 'standard';

export const sortWifiDevices = (devices: Device[], sort: WifiDeviceSort): Device[] => {
  const byName = (a: Device, b: Device) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
  return [...devices].sort((a, b) => {
    if (sort === 'signal') {
      // Strongest first, unknown signal last
      const sa = a.wifi?.signal ?? -Infinity;
      const sb = b.wifi?.signal ?? -Infinity;
      if (sa !== sb) return sb - sa;
      return byName(a, b);
    }
    if (sort === 'standard') {
      // Most recent generation first
      const ga = getGenerationRank(a.wifi?.generation ?? 'unknown');
      const gb = getGenerationRank(b.wifi?.generation ?? 'unknown');
      if (ga !== gb) return gb - ga;
      return byName(a, b);
    }
    return byName(a, b);
  });
};

export interface WifiDeviceFilter {
  band?: WifiBand | 'all';
  generation?: WifiGeneration | 'all';
}

export const filterWifiDevices = (devices: Device[], filter: WifiDeviceFilter): Device[] =>
  devices.filter((device) => {
    if (filter.band && filter.band !== 'all' && device.wifi?.band !== filter.band) return false;
    if (filter.generation && filter.generation !== 'all' && device.wifi?.generation !== filter.generation) return false;
    return true;
  });

// ==================== Counting (used by /api/wifi/full) ====================

type BandKey = AccessPointDeviceCount['byBand'] extends Record<infer K, number> ? K : never;

const bandKey = (raw?: string): BandKey => {
  switch (normalizeBand(raw)) {
    case '2.4GHz': return '2g4';
    case '5GHz': return '5g';
    case '6GHz': return '6g';
    default: return 'other';
  }
};

const emptyByBand = (): AccessPointDeviceCount['byBand'] => ({ '2g4': 0, '5g': 0, '6g': 0, other: 0 });

export interface WifiDeviceCounts {
  total: number;
  gateway: AccessPointDeviceCount;
  repeaters: AccessPointDeviceCount[];
  repeaterTotal: AccessPointDeviceCount['byBand'] & { total: number };
}

/**
 * Count active Wi-Fi hosts per access point and per band, separating the box
 * from the repeaters (previously everything was counted on the box radios,
 * see upstream issue #55).
 */
export const countWifiDevicesByAccessPoint = (hosts: Partial<LanHost>[]): WifiDeviceCounts => {
  const gateway: AccessPointDeviceCount = { type: 'gateway', uid: '', total: 0, byBand: emptyByBand() };
  const repeaters = new Map<string, AccessPointDeviceCount>();
  const repeaterTotal = { ...emptyByBand(), total: 0 };
  let total = 0;

  for (const host of hosts || []) {
    const ap = host?.access_point;
    if (!host?.active || !host.reachable || ap?.connectivity_type !== 'wifi') continue;
    total++;
    const key = bandKey(ap.wifi_information?.band);

    if (ap.type === 'repeater') {
      const uid = ap.uid !== undefined && ap.uid !== null ? String(ap.uid) : '';
      let count = repeaters.get(uid);
      if (!count) {
        count = { type: 'repeater', uid, total: 0, byBand: emptyByBand() };
        repeaters.set(uid, count);
      }
      count.total++;
      count.byBand[key]++;
      repeaterTotal.total++;
      repeaterTotal[key]++;
    } else {
      gateway.total++;
      gateway.byBand[key]++;
    }
  }

  return {
    total,
    gateway,
    repeaters: Array.from(repeaters.values()).sort((a, b) => a.uid.localeCompare(b.uid, 'en', { numeric: true })),
    repeaterTotal
  };
};
