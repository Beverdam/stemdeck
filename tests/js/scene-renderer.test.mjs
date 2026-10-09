// Streamer Mode's scene renderer (static/js/streamer/sceneRenderer.js), on a
// stub 2D context that records what is drawn: the output never carries the
// editor's overlays, hidden layers draw nothing, text is the song's.
import { renderScene, wrapText, fitText, aspectScale } from "../../static/js/streamer/sceneRenderer.js";
import { defaultScene, withLayerVisible, addLayer, setLayerProps } from "../../static/js/streamer/streamerModel.js";

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
check("no lyrics: nothing drawn in the editor either (the layers panel says so)", !texts(emptyEd).includes("No synced lyrics") && !texts(emptyEd).includes("Move into the light now"));

// Same picture at two sizes: positions scale with the output.
const small = stubContext();
renderScene(small, scene, frame, { width: 716, height: 403, font: "Inter", labels, editor: null });
const at = (ctx, text) => ctx.calls.find((c) => c.name === "fillText" && c.args[0] === text)?.args;
const big = at(out, "Floorlight");
const tiny = at(small, "Floorlight");
check("preview and output are the same picture scaled", Math.abs(big[1] / 1920 - tiny[1] / 716) < 0.002 && Math.abs(big[2] / 1080 - tiny[2] / 403) < 0.002);

// Text fitting: wrapped, smaller, cut, never outside the frame.
{
  const ctx = stubContext();
  ctx.font = "700 10px Inter";
  // The stub measures 6 px a character whatever the size; scale by the font size here.
  ctx.measureText = (s) => ({ width: String(s).length * 0.6 * (parseFloat(/(\d+(\.\d+)?)px/.exec(ctx.font)?.[1]) || 10) });
  const lines = wrapText(ctx, "one two three four", 60);
  check("wrap breaks at words within the width", lines.length >= 2 && lines.every((l) => ctx.measureText(l).width <= 60) && lines.join(" ") === "one two three four");
  const cut = wrapText(ctx, "supercalifragilistic", 60);
  check("a word wider than the line is cut with an ellipsis", cut.length === 1 && cut[0].endsWith("…") && ctx.measureText(cut[0]).width <= 60);
  check("text without spaces breaks between characters", wrapText(ctx, "歌詞歌詞歌詞歌詞歌詞歌詞", 40).length > 1);
  const big = fitText(ctx, "Hello stream from the studio tonight", 120, 40, 40, 6, 700, "Inter");
  check("too big: the size comes down until it fits the box", big.size < 40 && big.lines.length * big.size * 1.2 <= 40 + 1e-6 && big.lines.every((l) => { ctx.font = `700 ${big.size}px Inter`; return ctx.measureText(l).width <= 120; }));
  const tiny = fitText(ctx, "a b c d e f g h i j k l m n o p q r s t u v w x y z", 30, 10, 20, 6, 700, "Inter");
  check("at the smallest size, the lines that fit, the last cut", tiny.size === 6 && tiny.lines.length === 1 && tiny.lines[0].endsWith("…"));
  check("text that fits keeps its size", fitText(ctx, "Hi", 200, 100, 20, 6, 700, "Inter").size === 20);
}
{
  // Drawn in a narrow 9:16 frame: every line inside the text layer's frame.
  let sc = setLayerProps(addLayer(defaultScene("9:16"), "text"), "text", { text: "Thanks for watching, see you next week everybody", size: 3 });
  const ctx = stubContext();
  ctx.measureText = (s) => ({ width: String(s).length * 0.6 * (parseFloat(/(\d+(\.\d+)?)px/.exec(ctx.font)?.[1]) || 10) });
  renderScene(ctx, sc, frame, { width: 1080, height: 1920, font: "Inter", labels, editor: null });
  const f = sc.layers.find((l) => l.id === "text").frame;
  const W = 1080, H = 1920;
  const said = "Thanks for watching, see you next week everybody";
  const drawn = ctx.calls.filter((c) => c.name === "fillText" && String(c.args[0]).length > 3 && said.includes(String(c.args[0]).replace("…", "")));
  // Each line is centred in the frame and, drawn at the size fitText chose, no wider than it.
  const fitted = fitText(ctx, said, f.w * W, f.h * H, 20 * 3 * (1080 / 403), 6 * (1080 / 403), 700, "Inter");
  const inside = drawn.every((c) => c.args[1] >= f.x * W && c.args[1] <= (f.x + f.w) * W && c.args[2] >= f.y * H && c.args[2] <= (f.y + f.h) * H)
    && fitted.lines.every((l) => { ctx.font = `700 ${fitted.size}px Inter`; return ctx.measureText(l).width <= f.w * W; });
  check("a long text in a 9:16 frame wraps and stays inside its frame", drawn.length >= 2 && inside && fitted.size < 20 * 3 * (1080 / 403) && ctx.calls.some((c) => c.name === "clip"));
}

// Phase 2 layers
const labels2 = { ...labels, text: "Your text", image: "Image placeholder" };
const draw2 = (sc, editor) => {
  const ctx = stubContext();
  renderScene(ctx, sc, frame, { width: 1920, height: 1080, font: "Inter", labels: labels2, editor });
  return ctx;
};
let sc2 = addLayer(addLayer(scene, "text"), "image");
check("an empty text layer shows its placeholder in the editor only", texts(draw2(sc2, { selection: null })).includes("Your text") && !texts(draw2(sc2, null)).includes("Your text"));
sc2 = setLayerProps(sc2, "text", { text: "Hello stream" });
check("a text layer draws its text in the video", texts(draw2(sc2, null)).includes("Hello stream"));
check("an image layer is a placeholder in the editor, nothing in the video", texts(draw2(sc2, { selection: null })).includes("Image placeholder") && !texts(draw2(sc2, null)).includes("Image placeholder"));
const noArtist = setLayerProps(scene, "title", { showArtist: false });
check("the title layer can leave the artist out", !texts(draw2(noArtist, null)).includes("The Late Arrivals") && texts(draw2(noArtist, null)).includes("Floorlight"));
const cam = { videoWidth: 1280, videoHeight: 720, width: 1280, height: 720 };
const mirrored = setLayerProps(scene, "camera", { mirror: true });
const camCalls = (editor) => {
  const ctx = stubContext();
  renderScene(ctx, mirrored, { ...frame, camera: cam }, { width: 1920, height: 1080, font: "Inter", labels, editor });
  return ctx.calls;
};
const flips = (calls) => calls.filter((c) => c.name === "scale" && c.args[0] === -1).length;
check("the camera mirror is the preview's only, never the video's", flips(camCalls({ selection: null })) === 1 && flips(camCalls(null)) === 0);

// Pictures and portrait sizes (phase 5)
check("portrait and square draw larger than landscape", aspectScale(1080, 1920) === 1.3 && aspectScale(1080, 1080) === 1.15 && aspectScale(1920, 1080) === 1 && aspectScale(0, 0) === 1);
const pic = { naturalWidth: 400, naturalHeight: 200, width: 400, height: 200, complete: true };
const picScene = setLayerProps(setLayerProps(withLayerVisible(addLayer(scene, "image"), "background", true), "background", { imageKey: "j:background:1" }), "image", { imageKey: "j:image:1" });
const picCtx = (images) => {
  const ctx = stubContext();
  renderScene(ctx, picScene, { ...frame, images }, { width: 1920, height: 1080, font: "Inter", labels: labels2, editor: null });
  return ctx;
};
const picDraws = (ctx) => ctx.calls.filter((c) => c.name === "drawImage" && c.args[0] === pic);
const drawnPics = picDraws(picCtx(new Map([["j:background:1", pic], ["j:image:1", pic]])));
const bg = drawnPics[0]?.args;
check("a background picture covers the whole frame", drawnPics.length === 2 && bg && bg[3] >= 1920 - 0.01 && bg[4] >= 1080 - 0.01 && (Math.abs(bg[3] - 1920) < 0.01 || Math.abs(bg[4] - 1080) < 0.01));
const imgFrame = picScene.layers.find((l) => l.id === "image").frame;
const ia = drawnPics[1]?.args;
check("an image layer's picture fits inside its frame", ia && ia[3] <= imgFrame.w * 1920 + 0.01 && ia[4] <= imgFrame.h * 1080 + 0.01 && (Math.abs(ia[3] - imgFrame.w * 1920) < 0.01 || Math.abs(ia[4] - imgFrame.h * 1080) < 0.01));
const notYet = picCtx(new Map());
check("a picture not loaded yet draws nothing in the video", picDraws(notYet).length === 0 && !texts(notYet).includes("Image placeholder"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
