// Decentralized media via Helia (browser IPFS) — no operator dependency.
//
// Trust / decentralization model:
//
//   - Files are content-addressed by IPFS CID.  Any IPFS-compatible client
//     in the world can retrieve them; we don't operate any storage.
//   - The uploader's browser is the first source via libp2p + bitswap.
//     As long as their tab stays open, the file is reachable.
//   - When another client requests the CID, public IPFS gateways
//     (Cloudflare's cf-ipfs, Protocol Labs' dweb.link, Storacha's w3s.link)
//     can resolve it via the DHT.  Those gateways tend to cache popular
//     content, which acts as best-effort persistence.
//   - The protocol author and relay operators MAY also pin files via
//     their own pinning credentials, but the client doesn't require it.
//     For guaranteed permanence, users can configure their own Storacha
//     or Pinata token in Settings (future work, see SPEC.md §10).
//
// Helia is heavy (~500 KB gzipped) so we lazy-load on first upload to
// keep the initial page fast.  Subsequent uploads reuse the running node.

let _heliaPromise = null;

async function getHelia() {
  if (_heliaPromise) return _heliaPromise;
  _heliaPromise = (async () => {
    const [{ createHelia }, { unixfs }] = await Promise.all([
      import("https://esm.sh/helia@4.2.6"),
      import("https://esm.sh/@helia/unixfs@3.0.7"),
    ]);
    const helia = await createHelia();
    const fs = unixfs(helia);
    return { helia, fs };
  })();
  return _heliaPromise;
}

// Begin warming up the Helia node opportunistically.  Safe to call repeatedly;
// returns the same promise.
export function warmupHelia() { return getHelia().catch(() => null); }

/**
 * Upload a File or Blob to IPFS via the local Helia node.
 * Returns metadata that callers should attach to their event as a media tag.
 */
export async function uploadFile(file) {
  if (!file) throw new Error("no file");
  if (file.size > 20 * 1024 * 1024) {
    // 20 MB cap.  Helia handles larger but browser memory + the DHT
    // round-trip cost balloon quickly for civic-report use cases.
    throw new Error("file too large (limit 20 MB)");
  }
  const { fs } = await getHelia();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const cid = await fs.addBytes(bytes);
  // Compute SHA-256 separately so non-IPFS verifiers can still check
  // the bytes match the claim in the event (per SPEC §3.4 media tag).
  const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
  const sha256Hex = [...new Uint8Array(hashBuf)]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  return {
    cid: cid.toString(),
    sha256: sha256Hex,
    size: file.size,
    mime: file.type || "application/octet-stream",
    name: file.name || "",
  };
}

const PUBLIC_GATEWAYS = [
  (cid) => `https://${cid}.ipfs.dweb.link`,
  (cid) => `https://${cid}.ipfs.w3s.link`,
  (cid) => `https://${cid}.ipfs.cf-ipfs.com`,
];

/**
 * URL good enough for an <img src>.  Hands off to dweb.link by default;
 * if it fails the browser will surface a broken-image which the caller
 * can detect and retry with one of the other gateways.
 */
export function publicGatewayUrl(cid) {
  return PUBLIC_GATEWAYS[0](cid);
}

/**
 * Return a list of fallback URLs to try in order if the first one fails.
 */
export function publicGatewayUrls(cid) {
  return PUBLIC_GATEWAYS.map(g => g(cid));
}

/**
 * Retrieve a CID as a Blob.  Races the local Helia node (P2P) against
 * the public gateway list — first one home wins.
 */
export async function retrieveFile(cidStr, opts = {}) {
  const helia = getHelia();
  const tasks = [
    heliaRetrieve(helia, cidStr, opts),
    gatewayRetrieve(cidStr, opts),
  ];
  return Promise.any(tasks);
}

async function heliaRetrieve(heliaPromise, cidStr, opts) {
  const { fs } = await heliaPromise;
  const { CID } = await import("https://esm.sh/multiformats@13/cid");
  const cid = CID.parse(cidStr);
  const chunks = [];
  for await (const chunk of fs.cat(cid, { signal: opts.signal })) chunks.push(chunk);
  return new Blob(chunks);
}

async function gatewayRetrieve(cidStr, opts) {
  for (const make of PUBLIC_GATEWAYS) {
    try {
      const r = await fetch(make(cidStr), { signal: opts.signal });
      if (r.ok) return await r.blob();
    } catch { /* try next */ }
  }
  throw new Error("no IPFS gateway returned the CID");
}
