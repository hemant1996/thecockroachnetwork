// In-event base64 media — civic-signal thumbnail uploads with zero operator.
//
// The file never leaves the event.  The signed event itself carries a
// data:image/jpeg;base64,… URL in its media tag (SPEC §3.4).  Relays
// already store and replicate events; relay-to-relay sync (v0.4) already
// fans them out.  So media inherits the same decentralization properties
// as the report text — no extra storage layer, no pin service, no IPFS.
//
// Trade-off: every event with media is heavier than text-only, which
// inflates feed bandwidth.  We mitigate by hard-capping the encoded
// payload aggressively client-side via canvas downscaling + JPEG quality
// iteration.
//
// Targets:
//   - max longest edge: 720 px (640 if quality 60 still exceeds budget)
//   - JPEG quality: starts at 0.7, drops in 0.1 steps until size budget met
//   - hard ceiling: 48 KB raw → ~64 KB as base64 → fits in 64 KiB event cap

const MAX_LONGEST_EDGE_PX = 720;
const MIN_LONGEST_EDGE_PX = 320;
const MAX_RAW_BYTES = 48 * 1024;  // 48 KB raw → ~64 KB base64 → fits MAX_EVENT_BYTES
const QUALITY_START = 0.7;
const QUALITY_MIN = 0.4;

async function fileToImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve; img.onerror = () => reject(new Error("invalid image"));
      img.src = url;
    });
    return img;
  } finally {
    // ObjectURL is revoked after the Image's pixel data has been read into
    // canvas in compressImage(), so we can safely revoke here on success.
    // (If we revoke before the image is drawn to canvas, Chrome is fine but
    // Safari sometimes errors. Keep alive until the caller is done.)
  }
}

function drawScaled(img, longest) {
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const scale = Math.min(1, longest / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(b => resolve(b), "image/jpeg", quality));
}

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function bytesToBase64(bytes) {
  // ~chunked to avoid call-stack overflow on large arrays
  let s = ""; const chunk = 4096;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(s);
}

async function sha256Hex(bytes) {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compress a user-selected image to a budget-fitting JPEG and return
 * { dataUrl, sha256, mime, size } suitable for the media tag.
 *
 * Strategy: try at the largest edge + best quality first, drop quality,
 * then drop dimensions, until the raw JPEG is ≤ MAX_RAW_BYTES.  If even
 * the smallest setting overshoots, throw — better to refuse than ship
 * something the relay will reject for size.
 */
export async function compressImage(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("not an image");
  const img = await fileToImage(file);

  for (let edge = MAX_LONGEST_EDGE_PX; edge >= MIN_LONGEST_EDGE_PX; edge -= 80) {
    const canvas = drawScaled(img, edge);
    for (let q = QUALITY_START; q >= QUALITY_MIN; q -= 0.1) {
      const blob = await canvasToJpegBlob(canvas, q);
      if (!blob) continue;
      const bytes = await blobBytes(blob);
      if (bytes.length <= MAX_RAW_BYTES) {
        const base64 = bytesToBase64(bytes);
        const dataUrl = "data:image/jpeg;base64," + base64;
        const sha256 = await sha256Hex(bytes);
        return { dataUrl, sha256, mime: "image/jpeg", size: bytes.length };
      }
    }
  }
  throw new Error("image too detailed to fit in 48 KB even at 320 px / quality 0.4 — try a simpler picture");
}
