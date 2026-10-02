// Wi-Fi helpers shared by the frontend and the backend (pure functions, no
// React / DOM / Node dependency). Everything that interprets raw values coming
// from the Freebox API (norme, bande, signal, débits PHY) lives here so that a
// wrong assumption only has to be fixed in one place.

// ==================== Bandes ====================

export type WifiBand = '2.4GHz' | '5GHz' | '6GHz' | 'unknown';

/**
 * Normalize a band value from the Freebox API.
 * Observed / documented values: "2d4g", "2g4", "2.4g", "5g", "6g" (case varies
 * between endpoints, e.g. "2G4" in /wifi/bss/). Anything else is "unknown".
 */
export const normalizeBand = (raw?: string | null): WifiBand => {
  const band = (raw || '').toLowerCase().trim();
  if (!band) return 'unknown';
  if (band.includes('6g')) return '6GHz';
  if (band.includes('5g')) return '5GHz';
  if (band === '2d4g' || band === '2g4' || band === '2.4g' || band.includes('2.4') || band.includes('2g4') || band.includes('2d4')) {
    return '2.4GHz';
  }
  return 'unknown';
};

/** Human readable band label. Unknown values are displayed as-is. */
export const getBandLabel = (raw?: string | null): string => {
  switch (normalizeBand(raw)) {
    case '2.4GHz': return '2,4 GHz';
    case '5GHz': return '5 GHz';
    case '6GHz': return '6 GHz';
    default: return raw ? raw : '—';
  }
};

// ==================== Normes ====================

export type WifiGeneration = 'legacy' | 'wifi4' | 'wifi5' | 'wifi6' | 'wifi6e' | 'wifi7' | 'unknown';

/**
 * Map the raw `standard` (802.11 suffix) to a Wi-Fi generation.
 *   n  -> Wi-Fi 4
 *   ac -> Wi-Fi 5
 *   ax -> Wi-Fi 6, or Wi-Fi 6E when the band is 6 GHz
 *   be -> Wi-Fi 7
 *   a / b / g -> Legacy
 * The "802.11" prefix is tolerated ("802.11ax" -> ax).
 */
export const getWifiGeneration = (standard?: string | null, band?: string | null): WifiGeneration => {
  const std = (standard || '').toLowerCase().trim().replace(/^802\.11/, '');
  switch (std) {
    case 'a':
    case 'b':
    case 'g':
      return 'legacy';
    case 'n':
      return 'wifi4';
    case 'ac':
      return 'wifi5';
    case 'ax':
      return normalizeBand(band) === '6GHz' ? 'wifi6e' : 'wifi6';
    case 'be':
      return 'wifi7';
    default:
      return 'unknown';
  }
};

const GENERATION_LABELS: Record<Exclude<WifiGeneration, 'unknown'>, string> = {
  legacy: 'Legacy',
  wifi4: 'Wi-Fi 4',
  wifi5: 'Wi-Fi 5',
  wifi6: 'Wi-Fi 6',
  wifi6e: 'Wi-Fi 6E',
  wifi7: 'Wi-Fi 7'
};

/** Human readable standard label. Unknown values are displayed as-is. */
export const getStandardLabel = (standard?: string | null, band?: string | null): string => {
  const generation = getWifiGeneration(standard, band);
  if (generation === 'unknown') return standard ? standard : '—';
  return GENERATION_LABELS[generation];
};

/** Sort rank of a generation (higher = more recent), used to sort by norme. */
export const getGenerationRank = (generation: WifiGeneration): number => {
  const order: WifiGeneration[] = ['unknown', 'legacy', 'wifi4', 'wifi5', 'wifi6', 'wifi6e', 'wifi7'];
  return order.indexOf(generation);
};

// ==================== Signal ====================

export type SignalQuality = 'excellent' | 'good' | 'fair' | 'weak' | 'unknown';

/**
 * Signal quality from RSSI in dBm (thresholds commonly used for Wi-Fi:
 * -67 dBm is the usual minimum for VoIP / streaming).
 */
export const getSignalQuality = (signal?: number | null): SignalQuality => {
  // The API reports a negative dBm value; 0 or positive means "no data".
  if (typeof signal !== 'number' || !Number.isFinite(signal) || signal >= 0) return 'unknown';
  if (signal >= -55) return 'excellent';
  if (signal >= -67) return 'good';
  if (signal >= -75) return 'fair';
  return 'weak';
};

export const SIGNAL_QUALITY_LABELS: Record<SignalQuality, string> = {
  excellent: 'Excellent',
  good: 'Bon',
  fair: 'Moyen',
  weak: 'Faible',
  unknown: 'Inconnu'
};

/** Number of bars (0-4) to display for a given quality. */
export const getSignalBars = (quality: SignalQuality): number => {
  switch (quality) {
    case 'excellent': return 4;
    case 'good': return 3;
    case 'fair': return 2;
    case 'weak': return 1;
    default: return 0;
  }
};

// ==================== Débits ====================

/**
 * Unit of `phy_rx_rate` / `phy_tx_rate` in `access_point.wifi_information`.
 *
 * HYPOTHESIS (to be validated on a real box): the Freebox reports PHY rates in
 * units of 100 kbit/s. Supporting evidence from real values:
 *   - 5851  -> 585.1 Mb/s = 802.11ac, 2 streams, 80 MHz, MCS7, long GI (585.0)
 *   - 7800  -> 780.0 Mb/s = 802.11ac, 2 streams, 80 MHz, MCS9, long GI (780.0)
 *   - 12009 -> 1200.9 Mb/s = 802.11ax, 2 streams, 80 MHz, MCS11, GI 0.8 µs (1201)
 * If this turns out to be wrong, only this constant needs to change.
 */
export const PHY_RATE_UNIT_KBPS = 100;

/** Convert a raw PHY rate from the API to Mb/s (null when missing/invalid). */
export const phyRateToMbps = (raw?: number | null): number | null => {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.round((raw * PHY_RATE_UNIT_KBPS) / 100) / 10;
};

/** Convert a live rate in bytes/s (rx_rate / tx_rate) to Mb/s. */
export const bytesPerSecToMbps = (raw?: number | null): number => {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.round(((raw * 8) / 1_000_000) * 10) / 10;
};

/** Format a rate in Mb/s for display ("585 Mb/s", "1,2 Gb/s"). */
export const formatMbps = (mbps?: number | null): string => {
  if (mbps === null || mbps === undefined || !Number.isFinite(mbps)) return '—';
  if (mbps >= 1000) return `${(mbps / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Gb/s`;
  if (mbps >= 100) return `${Math.round(mbps)} Mb/s`;
  return `${mbps.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mb/s`;
};

// ==================== Largeur de canal / MCS ====================

/**
 * Parse a channel width coming from /wifi/ap/{id}/stations/ (last_rx/last_tx
 * `width`). Values seen in the wild are strings like "20", "40", "80", "160"
 * ("320" expected for Wi-Fi 7). Returns null when not a plain number.
 */
export const parseChannelWidth = (raw?: string | number | null): number | null => {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(\d+)\s*(mhz)?$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  return value > 0 ? value : null;
};

// ==================== Durée ====================

/** Format a session duration in seconds ("3 j 4 h", "2 h 05 min", "42 s"). */
export const formatDuration = (seconds?: number | null): string => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} j ${hours} h`;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${s} s`;
};
