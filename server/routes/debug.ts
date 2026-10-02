import { Router } from 'express';
import { freeboxApi } from '../services/freeboxApi.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { config } from '../config.js';

// Debug endpoints, used to capture raw Freebox payloads (e.g. the exact
// `standard` / `band` values reported for Wi-Fi 7 or 6 GHz clients).
// DISABLED by default: set ENABLE_DEBUG_ENDPOINTS=true to enable them.
// The output contains MAC addresses, hostnames and SSIDs of the local network.

export const isDebugEnabled = (): boolean =>
  (process.env.ENABLE_DEBUG_ENDPOINTS || '').toLowerCase() === 'true';

const router = Router();

// Every debug route answers 404 unless explicitly enabled
router.use((_req, res, next) => {
  if (!isDebugEnabled()) {
    res.status(404).json({
      success: false,
      error: {
        code: 'DEBUG_DISABLED',
        message: 'Debug endpoints are disabled. Set ENABLE_DEBUG_ENDPOINTS=true to enable them.'
      }
    });
    return;
  }
  next();
});

type RawCall = { success: boolean; result?: unknown; error_code?: string; msg?: string };

// Keep the raw Freebox response, or the error if the call threw
const capture = async (call: () => Promise<RawCall>): Promise<RawCall> => {
  try {
    return await call();
  } catch (error) {
    return { success: false, error_code: 'exception', msg: error instanceof Error ? error.message : String(error) };
  }
};

// GET /api/debug/lan-raw - Raw JSON of /lan/browser/pub/, /wifi/ap/,
// /wifi/ap/{id}/stations/, /wifi/bss/ and /repeater/ (+ /repeater/{id}/host/)
router.get('/lan-raw', asyncHandler(async (_req, res) => {
  const [lanPub, wifiAp, wifiBss, repeaters] = await Promise.all([
    capture(() => freeboxApi.getLanHosts('pub')),
    capture(() => freeboxApi.getWifiAps()),
    capture(() => freeboxApi.getWifiBss()),
    capture(() => freeboxApi.getRepeaters())
  ]);

  const apIds = wifiAp.success && Array.isArray(wifiAp.result)
    ? (wifiAp.result as { id: number }[]).map((ap) => ap.id)
    : [];
  const stations: Record<string, RawCall> = {};
  await Promise.all(apIds.map(async (id) => {
    stations[String(id)] = await capture(() => freeboxApi.getWifiApStations(id));
  }));

  const repeaterIds = repeaters.success && Array.isArray(repeaters.result)
    ? (repeaters.result as { id: number }[]).map((r) => r.id)
    : [];
  const repeaterHosts: Record<string, RawCall> = {};
  await Promise.all(repeaterIds.map(async (id) => {
    repeaterHosts[String(id)] = await capture(() => freeboxApi.getRepeaterHosts(id));
  }));

  res.json({
    success: true,
    result: {
      capturedAt: new Date().toISOString(),
      apiVersion: config.freebox.apiVersion,
      lanBrowserPub: lanPub,
      wifiAp,
      wifiApStations: stations,
      wifiBss,
      repeater: repeaters,
      repeaterHosts
    }
  });
}));

export default router;
