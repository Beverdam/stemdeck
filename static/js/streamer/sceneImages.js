// The pictures of Streamer Mode's Image and Background Image layers.
//
// A picture is chosen from the computer, shrunk to at most the output's width
// and kept in this browser's IndexedDB (a WebView's too), under a key the
// scene stores (layer.props.imageKey). The app keeps no other user pictures,
// and a data URL in the app's store would make every store write carry it.
// At most IMAGE_MAX_BYTES after shrinking; a bigger one is refused with a
// message. A local file never taints the canvas the recorder captures.
//
// Pictures are loaded once per key into an <img> the renderer draws.

import { IMAGE_MAX_BYTES, IMAGE_TYPES, downscaleSize } from "./streamerModel.js";

const DB = "stemdeck-streamer";
const STORE = "images";
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("no IndexedDB"));
        return;
      }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export function saveImage(key, blob) {
  return run("readwrite", (s) => s.put(blob, key));
}

export function loadImageBlob(key) {
  return run("readonly", (s) => s.get(key)).then((b) => b || null);
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Shrink a chosen file to at most `maxWidth` and the size cap. Resolves the
 * Blob, or rejects with an Error whose `code` is "type" (not PNG, JPEG or
 * WebP), "decode" (not a readable picture) or "too-big".
 */
export async function preparePicture(file, maxWidth) {
  if (!file || !IMAGE_TYPES.includes(file.type)) throw Object.assign(new Error("type"), { code: "type" });
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw Object.assign(new Error("decode"), { code: "decode" });
  }
  try {
    let size = downscaleSize(bitmap.width, bitmap.height, maxWidth);
    // WebP keeps transparency and is small; JPEG where the browser cannot
    // write WebP (older WebKit).
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, size.width, size.height);
      const quality = [0.9, 0.82, 0.72][Math.min(2, attempt)];
      let blob = await toBlob(canvas, "image/webp", quality);
      if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", quality);
      if (blob && blob.size <= IMAGE_MAX_BYTES) return blob;
      // Still too big: smaller (after the quality steps).
      if (attempt >= 2) size = downscaleSize(size.width, size.height, Math.round(size.width * 0.75));
    }
  } finally {
    bitmap.close?.();
  }
  throw Object.assign(new Error("too-big"), { code: "too-big" });
}

// key -> { img, ok }
const pictures = new Map();
let onLoaded = () => {};

/** Called when a picture finishes loading (the preview redraws). */
export function onPictureLoaded(cb) {
  onLoaded = cb;
}

/** The loaded picture for `key`, or null (loading starts on first ask). */
export function pictureFor(key) {
  if (!key) return null;
  let p = pictures.get(key);
  if (!p) {
    p = { img: null, ok: false };
    pictures.set(key, p);
    loadImageBlob(key).then((blob) => {
      if (!blob) return;
      const img = new Image();
      img.onload = () => {
        p.ok = true;
        onLoaded();
      };
      img.src = URL.createObjectURL(blob);
      p.img = img;
    }).catch((err) => console.warn("[streamer] reading a picture failed:", err));
  }
  return p.ok ? p.img : null;
}

/** Forget a cached picture (a new one was chosen under the same layer). */
export function forgetPicture(key) {
  const p = pictures.get(key);
  if (p?.img?.src) URL.revokeObjectURL(p.img.src);
  if (p?.img) p.img.src = "";
  pictures.delete(key);
}

/** Forget every loaded picture (another song is shown): blob URLs revoked,
 * decoded pictures let go. They load again from IndexedDB when asked. */
export function forgetAllPictures() {
  for (const key of [...pictures.keys()]) forgetPicture(key);
}

/** The stored keys that start with `prefix` (one song's: "<jobId>:"). */
export function storedKeys(prefix) {
  const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  return run("readonly", (st) => st.getAllKeys(range)).then((keys) => (keys || []).map(String));
}

/**
 * Delete the pictures of `prefix` that `keep` (a Set of keys) does not name:
 * the song's saved scene and its undo history are all that can show one.
 * Resolves the number deleted.
 */
export async function pruneImages(prefix, keep) {
  const keys = await storedKeys(prefix);
  const gone = keys.filter((k) => !keep.has(k));
  if (!gone.length) return 0;
  await run("readwrite", (st) => {
    for (const k of gone) st.delete(k);
    return null;
  });
  for (const k of gone) forgetPicture(k);
  return gone.length;
}
