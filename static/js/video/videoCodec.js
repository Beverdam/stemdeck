// Pure helpers for the camera take: no DOM, no network, so node tests cover
// them directly (tests/js/video-codec.test.mjs).
//
// The server re-encodes whatever arrives at render time, so the recorder never
// depends on one codec. The ladder only decides what is cheapest to record on
// this engine: MP4 H.264 where the engine has it (Safari always, recent
// Chromium), else WebM VP9, else VP8, else whatever the engine picks itself.

export const MIME_LADDER = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

/**
 * First supported type in the ladder, or "" when none is (the recorder is
 * then built with no mimeType and reports its own choice in recorder.mimeType).
 * `isTypeSupported` is injected so tests do not need a browser.
 */
export function pickRecorderMime(isTypeSupported) {
  if (typeof isTypeSupported !== "function") return "";
  for (const type of MIME_LADDER) {
    try {
      if (isTypeSupported(type)) return type;
    } catch (err) {
      console.warn("[video] isTypeSupported threw for", type, err);
    }
  }
  return "";
}

/** File extension for a recorder MIME type; the server keys camera.<ext> on it. */
export function extForMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("video/mp4")) return "mp4";
  if (m.startsWith("video/x-matroska")) return "mkv";
  return "webm";
}

// The upload cap for one part: the non-multipart body limit in app/main.py
// (_JSON_BODY_LIMIT, 4 MiB). A part of exactly the cap is accepted.
export const PART_BYTES = 4 * 1024 * 1024;

// Capture sizes. 720p is the default because the camera encoder shares the
// CPU with the audio engine during the take; 1080p is the ceiling for 0.21.0.
export const QUALITY = {
  "720": { width: 1280, height: 720, bitsPerSecond: 5_000_000 },
  "1080": { width: 1920, height: 1080, bitsPerSecond: 8_000_000 },
};
export const DEFAULT_QUALITY = "720";
export const FRAME_RATE = 30;

/** getUserMedia video constraints for a quality id and an optional device. */
export function cameraConstraints(quality, deviceId) {
  const q = QUALITY[quality] || QUALITY[DEFAULT_QUALITY];
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    width: { ideal: q.width, max: 1920 },
    height: { ideal: q.height, max: 1080 },
    frameRate: { ideal: FRAME_RATE, max: FRAME_RATE },
  };
}

/**
 * Cut whatever is buffered into parts the server accepts.
 *
 * Returns { parts, rest }: every full PART_BYTES slice, plus the remainder.
 * With `final` true the remainder is emitted as a last part too (if non-empty),
 * so Stop flushes everything. Works on anything with size and slice(), which
 * is Blob in the browser and a tiny fake in tests.
 */
export function cutParts(blob, final = false, partBytes = PART_BYTES) {
  const parts = [];
  let offset = 0;
  while (blob.size - offset >= partBytes) {
    parts.push(blob.slice(offset, offset + partBytes));
    offset += partBytes;
  }
  let rest = offset ? blob.slice(offset) : blob;
  if (final && rest.size > 0) {
    parts.push(rest);
    rest = null;
  }
  return { parts, rest };
}

// Sync nudge range. Webcam latency is tens to a few hundred ms; a full second
// either way covers every camera seen so far with room to spare.
export const OFFSET_MIN_MS = -1000;
export const OFFSET_MAX_MS = 1000;

/** Integer milliseconds within the nudge range; anything not finite is 0. */
export function clampOffsetMs(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(OFFSET_MIN_MS, Math.min(OFFSET_MAX_MS, n));
}

function _round(n, digits = 3) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * The "video" block of take.json (validated by app/api on finish).
 *
 * Clock: everything is on performance.now(). The take recorder stamps perfMsAtFrame0 for raw
 * audio frame 0; firstFrameAtMs is how long after that the camera recorder
 * actually started delivering, so positive means video starts later. Camera
 * pipeline latency is invisible to the browser and is what cameraOffsetMs
 * (positive = video late, subtract) corrects.
 */
export function buildVideoBlock({
  mime, ext, width, height, fps, deviceLabel, mirrorPreview,
  perfMsAtFrame0, ctxTimeAtFrame0, startedAtPerf, firstChunkAtPerf,
  parts, cameraOffsetMs = 0,
}) {
  // The server validates every number as finite and bounded, so a value the browser
  // did not report is left out rather than sent as null.
  const block = {
    file: `camera.${ext || extForMime(mime)}`,
    mime: String(mime || "").slice(0, 100),
    fps_nominal: Number.isFinite(fps) && fps >= 1 && fps <= 240 ? _round(fps, 2) : FRAME_RATE,
    deviceLabel: String(deviceLabel || "").slice(0, 200),
    cameraOffsetMs: clampOffsetMs(cameraOffsetMs),
    mirrorPreview: Boolean(mirrorPreview),
    parts: Number.isInteger(parts) && parts >= 0 ? parts : 0,
  };
  if (Number.isFinite(width) && width >= 1) block.w = Math.min(4096, Math.round(width));
  if (Number.isFinite(height) && height >= 1) block.h = Math.min(4096, Math.round(height));
  if (Number.isFinite(ctxTimeAtFrame0)) block.startedAtAudioCtx = _round(ctxTimeAtFrame0, 6);
  if (Number.isFinite(startedAtPerf)) block.startedAtPerf = _round(startedAtPerf);
  const firstAt = Number.isFinite(firstChunkAtPerf) ? firstChunkAtPerf : startedAtPerf;
  if (Number.isFinite(perfMsAtFrame0) && Number.isFinite(firstAt)) {
    block.firstFrameAtMs = Math.max(-600000, Math.min(600000, _round(firstAt - perfMsAtFrame0)));
  }
  return block;
}

/** Does a registry take entry carry a camera recording? */
export function takeHasVideo(take) {
  if (!take || typeof take !== "object") return false;
  return take.has_camera === true;
}
