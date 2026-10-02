// Unit tests for the Wi-Fi helpers and the LAN host mapping, run against
// JSON fixtures that mimic a Freebox Ultra with two Wi-Fi 7 repeaters.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatSessionDuration,
  formatMbps,
  getBandLabel,
  getSignalQuality,
  getStandardLabel,
  normalizeBand,
  parseChannelWidth,
  phyRateToMbps
} from '../src/utils/wifi';
import {
  buildApStationEntries,
  countWifiDevicesByAccessPoint,
  enrichDevicesWithStations,
  filterWifiDevices,
  getRepeaterLabel,
  getRepeaterMacs,
  groupWifiDevicesByAccessPoint,
  mapLanHostToDevice,
  sortWifiDevices
} from '../src/utils/wifiMapping';
import type { Device, FreeboxRepeater, LanHost } from '../src/types';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const loadFixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8')) as T;

const hosts = loadFixture<{ result: LanHost[] }>('lan-browser-pub.json').result;
const aps = loadFixture<{ result: { id: number; name?: string; config?: { band?: string }; status?: { channel_width?: number } }[] }>('wifi-ap.json').result;
const stationsFixture = loadFixture<Record<string, { result: unknown }>>('wifi-ap-stations.json');
const repeaters = loadFixture<{ result: FreeboxRepeater[] }>('repeater.json').result;

const stationEntries = buildApStationEntries(
  aps,
  Object.fromEntries(Object.entries(stationsFixture).map(([id, res]) => [id, res.result]))
);
const devices = hosts.map(mapLanHostToDevice);
const byName = (list: Device[], name: string): Device => {
  const device = list.find((d) => d.name === name);
  assert.ok(device, `device "${name}" not found`);
  return device;
};

// ==================== Normes / bandes ====================

test('standard labels follow the Wi-Fi Alliance naming', () => {
  assert.equal(getStandardLabel('n', '2d4g'), 'Wi-Fi 4');
  assert.equal(getStandardLabel('ac', '5g'), 'Wi-Fi 5');
  assert.equal(getStandardLabel('ax', '5g'), 'Wi-Fi 6');
  assert.equal(getStandardLabel('ax', '2g4'), 'Wi-Fi 6');
  assert.equal(getStandardLabel('ax', '6g'), 'Wi-Fi 6E');
  assert.equal(getStandardLabel('be', '6g'), 'Wi-Fi 7');
  assert.equal(getStandardLabel('be', '5g'), 'Wi-Fi 7');
  for (const legacy of ['a', 'b', 'g']) assert.equal(getStandardLabel(legacy, '5g'), 'Legacy');
  assert.equal(getStandardLabel('AX', '6G'), 'Wi-Fi 6E');
  assert.equal(getStandardLabel('802.11be', '6g'), 'Wi-Fi 7');
});

test('unknown standards and bands are displayed as-is', () => {
  assert.equal(getStandardLabel('bn', '5g'), 'bn');
  assert.equal(getStandardLabel(undefined, '5g'), '—');
  assert.equal(getStandardLabel('', undefined), '—');
  assert.equal(getBandLabel('60g'), '60g');
  assert.equal(getBandLabel(undefined), '—');
  assert.equal(normalizeBand('60g'), 'unknown');
});

test('band values are normalized', () => {
  assert.equal(getBandLabel('2d4g'), '2,4 GHz');
  assert.equal(getBandLabel('2g4'), '2,4 GHz');
  assert.equal(getBandLabel('2G4'), '2,4 GHz');
  assert.equal(getBandLabel('2.4g'), '2,4 GHz');
  assert.equal(getBandLabel('5g'), '5 GHz');
  assert.equal(getBandLabel('6g'), '6 GHz');
});

// ==================== Signal / débits ====================

test('signal quality thresholds', () => {
  assert.equal(getSignalQuality(-45), 'excellent');
  assert.equal(getSignalQuality(-55), 'excellent');
  assert.equal(getSignalQuality(-59), 'good');
  assert.equal(getSignalQuality(-67), 'good');
  assert.equal(getSignalQuality(-71), 'fair');
  assert.equal(getSignalQuality(-80), 'weak');
  assert.equal(getSignalQuality(undefined), 'unknown');
  assert.equal(getSignalQuality(0), 'unknown');
});

test('PHY rates are converted from 100 kb/s units', () => {
  assert.equal(phyRateToMbps(5851), 585.1);
  assert.equal(phyRateToMbps(7800), 780);
  assert.equal(phyRateToMbps(12009), 1200.9);
  // Real capture (iPhone on a Wi-Fi 7 repeater, 160 MHz 2x2 MCS9 / MCS10)
  assert.equal(phyRateToMbps(19215), 1921.5);
  assert.equal(phyRateToMbps(21613), 2161.3);
  assert.equal(formatMbps(2161.3), '2,16 Gb/s');
  assert.equal(phyRateToMbps(0), null);
  assert.equal(phyRateToMbps(undefined), null);
  assert.equal(formatMbps(585.1), '585 Mb/s');
  assert.equal(formatMbps(null), '—');
});

test('channel width and duration helpers', () => {
  assert.equal(parseChannelWidth('160'), 160);
  assert.equal(parseChannelWidth(320), 320);
  assert.equal(parseChannelWidth('80+80'), null);
  assert.equal(parseChannelWidth(undefined), null);
  assert.equal(formatSessionDuration(1814247), '20 j 23 h');
  assert.equal(formatSessionDuration(7200), '2 h 00 min');
  assert.equal(formatSessionDuration(42), '42 s');
  assert.equal(formatSessionDuration(undefined), '—');
});

// ==================== Host mapping ====================

test('repeater client from the real capture is mapped', () => {
  const galaxy = byName(devices, 'Galaxy S23');
  assert.deepEqual(galaxy.accessPoint, { type: 'repeater', uid: '1', mac: 'F4:CA:E7:11:11:15' });
  assert.ok(galaxy.wifi);
  assert.equal(galaxy.wifi.band, '5GHz');
  assert.equal(galaxy.wifi.standard, 'ac');
  assert.equal(galaxy.wifi.standardLabel, 'Wi-Fi 5');
  assert.equal(galaxy.wifi.signal, -59);
  assert.equal(galaxy.wifi.signalQuality, 'good');
  // AP point of view: phy_tx_rate (AP -> device) is the device download
  assert.equal(galaxy.wifi.phyDownMbps, 780);
  assert.equal(galaxy.wifi.phyUpMbps, 585.1);
  assert.equal(galaxy.wifi.sessionDuration, 1814247);
  assert.equal(galaxy.wifi.ssid, 'Freebox-Maison');
  assert.equal(galaxy.wifi.channelWidth, undefined);
});

test('box clients get Wi-Fi 6E / Wi-Fi 7 labels', () => {
  assert.equal(byName(devices, 'Pixel Tablet').wifi?.standardLabel, 'Wi-Fi 6E');
  assert.equal(byName(devices, 'MacBook Pro').wifi?.standardLabel, 'Wi-Fi 7');
  assert.equal(byName(devices, 'MacBook Pro').accessPoint?.type, 'gateway');
  assert.equal(byName(devices, 'Vieux portable').wifi?.standardLabel, 'Legacy');
});

test('device with missing fields does not crash', () => {
  const device = byName(devices, 'Espressif Inc.');
  assert.equal(device.connection, 'wifi');
  assert.equal(device.ip, undefined);
  assert.equal(device.speedDown, 0);
  assert.deepEqual(device.accessPoint, { type: 'repeater', uid: '2', mac: undefined });
  assert.ok(device.wifi);
  assert.equal(device.wifi.bandLabel, '2,4 GHz');
  assert.equal(device.wifi.standardLabel, '—');
  assert.equal(device.wifi.generation, 'unknown');
  assert.equal(device.wifi.signal, undefined);
  assert.equal(device.wifi.signalQuality, 'unknown');
  assert.equal(device.wifi.phyDownMbps, null);
  assert.equal(device.wifi.sessionDuration, undefined);

  // A host without access_point at all
  const bare = mapLanHostToDevice({ id: 'x', l2ident: { id: 'AA', type: 'mac_address' } } as LanHost);
  assert.equal(bare.connection, 'ethernet');
  assert.equal(bare.wifi, undefined);
  assert.equal(bare.accessPoint, undefined);
  assert.equal(bare.name, 'Unknown Device');
});

test('device with unknown values keeps raw labels', () => {
  const device = byName(devices, 'Appareil du futur');
  assert.equal(device.wifi?.bandLabel, '60g');
  assert.equal(device.wifi?.band, 'unknown');
  assert.equal(device.wifi?.standardLabel, 'bn');
  assert.equal(device.wifi?.phyDownMbps, null);
});

test('live rates are expressed from the device point of view', () => {
  // tx_rate = sent by the access point = device download
  const iphone = byName(devices, 'iPhone de Camille');
  assert.equal(iphone.speedDown, 20);
  assert.equal(iphone.speedUp, 0);
  assert.equal(iphone.wifi?.liveDownMbps, 20);
  const nas = byName(devices, 'NAS');
  assert.equal(nas.speedDown, 2);
  assert.equal(nas.speedUp, 1);
});

test('wired and offline hosts', () => {
  const nas = byName(devices, 'NAS');
  assert.equal(nas.connection, 'ethernet');
  assert.equal(nas.wifi, undefined);
  const offline = byName(devices, 'Ancien téléphone');
  assert.equal(offline.active, false);
  assert.equal(offline.wifi?.liveDownMbps, 0);
});

// ==================== Stations enrichment ====================

test('box clients are enriched with /wifi/ap/{id}/stations/', () => {
  assert.equal(stationEntries.length, 5);
  const enriched = enrichDevicesWithStations(devices, stationEntries);

  const iphone = byName(enriched, 'iPhone de Camille'); // lower-case MAC in stations
  assert.equal(iphone.wifi?.mcs, 11);
  assert.equal(iphone.wifi?.nss, 2);
  assert.equal(iphone.wifi?.channelWidth, 80);
  assert.equal(iphone.wifi?.apId, 1);

  const macbook = byName(enriched, 'MacBook Pro');
  assert.equal(macbook.wifi?.mcs, 13);
  assert.equal(macbook.wifi?.channelWidth, 160);

  // Empty last_tx: falls back on last_rx, ignores vht_mcs = -1
  const pixel = byName(enriched, 'Pixel Tablet');
  assert.equal(pixel.wifi?.mcs, 11);
  assert.equal(pixel.wifi?.channelWidth, 160);

  const printer = byName(enriched, 'Imprimante HP');
  assert.equal(printer.wifi?.mcs, 7);
  assert.equal(printer.wifi?.channelWidth, 20);

  // Non numeric width is kept raw
  const repeaterBackhaul = byName(enriched, 'Répéteur Wi-Fi Free');
  assert.equal(repeaterBackhaul.wifi?.channelWidth, undefined);
  assert.equal(repeaterBackhaul.wifi?.channelWidthRaw, '80+80');

  // Repeater clients never get a width
  assert.equal(byName(enriched, 'Galaxy S23').wifi?.channelWidth, undefined);
  assert.equal(byName(enriched, 'Galaxy S23').wifi?.mcs, undefined);
});

// ==================== Grouping ====================

test('devices are grouped by access point with repeater names', () => {
  const groups = groupWifiDevicesByAccessPoint(devices, repeaters);
  assert.deepEqual(groups.map((g) => g.name), ['Freebox', 'Répéteur Salon', 'Répéteur Étage']);
  assert.deepEqual(groups.map((g) => g.devices.length), [6, 2, 4]);
  assert.equal(groups[1].repeater?.model, 'fbxwmr');
  // Offline and wired devices are excluded
  const all = groups.flatMap((g) => g.devices.map((d) => d.name));
  assert.ok(!all.includes('NAS'));
  assert.ok(!all.includes('Ancien téléphone'));
  // The repeater itself is a client of the box
  assert.ok(getRepeaterMacs(repeaters).has('f4:ca:e7:11:11:11'));
});

test('repeater names fall back to "Répéteur {uid}" without /repeater/', () => {
  const groups = groupWifiDevicesByAccessPoint(devices, []);
  assert.deepEqual(groups.map((g) => g.name), ['Freebox', 'Répéteur 1', 'Répéteur 2']);
  assert.equal(getRepeaterLabel('2', []), 'Répéteur 2');
  assert.equal(getRepeaterLabel('1', repeaters), 'Répéteur Salon');
});

test('repeaters without clients are still listed', () => {
  const groups = groupWifiDevicesByAccessPoint(devices.filter((d) => d.accessPoint?.type !== 'repeater'), repeaters);
  assert.deepEqual(groups.map((g) => g.devices.length), [6, 0, 0]);
});

// ==================== Sort / filter ====================

test('sort by signal, name and standard', () => {
  const box = groupWifiDevicesByAccessPoint(devices, repeaters)[0].devices;
  assert.deepEqual(sortWifiDevices(box, 'signal').map((d) => d.wifi?.signal), [-40, -45, -48, -52, -63, -71]);
  assert.equal(sortWifiDevices(box, 'name')[0].name, 'Appareil du futur');
  assert.deepEqual(
    sortWifiDevices(box, 'standard').map((d) => d.wifi?.standardLabel),
    ['Wi-Fi 7', 'Wi-Fi 7', 'Wi-Fi 6E', 'Wi-Fi 6', 'Wi-Fi 4', 'bn']
  );
});

test('filter by band and generation', () => {
  const wifiDevices = devices.filter((d) => d.active && d.wifi);
  assert.deepEqual(filterWifiDevices(wifiDevices, { band: '6GHz' }).map((d) => d.name).sort(), ['MacBook Pro', 'PS5', 'Pixel Tablet']);
  assert.deepEqual(filterWifiDevices(wifiDevices, { generation: 'wifi7' }).length, 3);
  assert.equal(filterWifiDevices(wifiDevices, { band: 'all', generation: 'all' }).length, wifiDevices.length);
  assert.deepEqual(filterWifiDevices(wifiDevices, { band: '2.4GHz', generation: 'wifi4' }).map((d) => d.name).sort(), ['Imprimante HP', 'Prise connectée']);
});

// ==================== Counting (/api/wifi/full) ====================

test('band counting separates box and repeaters', () => {
  const counts = countWifiDevicesByAccessPoint(hosts);
  assert.equal(counts.total, 12);
  assert.equal(counts.gateway.total, 6);
  assert.deepEqual(counts.gateway.byBand, { '2g4': 1, '5g': 2, '6g': 2, other: 1 });
  assert.deepEqual(counts.repeaterTotal, { '2g4': 3, '5g': 2, '6g': 1, other: 0, total: 6 });
  assert.deepEqual(counts.repeaters.map((r) => [r.uid, r.total]), [['1', 2], ['2', 4]]);
  assert.deepEqual(counts.repeaters[1].byBand, { '2g4': 2, '5g': 1, '6g': 1, other: 0 });
});
