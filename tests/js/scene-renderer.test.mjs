// Streamer Mode's scene renderer (static/js/streamer/sceneRenderer.js), on a
// stub 2D context that records what is drawn: the output never carries the
// editor's overlays, hidden layers draw nothing, text is the song's.
import { renderScene } from "../../static/js/streamer/sceneRenderer.js";
import { defaultScene, withLayerVisible } from "../../static/js/streamer/streamerModel.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.log(`FAIL  ${name} ${detail}`); }
}

function stubContext() {
  const calls = [];
  const gradient = () => ({ addColorStop() {} });
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  const ctx = {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    save: rec("save"),
    restore: rec("restore"),
    translate: rec("translate"),
    scale: rec("scale"),
    beginPath: rec("beginPath"),
    closePath: rec("closePath"),
    moveTo: rec("moveTo"),
    arcTo: rec("arcTo"),
    arc: rec("arc"),
    rect: rec("rect"),
    clip: rec("clip"),
    fill: rec("fill"),
    stroke: rec("stroke"),
    fillRect: rec("fillRect"),
    strokeRect: rec("strokeRect"),
    drawImage: rec("drawImage"),
    setLineDash: rec("setLineDash"),
    fillText: (text, x, y) => calls.push({ name: "fillText", args: [text, x, y] }),
    measureText: (text) => ({ width: String(text).length * 6 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
  };
  return ctx;
}

const frame = {
  t: 30,
  duration: 120,
  title: "Floorlight",
  artist: "The Late Arrivals",
  art: null,
  camera: null,
  lyrics: [{ text: "Move into the light now", role: "current" }, { text: "Shine until the night is gone", role: "next" }],
  bars: new Array(34).fill(0.5),
};
const labels = { handle: "@yourname", subtitle: "Your channel", noLyrics: "No synced lyrics", camera: "Camera", actionSafe: "Action safe", titleSafe: "Title safe" };
const draw = (scene, editor, f = frame) => {
  const ctx = stubContext();
  renderScene(ctx, scene, f, { width: 1920, height: 1080, font: "Inter", accent: "#f4b740", labels, editor });
  return ctx;
};
const texts = (ctx) => ctx.calls.filter((c) => c.name === "fillText").map((c) => c.args[0]);
const dashed = (ctx) => ctx.calls.filter((c) => c.name === "setLineDash").length;

const scene = defaultScene();
const out = draw(scene, null);
const ed = draw(scene, { selection: "title", safeZones: true });

check("draws the song's title and artist", texts(out).includes("Floorlight") && texts(out).includes("The Late Arrivals"));
check("draws the lyric lines", texts(out).includes("Move into the light now") && texts(out).includes("Shine until the night is gone"));
check("draws the lower third placeholder", texts(out).includes("@yourname") && texts(out).includes("Your channel"));
check("the output has no dashed lines (no selection, no safe zones)", dashed(out) === 0);
check("the output has no safe zone labels or camera placeholder", !texts(out).includes("Action safe") && !texts(out).includes("Camera"));
check("the editor draws the selection and both safe zones", dashed(ed) === 2 && texts(ed).includes("Action safe") && texts(ed).includes("Title safe"));
check("the editor shows where the camera goes", texts(ed).includes("Camera"));
check("save and restore balance", out.calls.filter((c) => c.name === "save").length === out.calls.filter((c) => c.name === "restore").length);
check("the frame starts black and full size", out.calls[1]?.name === "fillRect" && out.calls[1].args.join(",") === "0,0,1920,1080");

const noLyrics = draw(withLayerVisible(scene, "lyrics", false), null);
check("a hidden layer draws nothing", !texts(noLyrics).includes("Move into the light now"));
const noSelection = draw(withLayerVisible(scene, "title", false), { selection: "title", safeZones: false });
check("a hidden selected layer has no outline", dashed(noSelection) === 0);
const empty = draw(scene, null, { ...frame, lyrics: [] });
check("no lyrics: the output draws no empty box text", !texts(empty).includes("No synced lyrics"));
const emptyEd = draw(scene, { selection: null, safeZones: false }, { ...frame, lyrics: [] });
check("no lyrics: the editor says so", texts(emptyEd).includes("No synced lyrics"));

// Same picture at two sizes: positions scale with the output.
const small = stubContext();
renderScene(small, scene, frame, { width: 716, height: 403, font: "Inter", labels, editor: null });
const at = (ctx, text) => ctx.calls.find((c) => c.name === "fillText" && c.args[0] === text)?.args;
const big = at(out, "Floorlight");
const tiny = at(small, "Floorlight");
check("preview and output are the same picture scaled", Math.abs(big[1] / 1920 - tiny[1] / 716) < 0.002 && Math.abs(big[2] / 1080 - tiny[2] / 403) < 0.002);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
