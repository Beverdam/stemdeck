// Streamer Mode's export: the server renders the take (the scene as the
// picture, the stems as heard plus the microphone, the trim, the size and
// rate) to MP4 with H.264 and AAC, and the file is saved through the app's
// own download path (player.triggerDownload: the desktop save dialog, or a
// browser download).
//
// The render is the take render (app/api/takes.py); its progress and cancel
// are videoRender.js's. When the server's ffmpeg cannot make MP4 (no
// libx264), the raw recording is offered instead: the take's picture as the
// browser recorded it, untrimmed.

import { currentMixLanes, triggerDownload } from "../player.js";
import { exportFxParam } from "../eqEngine.js";
import { exportMasterParam } from "../masterEngine.js";
import { waitForRender, cancelRender, renderDownloadUrl } from "../video/videoRender.js";
import { buildRenderRequest, isNoEncoder } from "./recordModel.js";

const base = (jobId, takeId) => `/api/jobs/${encodeURIComponent(jobId)}/takes/${encodeURIComponent(takeId)}`;

async function detailOf(res) {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
  } catch { /* not JSON */ }
  return `HTTP ${res.status}`;
}

/** The render request for this take (recordModel.buildRenderRequest). */
export function renderRequest({ trackId, settings, aspect, range }) {
  const mix = currentMixLanes();
  const names = (mix.names || []).filter((n) => n !== trackId);
  return buildRenderRequest({
    mix,
    exclude: trackId ? [trackId] : [],
    mixedAudio: settings.recordMixedAudio,
    includeClick: settings.includeClick,
    aspect,
    resolution: settings.resolution,
    fps: settings.fps,
    range,
    fx: settings.recordMixedAudio ? exportFxParam(trackId ? [...names, trackId] : names) : "",
    master: exportMasterParam(),
  });
}

/**
 * Render and save. Resolves { saved: true|false } (false: the save dialog
 * was cancelled). Rejects with an Error whose `code` is "no-encoder" (offer
 * the raw recording), "cancelled", or "failed".
 * `onProgress(fraction)`, `onTransferStart()` as triggerDownload's.
 */
export async function exportTake({ jobId, takeId, body, filename, onProgress, onTransferStart, signal }) {
  const res = await fetch(`${base(jobId, takeId)}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await detailOf(res);
    const err = new Error(detail);
    err.code = isNoEncoder(res.status, detail) ? "no-encoder" : "failed";
    throw err;
  }
  let status;
  try {
    status = await waitForRender(jobId, takeId, { onProgress, signal });
  } catch (err) {
    const e = new Error(err?.message || "render failed");
    e.code = signal?.aborted || err?.name === "AbortError" || err?.message === "none" ? "cancelled" : "failed";
    throw e;
  }
  // The name rides along for a browser download (the server's
  // Content-Disposition wins over <a download>); the desktop's save dialog
  // already proposes it.
  const url = `${renderDownloadUrl(jobId, takeId, status)}?name=${encodeURIComponent(filename)}`;
  const saved = await triggerDownload(url, filename, onTransferStart);
  return { saved: saved !== false };
}

/** Stop a render that is queued or running. */
export function cancelExport(jobId, takeId) {
  return cancelRender(jobId, takeId).catch((err) => console.warn("[streamer] cancel failed:", err));
}

/** Save the raw recording (the take's picture as recorded) when no MP4 can be made. */
export function saveRawRecording(jobId, takeId, filename, onTransferStart) {
  return triggerDownload(`${base(jobId, takeId)}/camera`, filename, onTransferStart);
}

/** Desktop only: show the file just saved in the file manager. */
export function canRevealSaved() {
  return Boolean(window.__TAURI__?.core?.invoke);
}

export function revealSaved() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return Promise.resolve(false);
  return invoke("reveal_last_export").then(() => true);
}
