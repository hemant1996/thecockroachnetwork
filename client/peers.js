// Cockroach — WebRTC peer-relay mesh (v0.2)
//
// Every PWA install that opts in becomes a peer in a mesh.  Peers find each
// other via signaling events (kinds 10001/10002/10003) broadcast through the
// existing relay layer, then connect directly over WebRTC data channels.
// Once connected, events flow both over relays AND over peer connections —
// the mesh absorbs traffic spikes and survives the loss of any single relay.
//
// Trade-offs (see docs/v0.2-webrtc-peer-relay.md):
//   - Peer mode EXPOSES the user's IP to other peers (vs only the relay's
//     operator) — opt-in, default off, explicit consent.
//   - WebRTC behind symmetric NATs fails without TURN — we ship STUN-only,
//     users on hostile NATs stay relay-only.
//   - Backgrounded mobile tabs get throttled; peer connections drop in those
//     cases.  Foreground / active PWA = active peer.

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const OFFER_TTL = 3600;                  // seconds; offers expire after 1h
const MAX_PEERS = 12;                    // soft cap on outbound peer count
const RECENT_ID_CAP = 2000;              // dedupe window for event gossip
const ICE_GATHERING_TIMEOUT = 4000;      // ms before we publish whatever ICE we have

export class PeerPool {
  /**
   * @param {{
   *   pubkeyHex: string,
   *   signAndReturn: (kind:number, tags:string[][], content:string) => Promise<object>,
   *   publishToRelays: (event:object) => number,
   *   onEventFromPeer: (event:object) => void,
   * }} cfg
   */
  constructor(cfg) {
    this.pubkeyHex = cfg.pubkeyHex;
    this.signAndReturn = cfg.signAndReturn;
    this.publishToRelays = cfg.publishToRelays;
    this.onEventFromPeer = cfg.onEventFromPeer;

    this.enabled = false;
    /** @type {Map<string, {pc: RTCPeerConnection, channel: RTCDataChannel|null, state: string, role: string, offerId?: string}>} */
    this.peers = new Map();
    /** outstanding outbound offer waiting for an answer */
    this.pendingOffer = null;
    /** ids of events we've already gossiped, ring-buffered */
    this.recentIds = new Set();
    /** listeners for status changes */
    this.listeners = new Set();
    /** rebroadcast timer for offers (re-publish every 30min) */
    this.republishTimer = null;
  }

  // ─── lifecycle ────────────────────────────────────────────────────────

  async enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.notify();
    await this.publishOffer();
    this.republishTimer = setInterval(() => {
      if (this.peers.size < MAX_PEERS) this.publishOffer().catch(() => {});
    }, 30 * 60 * 1000);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    clearInterval(this.republishTimer);
    this.republishTimer = null;
    for (const [, p] of this.peers) {
      try { p.channel?.close(); } catch {}
      try { p.pc.close(); } catch {}
    }
    this.peers.clear();
    this.pendingOffer = null;
    this.notify();
  }

  status() {
    return {
      enabled: this.enabled,
      connected: [...this.peers.values()].filter(p => p.state === "connected").length,
      total: this.peers.size,
      peers: [...this.peers.entries()].map(([pk, p]) => ({ pubkey: pk, state: p.state, role: p.role })),
    };
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify() { for (const f of this.listeners) try { f(this.status()); } catch {} }

  // ─── outbound offer (we want a peer) ──────────────────────────────────

  async publishOffer() {
    if (!this.enabled) return;
    if (this.pendingOffer) {
      try { this.pendingOffer.pc.close(); } catch {}
      this.pendingOffer = null;
    }
    if (this.peers.size >= MAX_PEERS) return;

    const pc = this._mkPeerConn();
    const channel = pc.createDataChannel("cockroach", { ordered: true });
    // The peer pubkey is unknown until an answer comes in — set up the channel
    // with a placeholder, the answer handler will reassociate.
    this._wireChannel(channel, null, pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitForIceGathering(pc);

    const sdp = pc.localDescription?.sdp;
    if (!sdp) return;

    const expires = Math.floor(Date.now() / 1000) + OFFER_TTL;
    const event = await this.signAndReturn(10001, [
      ["sdp", sdp],
      ["expires", String(expires)],
    ], "");
    this.publishToRelays(event);

    this.pendingOffer = { pc, channel, eventId: event.id };
  }

  // ─── inbound signaling ────────────────────────────────────────────────

  // Called by app.js whenever a kind:10001/10002/10003 event is ingested.
  handleSignaling(event) {
    if (!this.enabled) return;
    if (event.pubkey === this.pubkeyHex) return;   // never connect to ourselves
    if (event.kind === 10001) return this._handleOffer(event);
    if (event.kind === 10002) return this._handleAnswer(event);
    if (event.kind === 10003) return this._handleIce(event);
  }

  async _handleOffer(event) {
    if (this.peers.size >= MAX_PEERS) return;
    if (this.peers.has(event.pubkey)) return; // already connected/connecting
    const sdpTag = event.tags.find(t => t[0] === "sdp");
    const expiresTag = event.tags.find(t => t[0] === "expires");
    if (!sdpTag) return;
    if (expiresTag && Number(expiresTag[1]) < Math.floor(Date.now() / 1000)) return;

    const pc = this._mkPeerConn();
    pc.ondatachannel = (e) => this._wireChannel(e.channel, event.pubkey, pc);
    await pc.setRemoteDescription({ type: "offer", sdp: sdpTag[1] });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._waitForIceGathering(pc);

    const answerSdp = pc.localDescription?.sdp;
    if (!answerSdp) { try { pc.close(); } catch {} return; }

    const answerEvent = await this.signAndReturn(10002, [
      ["p", event.pubkey],
      ["e", event.id],
      ["sdp", answerSdp],
    ], "");
    this.publishToRelays(answerEvent);

    this.peers.set(event.pubkey, { pc, channel: null, state: "connecting", role: "answerer", offerId: event.id });
    this.notify();
  }

  async _handleAnswer(event) {
    const pTag = event.tags.find(t => t[0] === "p");
    const eTag = event.tags.find(t => t[0] === "e");
    const sdpTag = event.tags.find(t => t[0] === "sdp");
    if (!pTag || !eTag || !sdpTag) return;
    if (pTag[1] !== this.pubkeyHex) return;  // not for us
    if (!this.pendingOffer || eTag[1] !== this.pendingOffer.eventId) return;

    try {
      await this.pendingOffer.pc.setRemoteDescription({ type: "answer", sdp: sdpTag[1] });
    } catch (e) {
      try { this.pendingOffer.pc.close(); } catch {}
      this.pendingOffer = null;
      this.notify();
      return;
    }

    this.peers.set(event.pubkey, {
      pc: this.pendingOffer.pc,
      channel: this.pendingOffer.channel,
      state: "connecting",
      role: "offerer",
      offerId: this.pendingOffer.eventId,
    });
    this.pendingOffer = null;
    this.notify();
    // Eagerly try to set up another peer slot
    setTimeout(() => this.publishOffer().catch(() => {}), 1000);
  }

  async _handleIce(event) {
    // Reserved for trickle-ICE; current implementation gathers all ICE before
    // publishing the offer/answer, so we don't need to process trickle events.
    // Future: support trickle for faster connection establishment.
  }

  // ─── data channel wiring ──────────────────────────────────────────────

  _wireChannel(channel, peerPubkey, pc) {
    channel.onopen = () => {
      // Resolve the peer pubkey for inbound channels — find the peer entry
      // whose pc matches.
      let pk = peerPubkey;
      if (!pk) {
        for (const [p, entry] of this.peers) {
          if (entry.pc === pc) { pk = p; break; }
        }
      }
      if (pk) {
        const peer = this.peers.get(pk);
        if (peer) {
          peer.state = "connected";
          peer.channel = channel;
        }
      }
      this.notify();
    };
    channel.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (!ev || typeof ev !== "object" || typeof ev.id !== "string") return;
      if (this.recentIds.has(ev.id)) return;
      this._rememberId(ev.id);
      // Signature verification happens in the central ingest path.
      this.onEventFromPeer(ev);
      // Re-broadcast to other connected peers (gossip).
      this._fanOutToPeers(ev, channel);
    };
    channel.onclose = () => {
      for (const [pk, entry] of this.peers) {
        if (entry.channel === channel || entry.pc === pc) {
          this.peers.delete(pk);
        }
      }
      this.notify();
    };
    channel.onerror = () => { /* swallow; close handler will clean up */ };
  }

  // ─── outbound event broadcast (called when local user publishes) ─────

  broadcast(event) {
    if (!this.enabled) return 0;
    this._rememberId(event.id);
    let sent = 0;
    for (const entry of this.peers.values()) {
      if (entry.channel?.readyState === "open") {
        try { entry.channel.send(JSON.stringify(event)); sent++; } catch {}
      }
    }
    return sent;
  }

  _fanOutToPeers(event, excludeChannel) {
    for (const entry of this.peers.values()) {
      if (entry.channel === excludeChannel) continue;
      if (entry.channel?.readyState === "open") {
        try { entry.channel.send(JSON.stringify(event)); } catch {}
      }
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  _mkPeerConn() {
    return new RTCPeerConnection({ iceServers: STUN_SERVERS });
  }

  _waitForIceGathering(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const handler = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", handler);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", handler);
      setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", handler);
        resolve();
      }, ICE_GATHERING_TIMEOUT);
    });
  }

  _rememberId(id) {
    this.recentIds.add(id);
    if (this.recentIds.size > RECENT_ID_CAP) {
      const first = this.recentIds.values().next().value;
      this.recentIds.delete(first);
    }
  }
}
