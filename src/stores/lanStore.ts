import { create } from 'zustand';
import { api } from '../api/client';
import { API_ROUTES } from '../utils/constants';
import type { LanHost } from '../types/api';
import type { Device } from '../types';
import { mapLanHostToDevice } from '../utils/wifiMapping';

interface LanState {
  devices: Device[];
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchDevices: () => Promise<void>;
  wakeOnLan: (mac: string, interfaceName?: string) => Promise<boolean>;
}

export const useLanStore = create<LanState>((set, get) => ({
  devices: [],
  isLoading: false,
  error: null,

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