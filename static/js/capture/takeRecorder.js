// One take, from Record to keep or discard (05 section 5.8).
//
//   1. The recorder worklet starts before the transport does, so a count-in
//      and any pickup notes are in the take. Frame 0 is stamped with its
//      context frame.
//   2. POST /takes runs alongside; audio parts queue until the id is back.
//   3. The transport starts through the caller's normal play path, count-in
//      included. Recording does not touch the count-in code.
//   4. The first time the engine's clock is ready, its output mapping is read
//      once and its schedule epoch kept. A seek, loop jump, pause, rate change
//      or the end of the song bumps the epoch, and the take stops there.
//   5. Stop: the worklet flushes, video participants finish their uploads,
//      the last audio part is acknowledged, then /finish renders audio.wav.
//   6. The user listens, then keeps it or discards it (DELETE).
//
// Other recorders (the camera) join through registerTakeParticipant and
// onTakeEvent; they never import anything else from here.

import {
  createTake, deleteTake, finishTake, AudioPartQueue,
} from "./takeUpload.js";
import { firstSampleSongSec, endSongSec, interleave, perfMsAtCtx } from "./takeMath.js";

const listeners = new Set();
const audioListeners = new Set();
const participants = new Set();
export const PARTICIPANT_TIMEOUT_MS = 60_000;

/**
 * Events: {type:"armed", jobId, takeId, trackId, primary, ctxTimeAtFrame0, perfMsAtFrame0, sampleRate}
 *           (primary: the first armed track's take, the one the camera films)
 *         {type:"stopping", jobId, takeId}
 *         {type:"finished", jobId, takeId, take}     (kept)
 *         {type:"discarded", jobId, takeId}
 *         {type:"failed", jobId, takeId, reason}
 * Every event also carries the take's trackId.
 * Returns an unsubscribe function.
 */
export function onTakeEvent(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * The recorder's own batches as they arrive, for drawing (liveWave.js). No
 * second capture path: these are the arrays that are uploaded, so a listener
 * must only read them.
 *   {trackId, takeId, frame, channels, sampleRate, mapping, roundTripSec}
 * `frame` is the context frame of channels[k][0]; `mapping` is the engine's
 * output mapping, null until the transport's clock is ready (the count-in).
 * Returns an unsubscribe function.
 */
export function onTakeAudio(cb) {
  audioListeners.add(cb);
  return () => audioListeners.delete(cb);
}

/**
 * `fn(takeId)` runs after "stopping" and before /finish. It resolves the
 * sidecar's "video" block, or null when it has nothing for this take. Its
 * uploads must be acknowledged by then. Waited for up to 60 s; after that the
 * take finishes without it. Returns an unregister function.
 */
export function registerTakeParticipant(fn) {
  participants.add(fn);
  return () => participants.delete(fn);
}

function emit(ev) {
  for (const cb of [...listeners]) {
    try { cb(ev); } catch (e) { console.warn("[takes] take event listener failed:", e); }
  }
}

async function collectParticipants(takeId) {
  const fns = [...participants];
  if (!fns.length) return null;
  const timeout = new Promise((r) => setTimeout(() => r("timeout"), PARTICIPANT_TIMEOUT_MS));
  const results = await Promise.all(fns.map((fn) => Promise.race([
    Promise.resolve().then(() => fn(takeId)).catch((e) => {
      console.warn("[takes] a take participant failed:", e);
      return null;
    }),
    timeout,
  ])));
  if (results.includes("timeout")) console.warn("[takes] a take participant timed out; finishing without it");
  return results.find((r) => r && typeof r === "object") || null;
}

const finiteOrUndef = (v) => (Number.isFinite(v) ? v : undefined);
const round = (v, d = 6) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : undefined);

/** Build the take.json sidecar the backend validates (05 section 5.6). */
export function buildSidecar({
  label, mapping, ctxTimeAtFrame0, perfMsAtFrame0, frames, capture, dropped, video,
}) {
  const rt = capture.roundTripSeconds;
  const first = firstSampleSongSec(ctxTimeAtFrame0, mapping, rt);
  const countIn = mapping.startCtxTime - ctxTimeAtFrame0;
  const sidecar = {
    v: 1,
    ...(label ? { label } : {}),
    timeline: {
      first_sample_song_sec: round(first),
      start_song_sec: round(mapping.startOffset),
      end_song_sec: round(endSongSec(first, frames, capture.sampleRate, 1)),
      // The backend accepts 1.0 only in the MVP; Record refuses other tempos.
      tempo: 1,
      count_in_sec: round(Math.max(0, countIn)),
      ctx_time_at_frame0: round(ctxTimeAtFrame0),
      perf_ms_at_frame0: round(finiteOrUndef(perfMsAtFrame0), 3),
    },
    latency: {
      round_trip_ms: round(rt * 1000, 2),
      source: capture.calibrated ? "calibrated" : "estimated",
      output_latency_ms: round(finiteOrUndef(capture.estimate?.outputLatencyMs), 2),
      base_latency_ms: round(finiteOrUndef(capture.estimate?.baseLatencyMs), 2),
      input_latency_ms_reported: round(finiteOrUndef(capture.estimate?.inputLatencyMs), 2),
      pipeline_latency_ms: round((mapping.pipelineLatencySeconds || 0) * 1000, 2),
      user_nudge_ms: 0,
      drift_ppm: capture.calibration?.driftPpm ?? 0,
    },
    capture: {
      rate: capture.sampleRate,
      channels: capture.channels,
      device_label: (capture.deviceLabel || "").slice(0, 200),
      dropped_quanta: dropped | 0,
    },
  };
  if (video) sidecar.video = video;
  // JSON drops undefined, so optional numbers the browser could not report
  // are simply absent rather than null.
  return JSON.parse(JSON.stringify(sidecar));
}

/**
 * Start recording a take. `startPlayback()` runs the transport's own play
 * path (count-in included); `stopPlayback()` stops it. `onAutoStop(reason)`
 * is told when the transport ended the take on its own.
 *
 * Returns a session: { state, takeId, stop(), keep(), discard(), ... }.
 * States: starting, recording, stopping, review, kept, discarded, failed.
 */
export function startTake({
  engine, capture, jobId, label, trackId, recorder, primary = true,
  startPlayback, stopPlayback, onAutoStop,
}) {
  const ctx = capture.ctx;
  // One recorder per track: a channel or a pair of the shared device stream.
  const rec = recorder || capture.recorder;
  const channels = rec.channels || capture.channels;
  const queue = new AudioPartQueue({ channels });
  const session = {
    state: "starting",
    jobId,
    takeId: null,
    entry: null,
    frames: 0,
    dropped: 0,
    mapping: null,
    ctxTimeAtFrame0: null,
    perfMsAtFrame0: null,
    error: null,
    stop,
    keep,
    discard,
  };
  let epoch = null;
  let armedSent = false;

  const maybeArmed = () => {
    if (armedSent || !session.takeId || session.ctxTimeAtFrame0 == null) return;
    armedSent = true;
    emit({
      type: "armed",
      jobId,
      takeId: session.takeId,
      ctxTimeAtFrame0: session.ctxTimeAtFrame0,
      perfMsAtFrame0: session.perfMsAtFrame0,
      sampleRate: capture.sampleRate,
      trackId,
      // With several tracks armed, only the first one's take is filmed.
      primary,
    });
  };

  const watchClock = () => {
    if (session.state !== "recording") return;
    if (!session.mapping) {
      if (engine.isClockReady?.() && engine.getOutputMapping) {
        session.mapping = engine.getOutputMapping();
        epoch = session.mapping.epoch;
      }
      return;
    }
    if (engine.getScheduleEpoch?.() !== epoch) {
      onAutoStop?.("transport");
      stop({ fromTransport: true });
    }
  };

  const onBatch = (m) => {
    const n = m.channels[0]?.length || 0;
    queue.push(interleave(m.channels, n));
    session.frames += n;
    watchClock();
    if (!audioListeners.size) return;
    const ev = {
      trackId,
      takeId: session.takeId,
      frame: m.frame,
      channels: m.channels,
      sampleRate: capture.sampleRate,
      mapping: session.mapping,
      roundTripSec: capture.roundTripSeconds || 0,
    };
    for (const cb of audioListeners) {
      try { cb(ev); } catch (e) { console.warn("[takes] take audio listener failed:", e); }
    }
  };

  const createP = createTake(jobId, label, trackId).then((res) => {
    session.takeId = res.take_id;
    queue.setTake(jobId, res.take_id);
    maybeArmed();
    return res;
  });

  const startP = rec.start(onBatch).then(({ frame }) => {
    if (session.state === "failed") return;
    session.ctxTimeAtFrame0 = frame / capture.sampleRate;
    const ts = ctx.getOutputTimestamp?.();
    session.perfMsAtFrame0 = perfMsAtCtx(session.ctxTimeAtFrame0, ts);
    session.state = "recording";
    maybeArmed();
    // The transport starts only once frame 0 exists, so the take always
    // begins before the song (and before any count-in click).
    startPlayback();
  });

  session.ready = Promise.all([createP, startP]).catch(async (e) => {
    session.error = e;
    await fail("create", e);
  });

  async function fail(reason, err) {
    if (session.state === "failed") return;
    console.warn(`[takes] take failed (${reason}):`, err);
    const wasRecording = session.state === "recording" || session.state === "starting";
    session.state = "failed";
    queue.dispose();
    if (wasRecording) {
      try { await rec.stop(); } catch (e) { console.warn(e); }
      stopPlayback?.();
    }
    if (session.takeId) {
      deleteTake(jobId, session.takeId).catch((e) => console.warn("[takes] cleanup delete failed:", e));
    }
    emit({ type: "failed", jobId, takeId: session.takeId, trackId, reason });
  }

  async function stop({ fromTransport = false } = {}) {
    if (session.state !== "recording" && session.state !== "starting") return session;
    await startP.catch(() => {});
    if (session.state === "failed") return session;
    session.state = "stopping";
    emit({ type: "stopping", jobId, takeId: session.takeId, trackId });
    const res = await rec.stop();
    session.dropped = res?.dropped || 0;
    if (!fromTransport) stopPlayback?.();
    try {
      await createP;
    } catch (e) {
      await fail("create", e);
      return session;
    }
    if (!session.mapping) {
      // Stopped before the song began (inside the count-in, or the engine
      // never started): there is nothing to place against the song.
      await fail("too-short");
      return session;
    }
    const video = await collectParticipants(session.takeId);
    try {
      await queue.drain();
    } catch (e) {
      await fail("upload", e);
      return session;
    }
    const sidecar = buildSidecar({
      label,
      mapping: session.mapping,
      ctxTimeAtFrame0: session.ctxTimeAtFrame0,
      perfMsAtFrame0: session.perfMsAtFrame0,
      frames: session.frames,
      capture: { ...capture, channels },
      dropped: session.dropped,
      video,
    });
    session.sidecar = sidecar;
    try {
      session.entry = await finishTake(jobId, session.takeId, sidecar);
    } catch (e) {
      await fail("finish", e);
      return session;
    }
    session.state = "review";
    return session;
  }

  async function keep() {
    if (session.state !== "review") return session;
    session.state = "kept";
    emit({ type: "finished", jobId, takeId: session.takeId, trackId, take: session.entry });
    return session;
  }

  async function discard() {
    if (session.state !== "review") return session;
    try {
      await deleteTake(jobId, session.takeId);
    } catch (e) {
      console.warn("[takes] discard failed:", e);
      session.error = e;
      return session;
    }
    session.state = "discarded";
    emit({ type: "discarded", jobId, takeId: session.takeId, trackId });
    return session;
  }

  return session;
}
