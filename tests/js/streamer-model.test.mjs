// Streamer Mode's arithmetic (static/js/streamer/streamerModel.js).
import {
  SCENE_VERSION, ASPECTS, DEFAULT_ASPECT, LAYER_TYPES, sceneKey,
  aspectRatio, outputSize, fitAspect,
  defaultScene, defaultFrame, withAspect, withLayerVisible,
  clampFrame, parseScene, serializeScene,
  lyricWindow, peakBars, clockTenths, clockHours, rulerTicks,
} from "../../static/js/streamer/streamerModel.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.log(`FAIL  ${name} ${detail}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const inUnit = (f) => f.x >= 0 && f.y >= 0 && f.w > 0 && f.h > 0 && f.x + f.w <= 1 + 1e-9 && f.y + f.h <= 1 + 1e-9;

// Defaults
const s = defaultScene();
check("default scene is 16:9, current version", s.aspect === "16:9" && s.v === SCENE_VERSION && DEFAULT_ASPECT === "16:9");
check("seven default layers, one of each type", s.layers.length === 7 && eq([...s.layers.map((l) => l.type)].sort(), [...LAYER_TYPES].sort()));
check("ids are unique", new Set(s.layers.map((l) => l.id)).size === s.layers.length);
check("everything shown but the background image", s.layers.every((l) => l.visible === (l.type !== "background")));
check("background at the back, album art in front", s.layers[0].type === "background" && s.layers[1].type === "camera" && s.layers[s.layers.length - 1].type === "albumArt");
check("album art is drawn over the title card", s.layers.findIndex((l) => l.type === "albumArt") > s.layers.findIndex((l) => l.type === "title"));
check("camera and background fill the frame", eq(defaultFrame("camera"), { x: 0, y: 0, w: 1, h: 1 }) && eq(defaultFrame("background", "9:16"), { x: 0, y: 0, w: 1, h: 1 }));
check("every default frame is inside the output, at every aspect", ASPECTS.every((a) => defaultScene(a).layers.every((l) => inUnit(l.frame))));
check("frames are fractions of the design preview", near(defaultFrame("title").x, 472 / 716) && near(defaultFrame("title").w, 238 / 716) && near(defaultFrame("lyrics").h, 134 / 403));
check("the album art sits inside the title card", (() => {
  const t = defaultFrame("title"), a = defaultFrame("albumArt");
  return a.x >= t.x && a.y >= t.y && a.x + a.w <= t.x + t.w && a.y + a.h <= t.y + t.h;
})());
check("an unknown aspect gives the default scene", defaultScene("4:3").aspect === "16:9");
check("a new scene is a new object each time", defaultScene() !== defaultScene() && defaultScene().layers[0].frame !== defaultScene().layers[0].frame);
check("default props", eq(s.layers.find((l) => l.type === "lowerThird").props, { handle: "", subtitle: "" }) && s.layers.find((l) => l.type === "waveform").props.bars === 34);

// Aspect fractions
check("aspect ratios", near(aspectRatio("16:9"), 16 / 9) && near(aspectRatio("9:16"), 9 / 16) && aspectRatio("1:1") === 1 && near(aspectRatio("nope"), 16 / 9));
check("output sizes keep the short side", eq(outputSize("16:9"), { width: 1920, height: 1080 }) && eq(outputSize("9:16"), { width: 1080, height: 1920 }) && eq(outputSize("1:1", 720), { width: 720, height: 720 }));
check("16:9 fills a 16:9 box", eq(fitAspect(1600, 900, "16:9"), { x: 0, y: 0, w: 1600, h: 900 }));
const p = fitAspect(1600, 900, "9:16");
check("9:16 is pillarboxed and centred", near(p.h, 900) && near(p.w, 900 * 9 / 16) && near(p.x, (1600 - p.w) / 2) && p.y === 0);
const q = fitAspect(1600, 900, "1:1");
check("1:1 is pillarboxed and square", near(q.w, 900) && near(q.h, 900) && near(q.x, 350));
const l = fitAspect(400, 400, "16:9");
check("16:9 in a square box is letterboxed", near(l.w, 400) && near(l.h, 225) && near(l.y, 87.5));

// Changing the aspect
const portrait = withAspect(s, "9:16");
check("withAspect returns a new scene", portrait !== s && s.aspect === "16:9" && portrait.aspect === "9:16");
check("default frames move to the new aspect's defaults", eq(portrait.layers.find((x) => x.type === "lyrics").frame, defaultFrame("lyrics", "9:16")));
const moved = { ...s, layers: s.layers.map((x) => (x.type === "lyrics" ? { ...x, frame: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 } } : x)) };
check("a frame placed by hand keeps its fractions", eq(withAspect(moved, "1:1").layers.find((x) => x.type === "lyrics").frame, { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }));
check("an unknown aspect changes nothing", withAspect(s, "21:9") === s);
check("round trip to 16:9 restores the defaults", eq(withAspect(portrait, "16:9").layers.map((x) => x.frame), s.layers.map((x) => x.frame)));

// Visibility
const hidden = withLayerVisible(s, "lyrics", false);
check("withLayerVisible hides one layer only", hidden.layers.find((x) => x.id === "lyrics").visible === false && hidden.layers.filter((x) => !x.visible).length === 2 && s.layers.find((x) => x.id === "lyrics").visible === true);

// Per-song key
check("scene key is per song", sceneKey("ff5490ec654a") === "stemdeck:streamer:scene:ff5490ec654a" && sceneKey("a") !== sceneKey("b"));

// Serialization
const round = parseScene(JSON.stringify(serializeScene(hidden)));
check("serialize then parse is the same scene", eq(round, hidden));
check("serialize copies (no shared objects)", serializeScene(s).layers[0] !== s.layers[0]);
check("serialize keeps only the scene's fields", eq(Object.keys(serializeScene({ ...s, extra: 1 })).sort(), ["aspect", "layers", "v"]));
check("garbage gives the default scene", eq(parseScene("{nope"), defaultScene()) && eq(parseScene(null), defaultScene()) && eq(parseScene({ layers: "x" }), defaultScene()));
check("no readable layers keeps the aspect", eq(parseScene({ aspect: "1:1", layers: [{ type: "laser" }] }), defaultScene("1:1")));
const dirty = parseScene({
  aspect: "4:3",
  layers: [
    { id: "a", type: "title", frame: { x: -1, y: 2, w: 5, h: 0 } },
    { id: "a", type: "lyrics", visible: false, props: { lines: 3 } },
    { type: "spaceship" },
  ],
});
check("unknown aspect becomes 16:9", dirty.aspect === "16:9");
check("unknown layer types are dropped", dirty.layers.length === 2);
check("a duplicate id is renamed", dirty.layers[0].id === "a" && dirty.layers[1].id !== "a");
check("frames are clamped inside the output", inUnit(dirty.layers[0].frame) && eq(dirty.layers[0].frame, { x: 0, y: 0.99, w: 1, h: 0.01 }));
check("a missing frame takes the default", eq(dirty.layers[1].frame, defaultFrame("lyrics")));
check("visible defaults to true, false is kept", dirty.layers[0].visible === true && dirty.layers[1].visible === false);
check("props merge over the defaults", dirty.layers[1].props.lines === 3);
check("clampFrame keeps a 1% minimum", eq(clampFrame({ x: 0.995, y: 0.5, w: 0, h: 0.2 }), { x: 0.99, y: 0.5, w: 0.01, h: 0.2 }));

// Lyrics in view
const lines = [10, 14, 20, 25, 30, 36, 40].map((time, i) => ({ time, text: `line ${i}` }));
check("no lines, nothing shown", eq(lyricWindow([], 5), []) && eq(lyricWindow(null, 5), []));
check("before the first line: first five, none current", eq(lyricWindow(lines, 2).map((x) => x.role), ["next", "next", "next", "later", "later"]) && lyricWindow(lines, 2)[0].text === "line 0");
const w = lyricWindow(lines, 21);
check("the sung line is current, two next, then dim", w[0].text === "line 2" && eq(w.map((x) => x.role), ["current", "next", "next", "later", "later"]));
check("near the end fewer lines", eq(lyricWindow(lines, 41).map((x) => x.text), ["line 6"]) && lyricWindow(lines, 37, 3).length === 2);
check("a line starts exactly on its time", lyricWindow(lines, 14)[0].text === "line 1");

// Waveform bars
const peaks = { vocals: [[0, 0.5], [-1, 0.2], [0, 0.1], [0, 0]], bass: [[-0.25, 0.25], [0, 0], [0, 0.75], [0, 0]] };
check("bars from one stem, normalised", eq(peakBars(peaks, ["vocals"], 4), [0.5, 1, 0.1, 0]));
check("bars take the loudest stem heard", eq(peakBars(peaks, ["vocals", "bass"], 4), [0.5, 1, 0.75, 0]));
check("bars bucket many points", eq(peakBars(peaks, ["bass"], 2), [1 / 3, 1]));
check("muted stems are left out by the caller", eq(peakBars(peaks, [], 3), [0, 0, 0]) && eq(peakBars(null, ["vocals"], 2), [0, 0]));
check("zero bars", eq(peakBars(peaks, ["vocals"], 0), []));

// Time
check("clock in tenths", clockTenths(42.3) === "00:42.3" && clockTenths(186) === "03:06.0" && clockTenths(-1) === "00:00.0" && clockTenths(62.99) === "01:02.9");
check("REC clock", clockHours(0) === "00:00:00" && clockHours(42.9) === "00:00:42" && clockHours(3725) === "01:02:05");
const ticks = rulerTicks(186);
check("ruler ticks every 30 s for a 3 minute song", eq(ticks.map((x) => x.label), ["0:00", "0:30", "1:00", "1:30", "2:00", "2:30", "3:00"]));
check("ruler ticks stay under the maximum", rulerTicks(600, 8).length <= 8 && rulerTicks(20, 8).map((x) => x.label).join(",") === "0:00,0:05,0:10,0:15,0:20");
check("no duration, no ticks", eq(rulerTicks(0), []));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
