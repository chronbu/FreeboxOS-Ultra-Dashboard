// Re-export all API types
export * from './api';

import type { WifiBand, WifiGeneration, SignalQuality } from '../utils/wifi';

// UI-specific types
export interface NetworkStat {
  time: string;
  download: number;
  upload: number;
}

export interface Device {
  id: string;
  name: string;
  type: 'phone' | 'laptop' | 'desktop' | 'iot' | 'tv' | 'tablet' | 'car' | 'repeater' | 'other';
  connection: 'ethernet' | 'wifi';
  speedDown: number;
  speedUp: number;
  active: boolean;
  mac?: string;
  ip?: string;
  vendor?: string;
  // Access point the device is attached to (box or repeater), when known
  accessPoint?: DeviceAccessPoint;
  // Wi-Fi link details (only for devices connected over Wi-Fi)
  wifi?: DeviceWifiInfo;
}

export interface DeviceAccessPoint {
  type: 'gateway' | 'repeater';
  uid: string;            // repeater id ("1", "2"...) - box uid for the gateway
  mac?: string;           // MAC of the access point side
}

export interface DeviceWifiInfo {
  band: WifiBand;
  bandRaw?: string;        // raw API value ("5g", "2d4g"...)
  bandLabel: string;       // "5 GHz" (raw value when unknown)
  standard?: string;       // raw API value ("ac", "ax", "be"...)
  standardLabel: string;   // "Wi-Fi 6E" (raw value when unknown)
  generation: WifiGeneration;
  signal?: number;         // dBm
  signalQuality: SignalQuality;
  // PHY rates in Mb/s, from the device point of view:
  // down = AP -> device (phy_tx_rate), up = device -> AP (phy_rx_rate)
  phyDownMbps: number | null;
  phyUpMbps: number | null;
  // Live throughput in Mb/s, from the device point of view (see wifiMapping)
  liveDownMbps: number;
  liveUpMbps: number;
  sessionDuration?: number; // seconds
  ssid?: string;
  bssid?: string;
  // Only available for devices connected to the box (/wifi/ap/{id}/stations/)
  mcs?: number;
  nss?: number;
  channelWidth?: number;   // MHz, negotiated
  channelWidthRaw?: string; // raw width when not a plain number
  apId?: number;           // box radio id (/wifi/ap/{id})
}

export interface WifiNetwork {
  id: string;
  ssid: string;
  band: '2.4GHz' | '5GHz' | '6GHz';
  channelWidth: number;
  channel: number;
  active: boolean;
  connectedDevices: number;
  load: number;
}

export interface VM {
  id: string;
  name: string;
  os: string;
  status: 'running' | 'stopped' | 'starting' | 'stopping';
  vcpus: number;          // Number of virtual CPUs allocated
  cpuUsage: number;       // CPU usage percentage (0-100)
  ramUsage: number;       // RAM usage in GB
  ramTotal: number;       // Total RAM allocated in GB
  diskUsage: number;      // Disk usage in GB
  diskTotal: number;      // Total disk size in GB
}

export interface DownloadTask {
  id: string;
  name: string;
  size: number;
  downloaded: number;
  uploaded: number;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  seeds?: number;
  peers?: number;
  eta: number;
  status: 'downloading' | 'seeding' | 'paused' | 'queued' | 'error' | 'done';
}

export interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'warning' | 'error' | 'success';
  icon?: string;
  data?: Record<string, unknown>;
  rawTimestamp?: number;
}

export interface SpeedTestResult {
  download: number;
  upload: number;
  ping: number;
  jitter: number;
  type: string;
  timestamp: string;
}