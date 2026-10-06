// Named starting points for the EQ panels. Plain data: node tests read them.
// Names are i18n keys. Graph presets are bands; pedal and keys presets are
// the panel's own control values (eqPedalMath.js turns them into bands).

const bell = (f, g, q = 1) => ({ on: true, type: "bell", f, g, q, slope: 12 });
const shelf = (type, f, g) => ({ on: true, type, f, g, q: 0.707, slope: 12 });
const cut = (type, f, slope = 24) => ({ on: true, type, f, g: 0, q: 0.707, slope });

const GRAPH = [
  { key: "eq.preset.cleanLows", bands: [cut("lowcut", 80)] },
  { key: "eq.preset.lessMud", bands: [bell(300, -3, 1.2)] },
  { key: "eq.preset.presence", bands: [bell(3000, 2.5, 0.9)] },
  { key: "eq.preset.addAir", bands: [shelf("highshelf", 10000, 3)] },
];

const DRUM = [
  { key: "eq.preset.drumsTighten", bands: [cut("lowcut", 35), bell(400, -4, 1.4), bell(5000, 2, 0.8)] },
  { key: "eq.preset.drumsPunch", bands: [bell(70, 3, 1.1), bell(350, -2, 1.2), bell(4000, 2.5, 1)] },
  { key: "eq.preset.drumsCymbals", bands: [bell(3500, -1.5, 1.5), shelf("highshelf", 8000, -4)] },
];

/** The presets of a graphical panel ("drum" or "graph"). */
export function graphPresets(kind) {
  return kind === "drum" ? DRUM : GRAPH;
}
