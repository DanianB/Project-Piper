import { Router } from "express";
import { registerDevice, listDevices } from "../services/devices.js";

export function deviceRoutes() {
  const r = Router();

  r.post("/device/register", (req, res) => {
    const { deviceId, url, platform } = req.body || {};
    if (!deviceId || !url)
      return res
        .status(400)
        .json({ ok: false, error: "deviceId and url required" });
    const d = registerDevice({ deviceId, url, platform });
    res.json({ ok: true, device: d });
  });

  r.get("/devices", (req, res) =>
    res.json({ ok: true, devices: listDevices() })
  );

  return r;
}
