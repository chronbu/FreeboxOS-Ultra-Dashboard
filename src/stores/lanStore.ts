import { create } from 'zustand';
import { api } from '../api/client';
import { API_ROUTES } from '../utils/constants';
import type { ApStationEntry, FreeboxRepeater, LanHost, RepeatersResponse } from '../types/api';
import type { Device } from '../types';
import { mapLanHostToDevice } from '../utils/wifiMapping';

interface LanState {
  devices: Device[];
  isLoading: boolean;
  error: string | null;

  // Wi-Fi details (per access point view), fetched on demand
  repeaters: FreeboxRepeater[];
  repeatersAvailable: boolean | null;  // null = not fetched yet
  apStations: ApStationEntry[];

  // Actions
  fetchDevices: () => Promise<void>;
  fetchWifiDetails: () => Promise<void>;
  wakeOnLan: (mac: string, interfaceName?: string) => Promise<boolean>;
}

export const useLanStore = create<LanState>((set, get) => ({
  devices: [],
  isLoading: false,
  error: null,
  repeaters: [],
  repeatersAvailable: null,
  apStations: [],

  fetchDevices: async () => {
    // Only show loading on first fetch (when devices array is empty)
    const { devices: existingDevices } = get();
    if (existingDevices.length === 0) {
      set({ isLoading: true });
    }

    try {
      const response = await api.get<LanHost[]>(API_ROUTES.LAN_DEVICES);

      if (response.success && response.result) {
        // Mapping (incl. Wi-Fi details: access point, band, norme, signal, PHY)
        // lives in utils/wifiMapping so it can be unit-tested
        const devices: Device[] = response.result.map(mapLanHostToDevice);

        // Sort: active devices first, then by name
        devices.sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        set({ devices, isLoading: false });
      } else {
        set({ isLoading: false, error: response.error?.message });
      }
    } catch {
      set({ isLoading: false, error: 'Failed to fetch devices' });
    }
  },

  // Repeater names (/repeater/) and box stations (MCS, negotiated width).
  // Both are optional: on failure the view falls back on "Répéteur {uid}"
  // and simply shows no MCS / width.
  fetchWifiDetails: async () => {
    const [repeatersRes, stationsRes] = await Promise.allSettled([
      api.get<RepeatersResponse>(API_ROUTES.WIFI_REPEATERS),
      api.get<ApStationEntry[]>(API_ROUTES.WIFI_AP_STATIONS)
    ]);

    if (repeatersRes.status === 'fulfilled' && repeatersRes.value.success && repeatersRes.value.result) {
      const { available, repeaters } = repeatersRes.value.result;
      set({ repeaters: Array.isArray(repeaters) ? repeaters : [], repeatersAvailable: !!available });
    } else {
      set({ repeatersAvailable: false });
    }

    if (stationsRes.status === 'fulfilled' && stationsRes.value.success && Array.isArray(stationsRes.value.result)) {
      set({ apStations: stationsRes.value.result });
    }
  },

  wakeOnLan: async (mac: string, interfaceName = 'pub') => {
    try {
      const response = await api.post(API_ROUTES.LAN_WOL, {
        interface: interfaceName,
        mac
      });
      return response.success;
    } catch {
      set({ error: 'Wake on LAN failed' });
      return false;
    }
  }
}));