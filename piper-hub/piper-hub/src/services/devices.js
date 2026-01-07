const devices = new Map();

export function registerDevice({ deviceId, url, platform }) {
  const d = {
    deviceId: String(deviceId),
    url: String(url),
    platform: String(platform || ""),
    lastSeen: Date.now(),
  };
  devices.set(d.deviceId, d);
  return d;
}

export function listDevices() {
  return Array.from(devices.values()).map((d) => ({
    ...d,
    lastSeenIso: new Date(d.lastSeen).toISOString(),
  }));
}

export function getDevice(deviceId) {
  return devices.get(deviceId) || null;
}
