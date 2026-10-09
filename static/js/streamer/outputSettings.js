// Streamer Mode's recording and output settings, and the input meter's
// arithmetic, kept apart from the page so they can be tested in Node.
//
// RecordingSettings (stored per user in the app's store, sceneStore's
// neighbour; deviceIds are per machine, which is where the store lives):
//   { videoDeviceId, audioDeviceId, audioChannels, resolution, fps,
//     recordMixedAudio, includeClick, autoStopAtEnd }
// A device id of "" is the default device, NONE is "no camera" or "no audio
// input". Nothing here touches the DOM or a device.

export const SETTINGS_KEY = "stemdeck:streamer:recording";
export const NONE = "none";
export const RESOLUTIONS = Object.freeze(["720", "1080", "2160"]);
export const FRAME_RATES = Object.freeze([24, 30, 60]);
const SIZE = { 720: [1280, 720], 1080: [1920, 1080], 2160: [3840, 2160] };

export function defaultRecordingSettings() {
  return {
    videoDeviceId: "",
    audioDeviceId: "",
    // The input's channels ([0] Input 1, [1] Input 2, [0, 1] both), or null:
    // not picked by hand (the first, moving to one with signal).
    audioChannels: null,
    resolution: "1080",
    fps: 30,
    recordMixedAudio: true,
    includeClick: false,
    autoStopAtEnd: true,
  };
}

const idOf = (v) => (typeof v === "string" ? v.slice(0, 512) : "");
const flag = (v, dflt) => (typeof v === "boolean" ? v : dflt);
const channelsOf = (v) => (Array.isArray(v) && v.length >= 1 && v.length <= 2
  && v.every((c) => Number.isInteger(c) && c >= 0 && c < 64) ? [...v] : null);

/** Stored settings made safe: anything missing or wrong takes its default. */
export function parseRecordingSettings(raw) {
  let data = raw;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  const d = defaultRecordingSettings();
  if (!data || typeof data !== "object") return d;
  return {
    videoDeviceId: idOf(data.videoDeviceId),
    audioDeviceId: idOf(data.audioDeviceId),
    audioChannels: channelsOf(data.audioChannels),
    resolution: RESOLUTIONS.includes(String(data.resolution)) ? String(data.resolution) : d.resolution,
    fps: FRAME_RATES.includes(Number(data.fps)) ? Number(data.fps) : d.fps,
    ...fpsFor(data.resolution, data.fps),
    recordMixedAudio: flag(data.recordMixedAudio, d.recordMixedAudio),
    includeClick: flag(data.includeClick, d.includeClick),
    autoStopAtEnd: flag(data.autoStopAtEnd, d.autoStopAtEnd),
  };
}

export function serializeRecordingSettings(s) {
  return { ...parseRecordingSettings(s) };
}

/**
 * The device to use for a saved choice, given the devices present
 * ([{ deviceId }]): NONE stays NONE, a device still present is itself, a
 * device that has gone (or the default) is "" (the default device). With no
 * list yet (no permission: the ids are hidden), the saved one is tried.
 */
export function resolveDeviceId(saved, devices) {
  if (saved === NONE) return NONE;
  if (!saved) return "";
  const ids = (devices || []).map((d) => d?.deviceId).filter(Boolean);
  if (!ids.length) return saved;
  return ids.includes(saved) ? saved : "";
}

/** The frame rates offered at `resolution`: no 60 at 4K (the maintainer's
 * decision; the server refuses it too). */
export function framesFor(resolution) {
  return String(resolution) === "2160" ? FRAME_RATES.filter((n) => n !== 60) : [...FRAME_RATES];
}

/** A stored 4K at 60 fps reads as 4K at 30 (only for that pair: the
 * caller's own resolution and fps are kept otherwise). */
function fpsFor(resolution, fps) {
  return String(resolution) === "2160" && Number(fps) === 60 ? { fps: 30 } : {};
}

/**
 * `patch` applied to `s`, kept to what is offered: 4K with 60 fps falls back
 * to 30. Returns { settings, fellBack } (fellBack: the rate was changed).
 */
export function applySettings(s, patch) {
  const next = parseRecordingSettings({ ...s, ...patch });
  const asked = Number(patch?.fps ?? s?.fps);
  return { settings: next, fellBack: next.resolution === "2160" && asked === 60 && next.fps !== 60 };
}

/** A heavy choice (4K at 30 fps, or 60 fps at 1080p or 720p): allowed, with
 * a warning about the computer's load. */
export function isHeavy(s) {
  return s?.resolution === "2160" || Number(s?.fps) === 60;
}

/** getUserMedia video constraints for the output settings: the size and
 * rate asked for as ideals (a camera that cannot do them gives its nearest). */
export function cameraConstraints(s, deviceId = "") {
  const [width, height] = SIZE[s?.resolution] || SIZE[1080];
  const fps = FRAME_RATES.includes(Number(s?.fps)) ? Number(s.fps) : 30;
  return {
    ...(deviceId && deviceId !== NONE ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: fps },
  };
}

// ── The input meter ──

export const METER_SEGMENTS = 36;
// The same scale as the studio's meters (captureGraph.METER_FLOOR_DB): -60
// dBFS is empty, 0 dBFS full. Kept here as a number because captureGraph.js
// cannot be loaded in Node.
export const METER_FLOOR_DB = -60;
export const METER_HOLD_MS = 300;
export const METER_DECAY_DB_PER_SEC = 24;

/** 0..1 of the meter for a linear peak (0..1+). */
export function meterFraction(peak) {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/** The readout: whole dB from -60 (silence and below) to 0. */
export function levelDb(peak) {
  if (!(peak > 0)) return METER_FLOOR_DB;
  return Math.max(METER_FLOOR_DB, Math.min(0, Math.round(20 * Math.log10(peak))));
}

/** Segment `i` of `n`: green up to 70% of the meter, yellow to 86%, red above. */
export function segmentZone(i, n = METER_SEGMENTS) {
  const top = (i + 1) / n;
  if (top <= 0.7 + 1e-9) return "green";
  if (top <= 0.86 + 1e-9) return "yellow";
  return "red";
}

/** How many segments a 0..1 fraction lights. */
export function litSegments(fraction, n = METER_SEGMENTS) {
  return Math.max(0, Math.min(n, Math.round((Number(fraction) || 0) * n)));
}

/**
 * The shown peak: it rises at once, holds METER_HOLD_MS, then falls at
 * METER_DECAY_DB_PER_SEC. `state` ({ value, heldAt, at }) is updated in place
 * (the meter runs every frame; no allocation) and returned.
 */
export function holdPeak(state, peak, nowMs) {
  const p = peak > 0 ? peak : 0;
  if (p >= state.value) {
    state.value = p;
    state.heldAt = nowMs;
  } else if (nowMs - state.heldAt > METER_HOLD_MS) {
    const dt = Math.max(0, nowMs - Math.max(state.at, state.heldAt + METER_HOLD_MS)) / 1000;
    state.value = Math.max(p, state.value * Math.pow(10, (-METER_DECAY_DB_PER_SEC * dt) / 20));
  }
  state.at = nowMs;
  return state;
}

export function newPeakState() {
  return { value: 0, heldAt: 0, at: 0 };
}
