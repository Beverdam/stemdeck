// Streamer Mode's recording and export arithmetic (static/js/streamer/recordModel.js).
import {
  RECORD_STATES, nextRecordState, isTakeOpen, startPoint, shouldAutoStop,
  outputPixels, videoBitrate, exportFileName, buildRenderRequest, isNoEncoder,
} from "../../static/js/streamer/recordModel.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.log(`FAIL  ${name} ${detail}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The recorder's states
const run = (events, from = "idle") => events.reduce((s, e) => nextRecordState(s, e), from);
check("all states known", RECORD_STATES.length === 9);
check("a take: start, started, stop, saved", run(["start", "started", "stop", "saved"]) === "saved");
check("export: saved, exporting, exported", run(["export", "done"], "saved") === "exported");
check("export again after a failed export", run(["export", "fail", "export", "done"], "saved") === "exported");
check("a cancelled export goes back to saved", run(["export", "cancel"], "saved") === "saved");
check("a new take after an export", run(["start"], "exported") === "starting");
check("a failure at any open stage", ["starting", "recording", "stopping"].every((s) => nextRecordState(s, "fail") === "failed"));
check("events that do not apply change nothing", nextRecordState("idle", "stop") === "idle" && nextRecordState("recording", "start") === "recording" && nextRecordState("exporting", "start") === "exporting" && nextRecordState("idle", "export") === "idle");
check("stop while starting", nextRecordState("starting", "stop") === "stopping");
check("take open: starting, recording, stopping only", ["starting", "recording", "stopping"].every(isTakeOpen) && !["idle", "saved", "failed", "exporting", "exported"].some(isTakeOpen));

// Where a take starts and when it stops
const range = { in: 30, out: 40 };
check("start at the range's start when the playhead is before it", startPoint(5, range) === 30);
check("start where the playhead is inside the range", startPoint(33.5, range) === 33.5);
check("start at the range's start when the playhead is at or past its end", startPoint(39.8, range) === 30 && startPoint(50, range) === 30);
check("no auto-stop with the switch off", !shouldAutoStop({ t: 45, range, duration: 200, autoStop: false }));
check("auto-stop at the out point", shouldAutoStop({ t: 39.99, range, duration: 200, autoStop: true }) && !shouldAutoStop({ t: 39.5, range, duration: 200, autoStop: true }));
check("auto-stop is held to the song's length", shouldAutoStop({ t: 119.99, range: { in: 0, out: 400 }, duration: 120, autoStop: true }));

// Output
check("16:9 sizes", eq(outputPixels("16:9", "720"), { width: 1280, height: 720 }) && eq(outputPixels("16:9", "1080"), { width: 1920, height: 1080 }) && eq(outputPixels("16:9", "2160"), { width: 3840, height: 2160 }));
check("9:16 sizes", eq(outputPixels("9:16", "720"), { width: 720, height: 1280 }) && eq(outputPixels("9:16", "2160"), { width: 2160, height: 3840 }));
check("1:1 sizes", eq(outputPixels("1:1", "1080"), { width: 1080, height: 1080 }));
check("an unknown resolution is 1080p", eq(outputPixels("16:9", "480"), { width: 1920, height: 1080 }));
check("bit rate grows with size and rate, held to 2.5..40 Mbps", videoBitrate({ width: 1920, height: 1080 }, 30) === 6220800
  && videoBitrate({ width: 640, height: 360 }, 24) === 2_500_000 && videoBitrate({ width: 3840, height: 2160 }, 60) === 40_000_000);

// The file name
check("title, artist, suffix", exportFileName("Come as You Are", "Nirvana") === "Come as You Are - Nirvana (Streamer).mp4");
check("no artist", exportFileName("Happy", "") === "Happy (Streamer).mp4");
check("no title", exportFileName("", "Nirvana") === "Streamer.mp4" && exportFileName(null, null) === "Streamer.mp4");
check("forbidden characters become spaces", exportFileName('AC/DC: "Back" <in> Black?', "a|b*c") === "AC DC Back in Black - a b c (Streamer).mp4");
check("path tricks do not survive", !exportFileName("../../etc/passwd", "x").includes("/") && !exportFileName("..\\..\\win", "x").includes("\\"));
check("control characters go", exportFileName("A\u0000B\u001fC", "") === "A B C (Streamer).mp4");
check("no dots or spaces at the ends", exportFileName("  ..Song..  ", "") === "Song (Streamer).mp4");
check("long names are cut", exportFileName("x".repeat(300), "").length <= 120 + " (Streamer).mp4".length);
check("Windows device names are not a file name", exportFileName("CON", "") === "CON song (Streamer).mp4");
check("another extension for the raw recording", exportFileName("Song", "A", "webm") === "Song - A (Streamer).webm");

// The render request
const mix = { names: ["vocals", "drums", "trk1"], gains: [1, 0.5, 1], pitches: [0, 0, 0] };
const body = buildRenderRequest({ mix, exclude: ["trk1"], aspect: "9:16", resolution: "720", fps: 60, range, includeClick: true });
check("the Streamer track is left out of the backing", eq(body.stems, ["vocals", "drums"]) && eq(body.gains, [1, 0.5]));
check("canvas, size, rate, fit fill, no mirror", body.canvas === "9:16" && body.size === "720" && body.fps === 60 && body.fit === "fill" && body.mirror === false);
check("the trim as span range", body.span === "range" && body.range_in === 30 && body.range_out === 40);
check("click and take gain", body.click === true && body.take_gain === 1);
check("no pitches when nothing is transposed", !("pitches" in body));
check("pitches when a lane is", eq(buildRenderRequest({ mix: { names: ["a", "b"], gains: [1, 1], pitches: [0, 2] }, range }).pitches, [0, 2]));
const micOnly = buildRenderRequest({ mix, mixedAudio: false, range });
check("mixed audio off: no backing lanes (the take alone)", eq(micOnly.stems, []) && eq(micOnly.gains, []));
check("no range: the take's own span", buildRenderRequest({ mix }).span === "take");
check("fx and master only when given", !("fx" in body) && buildRenderRequest({ mix, fx: "abc", master: "m", range }).fx === "abc");
check("defaults: 16:9, 1080p, 30 fps, click off", (() => {
  const b = buildRenderRequest({ mix, range });
  return b.canvas === "16:9" && b.size === "1080" && b.fps === 30 && b.click === false;
})());
check("the no-encoder refusal is recognised", isNoEncoder(422, "this ffmpeg build cannot encode H.264 video (no libx264)") && isNoEncoder(422, "cannot encode H.264 video (no AAC encoder)") && !isNoEncoder(422, "gain out of range") && !isNoEncoder(500, "libx264"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
