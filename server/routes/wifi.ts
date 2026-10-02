import { Router } from 'express';
import { freeboxApi } from '../services/freeboxApi.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { modelDetection } from '../services/modelDetection.js';
import { buildApStationEntries, countWifiDevicesByAccessPoint } from '../../src/utils/wifiMapping.js';

const router = Router();

// GET /api/wifi/config - Get global WiFi config
router.get('/config', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWifiConfig();
  res.json(result);
}));

// PUT /api/wifi/config - Enable/disable WiFi
router.put('/config', asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  const result = await freeboxApi.setWifiConfig(enabled);
  res.json(result);
}));

// GET /api/wifi/aps - Get all access points
router.get('/aps', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWifiAps();
  res.json(result);
}));

// GET /api/wifi/aps/:id/stations - Get stations for specific AP
router.get('/aps/:id/stations', asyncHandler(async (req, res) => {
  const apId = parseInt(req.params.id, 10);
  const result = await freeboxApi.getWifiApStations(apId);
  res.json(result);
}));

// GET /api/wifi/bss - Get all BSS (SSIDs)
router.get('/bss', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWifiBss();
  res.json(result);
}));

// PUT /api/wifi/bss/:id - Enable/disable a specific BSS
router.put('/bss/:id', asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  console.log(`[WiFi] Toggle BSS ${req.params.id} -> enabled: ${enabled}`);
  const result = await freeboxApi.updateWifiBss(req.params.id, { enabled });
  console.log(`[WiFi] Toggle BSS result:`, result.success ? 'OK' : 'FAILED');
  res.json(result);
}));

// GET /api/wifi/full - Get complete WiFi status (APs + BSS combined)
router.get('/full', asyncHandler(async (_req, res) => {
  // Fetch all WiFi data in parallel, plus LAN devices for WiFi count
  const [config, aps, bss, lanDevices] = await Promise.allSettled([
    freeboxApi.getWifiConfig(),
    freeboxApi.getWifiAps(),
    freeboxApi.getWifiBss(),
    freeboxApi.getLanHosts('pub')  // Main LAN interface
  ]);

  // Extract results, with safe fallbacks
  const configData = config.status === 'fulfilled' && config.value.success ? config.value.result : null;
  const apsData = aps.status === 'fulfilled' && aps.value.success ? aps.value.result : [];
  const bssData = bss.status === 'fulfilled' && bss.value.success ? bss.value.result : [];

  // Count WiFi devices from LAN data, per access point and per band.
  // Devices attached to a repeater must NOT be counted on the box radios
  // (upstream issue #55): `devicesByBand` only counts the box clients.
  const hosts = lanDevices.status === 'fulfilled' && lanDevices.value.success && Array.isArray(lanDevices.value.result)
    ? lanDevices.value.result
    : [];
  const counts = countWifiDevicesByAccessPoint(hosts);
  const devicesByBand: Record<string, number> = {
    '2g4': counts.gateway.byBand['2g4'],
    '5g': counts.gateway.byBand['5g'],
    '6g': counts.gateway.byBand['6g']
  };
  const repeaterDevicesByBand: Record<string, number> = {
    '2g4': counts.repeaterTotal['2g4'],
    '5g': counts.repeaterTotal['5g'],
    '6g': counts.repeaterTotal['6g']
  };

  // Filter out 6GHz data if model doesn't support it
  const supports6ghz = modelDetection.supportsWifi6ghz();
  let filteredAps = apsData || [];
  let filteredBss = bssData || [];
  let wifiDeviceCount = counts.total;
  let gatewayDeviceCount = counts.gateway.total;

  // NOTE: Inactive/disabled WiFi bands (e.g., 5GHz power-saving mode on Ultra)
  // are NOT returned by the Freebox API, so we cannot display them.
  // This is an API limitation, not a dashboard issue.

  if (!supports6ghz && Array.isArray(apsData) && Array.isArray(bssData)) {
    // Filter out 6GHz APs (for Pop v8, Revolution v6)
    filteredAps = apsData.filter(
      (ap: { band?: string }) => !ap.band?.toLowerCase().includes('6g')
    );
    // Filter out 6GHz BSS
    filteredBss = bssData.filter(
      (bss: { band?: string }) => !bss.band?.toLowerCase().includes('6g')
    );
    // Remove 6GHz device count (box only: repeaters have their own radios)
    wifiDeviceCount -= devicesByBand['6g'];
    gatewayDeviceCount -= devicesByBand['6g'];
    devicesByBand['6g'] = 0;
  }

  res.json({
    success: true,
    result: {
      config: configData,
      aps: filteredAps,
      bss: filteredBss,
      // Total WiFi devices (box + repeaters)
      wifiDeviceCount,
      // Box radios only
      gatewayDeviceCount,
      devicesByBand,
      // All repeaters together, then the detail per access point
      repeaterDeviceCount: counts.repeaterTotal.total,
      repeaterDevicesByBand,
      devicesByAccessPoint: [counts.gateway, ...counts.repeaters]
    }
  });
}));

// GET /api/wifi/repeaters - List Free repeaters (name, model, status...)
// Never fails: `available: false` when /repeater/ is not supported or denied,
// so the UI can fall back on "Répéteur {uid}".
router.get('/repeaters', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getRepeaters();
  if (result.success && Array.isArray(result.result)) {
    res.json({ success: true, result: { available: true, repeaters: result.result } });
    return;
  }
  if (result.success) {
    // Success without list (no repeater configured)
    res.json({ success: true, result: { available: true, repeaters: [] } });
    return;
  }
  console.log('[WiFi] /repeater/ unavailable:', result.error_code, result.msg);
  res.json({
    success: true,
    result: { available: false, repeaters: [], error: result.msg || result.error_code || 'unavailable' }
  });
}));

// GET /api/wifi/ap-stations - Stations of every box radio, flattened and tagged
// with the AP they come from (MCS / negotiated channel width for box clients)
router.get('/ap-stations', asyncHandler(async (_req, res) => {
  const aps = await freeboxApi.getWifiAps();
  if (!aps.success || !Array.isArray(aps.result)) {
    res.json({ success: true, result: [] });
    return;
  }
  const apList = aps.result as { id: number; name?: string; config?: { band?: string }; status?: { channel_width?: number } }[];
  const responses = await Promise.allSettled(apList.map((ap) => freeboxApi.getWifiApStations(ap.id)));
  const stationsByAp: Record<string, unknown> = {};
  responses.forEach((response, i) => {
    if (response.status === 'fulfilled' && response.value.success) {
      stationsByAp[String(apList[i].id)] = response.value.result;
    }
  });
  res.json({ success: true, result: buildApStationEntries(apList, stationsByAp) });
}));

// GET /api/wifi/stations - Get all WiFi stations (connected devices)
router.get('/stations', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWifiStations();
  res.json(result);
}));

// GET /api/wifi/mac-filter - Get MAC filtering rules
router.get('/mac-filter', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWifiMacFilter();
  res.json(result);
}));

// GET /api/wifi/planning - Get WiFi scheduling/planning
router.get('/planning', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWifiPlanning();
  res.json(result);
}));

// PUT /api/wifi/planning - Update WiFi scheduling/planning
router.put('/planning', asyncHandler(async (req, res) => {
  const result = await freeboxApi.updateWifiPlanning(req.body);
  res.json(result);
}));

// POST /api/wifi/wps/start - Start WPS session
router.post('/wps/start', asyncHandler(async (_req, res) => {
  // Check if we have settings permission (required for WPS)
  const permissions = freeboxApi.getPermissions();
  console.log('[WiFi WPS] Current permissions:', permissions);

  if (!permissions.settings) {
    console.log('[WiFi WPS] Missing settings permission');
    res.json({
      success: false,
      error: {
        code: 'insufficient_rights',
        message: 'Permission "Modification des réglages de la Freebox" requise. Supprimez freebox_token.json et réenregistrez l\'application en accordant tous les droits sur l\'écran LCD de la Freebox.'
      }
    });
    return;
  }

  const result = await freeboxApi.startWps();
  console.log('[WiFi WPS] Start result:', result);

  // Add helpful error message if WPS fails
  if (!result.success) {
    const errorMsg = result.msg || result.error_code || '';
    let errorResponse: { code: string; message: string };

    if (errorMsg.includes('insuff') || result.error_code === 'insufficient_rights') {
      errorResponse = {
        code: 'insufficient_rights',
        message: 'Permission insuffisante. Supprimez le fichier freebox_token.json et réenregistrez l\'application avec tous les droits.'
      };
    } else if (errorMsg.includes('disabled') || result.error_code === 'wps_disabled') {
      errorResponse = {
        code: 'wps_disabled',
        message: 'WPS est désactivé sur la Freebox. Activez-le dans les paramètres WiFi de Freebox OS.'
      };
    } else {
      errorResponse = {
        code: result.error_code || 'wps_error',
        message: result.msg || 'Erreur lors du démarrage WPS'
      };
    }

    res.json({
      success: false,
      error: errorResponse
    });
    return;
  }

  res.json(result);
}));

// POST /api/wifi/wps/stop - Stop WPS session
router.post('/wps/stop', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.stopWps();
  res.json(result);
}));

// GET /api/wifi/wps/status - Get WPS status
router.get('/wps/status', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWpsStatus();
  res.json(result);
}));

// ==================== WiFi Temporary Disable (v13.0+) ====================

// GET /api/wifi/temp-disable - Get temporary disable status
router.get('/temp-disable', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWifiTempDisableStatus();
  res.json(result);
}));

// POST /api/wifi/temp-disable - Temporarily disable WiFi
router.post('/temp-disable', asyncHandler(async (req, res) => {
  const { duration } = req.body; // Duration in seconds
  const result = await freeboxApi.setWifiTempDisable(duration);
  res.json(result);
}));

// DELETE /api/wifi/temp-disable - Cancel temporary disable
router.delete('/temp-disable', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.cancelWifiTempDisable();
  res.json(result);
}));

// ==================== WiFi Guest Network (v14.0+) ====================

// GET /api/wifi/guest/config - Get guest network config
router.get('/guest/config', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWifiCustomKeyConfig();
  res.json(result);
}));

// PUT /api/wifi/guest/config - Update guest network config
router.put('/guest/config', asyncHandler(async (req, res) => {
  const result = await freeboxApi.updateWifiCustomKeyConfig(req.body);
  res.json(result);
}));

// GET /api/wifi/guest/keys - Get guest network keys
router.get('/guest/keys', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWifiCustomKeys();
  res.json(result);
}));

// POST /api/wifi/guest/keys - Create guest network key
router.post('/guest/keys', asyncHandler(async (req, res) => {
  const result = await freeboxApi.createWifiCustomKey(req.body);
  res.json(result);
}));

// DELETE /api/wifi/guest/keys/:id - Delete guest network key
router.delete('/guest/keys/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = await freeboxApi.deleteWifiCustomKey(id);
  res.json(result);
}));

// ==================== WiFi MLO - Multi Link Operation (v14.0+ WiFi 7) ====================

// GET /api/wifi/mlo/config - Get MLO config
router.get('/mlo/config', asyncHandler(async (_req, res) => {
  const result = await freeboxApi.getWifiMloConfig();
  res.json(result);
}));

// PUT /api/wifi/mlo/config - Update MLO config
router.put('/mlo/config', asyncHandler(async (req, res) => {
  const result = await freeboxApi.updateWifiMloConfig(req.body);
  res.json(result);
}));

export default router;