// Which saved mix of the open song is in force.
//
// Every mode keeps its own record of a song (mixer.js: mixKey): what is muted,
// soloed and how loud, each lane's key, the EQ and the master, and the speed
// and global key the song was left at. This module watches the mode (Practice
// or Advanced, mode.js) and Karaoke Mode (karaoke/karaoke.js, announced by
// "stemdeck:karaoke-changed"), and when the one in force changes it has the
// mixer swap the open song's record, then pushes the new one to wherever it
// is heard and shown: the lanes' gains, their keys, the EQ panels and the
// master (which follows the EQ's re-apply), the speed and the key counter.
//
// Announces "stemdeck:mix-switched" ({ id, mode }) when it replaced the mix.
// A song that loads later reads the record of the mode in force by itself.

import { getMode, onModeChange } from "./mode.js";
import { switchMixMode, refreshMixerVisuals, applyMix, applyAllLanePitches } from "./mixer.js";
import { applyAllLaneEq } from "./eqEngine.js";
import { restoreGlobals } from "./transport.js";
import { currentJobId } from "./state.js";

let karaokeOpen = false;
// One switch at a time, in the order asked: the mode can change twice in a
// moment (Karaoke opened, then closed), and each switch reads and writes the
// store.
let chain = Promise.resolve();

const wanted = () => (karaokeOpen ? "karaoke" : getMode());

export function syncMixMode() {
  chain = chain.then(async () => {
    const mode = wanted();
    let replaced = false;
    try {
      replaced = await switchMixMode(mode);
    } catch (err) {
      console.warn("[mixMode] could not switch the saved mix:", err);
    }
    if (!replaced || mode !== wanted()) return;
    refreshMixerVisuals();
    applyMix();
    applyAllLanePitches();
    applyAllLaneEq();
    restoreGlobals();
    document.dispatchEvent(new CustomEvent("stemdeck:mix-switched", { detail: { id: currentJobId, mode } }));
  });
  return chain;
}

export function initMixMode() {
  onModeChange(() => { syncMixMode(); });
  document.addEventListener("stemdeck:karaoke-changed", (e) => {
    karaokeOpen = Boolean(e.detail?.open);
    syncMixMode();
  });
}
