// What Streamer records from, and the take lane's live waveform: the pure
// part, testable in Node.
//
// The input is the studio's: Streamer lists the inputs the way a track's
// input picker does (capture/trackInputs.js: a microphone is one input, an
// audio interface each channel and each pair, "Focusrite USB Audio · Input 2")
// and, until the musician picks one, records from the input chosen in
// Settings > Recording (the interface first: trackInputs.defaultInputDevice),
// on its first channel, moving once to another channel of the same device
// that carries a signal while the first is silent, as an armed track does
// (capture/recordUi.js autoPick). The browser's own "default device" (the
// operating system's microphone) is never assumed: it recorded a webcam's
// microphone while the drums came in on the interface.

export const NONE = "none";

// The studio's thresholds (capture/recordUi.js): below -60 dBFS an input is
// silent, above -40 dBFS it carries a source; about a second of frames.
export const AUTO_SILENT = 0.001;
export const AUTO_SIGNAL = 0.01;
export const AUTO_FRAMES = 60;

/** A stored channel list made safe: one or two channel indexes, else null. */
export function cleanChannels(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 2) return null;
  const out = raw.map(Number).filter((c) => Number.isInteger(c) && c >= 0 && c < 64);
  return out.length === raw.length ? out : null;
}

/** The option value trackInputs.fillInputSelect gives a device and channels. */
export function inputValue(deviceId, channels) {
  return `${deviceId}\u0000${(channels || [0]).join(",")}`;
}

/**
 * The input a take records from, given the saved choice
 * ({ audioDeviceId, audioChannels }), the devices (trackInputs'
 * normalised list) and the Settings default device. Null for no input.
 * `auto` is true while the channel was not picked by hand.
 */
export function resolveInput(saved, devices, defaultDevice) {
  const id = saved?.audioDeviceId || "";
  if (id === NONE) return null;
  const list = devices || [];
  const dev = (id && list.find((d) => d.deviceId === id)) || defaultDevice || list[0] || null;
  if (!dev) return id ? { deviceId: id, name: "", channels: [0], kind: "instrument", auto: true, missing: true } : null;
  const max = Math.max(1, dev.channels || 1);
  const picked = cleanChannels(saved?.audioChannels);
  let channels = picked && picked.every((c) => c < max) ? picked : [0];
  if (dev.kind === "voice") channels = [0];
  return {
    deviceId: dev.deviceId,
    name: dev.name || "",
    channels,
    kind: dev.kind,
    auto: !picked || dev.deviceId !== id,
    missing: Boolean(id) && dev.deviceId !== id,
  };
}

/**
 * One frame of the studio's auto-pick: `state` ({ ch, frames }) carried
 * between frames, `level(ch)` the latest peak of a channel. Returns
 * { state, pick } where pick is a channel to move to, or -1.
 */
export function autoPickStep(state, current, level, deviceChannels) {
  if (deviceChannels < 2 || current.length !== 1 || level(current[0]) >= AUTO_SILENT) return { state: null, pick: -1 };
  let best = -1;
  let bestPeak = AUTO_SIGNAL;
  for (let ch = 0; ch < deviceChannels; ch++) {
    if (ch === current[0]) continue;
    const p = level(ch);
    if (p > bestPeak) { best = ch; bestPeak = p; }
  }
  if (best < 0) return { state: null, pick: -1 };
  const frames = state?.ch === best ? state.frames + 1 : 1;
  if (frames < AUTO_FRAMES) return { state: { ch: best, frames }, pick: -1 };
  return { state: null, pick: best };
}

// ── The take lane's live waveform ──
//
// While a take records, the input's peak is kept per stretch of the song
// (`n` buckets over its length): the lane draws the buckets recorded so far,
// so the waveform forms at the playhead. Allocated once per take.

/** A bucket store for a song of `duration` seconds. */
export function createLivePeaks(n = 3000) {
  return { peaks: new Float32Array(Math.max(1, n | 0)), duration: 0, from: -1, to: -1 };
}

/** Empty it for a new take (no allocation). */
export function resetLivePeaks(lp, duration) {
  lp.peaks.fill(0);
  lp.duration = Number(duration) > 0 ? Number(duration) : 0;
  lp.from = -1;
  lp.to = -1;
}

/** The input's `peak` (0..1) heard at song time `t`. Returns the bucket it
 * went into, or -1 (no song, or outside it). */
export function addLivePeak(lp, t, peak) {
  if (!(lp.duration > 0) || !(t >= 0) || t > lp.duration) return -1;
  const n = lp.peaks.length;
  const i = Math.min(n - 1, Math.floor((t / lp.duration) * n));
  const v = Math.max(0, Math.min(1, Number(peak) || 0));
  if (v > lp.peaks[i]) lp.peaks[i] = v;
  if (lp.from < 0 || i < lp.from) lp.from = i;
  if (i > lp.to) lp.to = i;
  return i;
}

/**
 * `out.length` bars for the stretch `from`..`to` (fractions of the song):
 * each the loudest bucket under it, 0 where nothing was recorded. Writes into
 * `out` (a Float32Array the caller keeps) and returns it.
 */
export function fillLiveBars(lp, out, from = 0, to = 1) {
  const n = lp.peaks.length;
  const bars = out.length;
  for (let b = 0; b < bars; b++) {
    const a = Math.floor((from + ((to - from) * b) / bars) * n);
    const z = Math.max(a + 1, Math.floor((from + ((to - from) * (b + 1)) / bars) * n));
    let m = 0;
    for (let i = Math.max(0, a); i < Math.min(n, z); i++) if (lp.peaks[i] > m) m = lp.peaks[i];
    out[b] = m;
  }
  return out;
}

/**
 * What the take lane shows: "empty" (no take for this part yet, or the part
 * changed since), "live" (a take is recording), or "saved" (the last take
 * recorded with this part, from its own audio).
 */
export function takeLaneState({ recording, lastTake, takePart, part }) {
  if (recording) return "live";
  if (lastTake && (takePart ?? "") === (part ?? "")) return "saved";
  return "empty";
}
