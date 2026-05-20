// Cockroach Relay — reference WebSocket relay (L1 conformance).
// Run: bun run server.ts
// Env: PORT (default 7447), DB (default ./relay.db), RETENTION_DAYS (default 90)

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import {
  validateEvent,
  matchesFilter,
  type SignedEvent,
  type Filter,
} from "./lib.ts";

// ──────────────────────────────────────────────────────────────────────────
// Default paths (compiled-binary friendly)
//
// Distributed as a standalone executable, the relay may be double-clicked
// from Finder/Explorer, which sets cwd=/ on macOS — writing to "./relay.db"
// would fail.  Use ~/.cockroach-relay/relay.db as a robust default; the DB
// env var still overrides for explicit setups (Docker volumes, Fly mounts).
function defaultDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    const dir = `${home}/.cockroach-relay`;
    try { mkdirSync(dir, { recursive: true }); } catch { /* fall through */ }
    return `${dir}/relay.db`;
  }
  return "./relay.db";
}

// ──────────────────────────────────────────────────────────────────────────
// Permalink rendering (shareable HTML page per event, with OG tags)

const OG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#0a0a0a"/>
  <g transform="translate(420,115) scale(2)" fill="#f97316" stroke="#f97316" stroke-width="5" stroke-linecap="round">
    <ellipse cx="100" cy="115" rx="40" ry="60" stroke="none"/>
    <ellipse cx="100" cy="55" rx="22" ry="18" stroke="none"/>
    <path d="M 88 42 Q 70 18 50 14" fill="none"/>
    <path d="M 112 42 Q 130 18 150 14" fill="none"/>
    <path d="M 65 90  Q 35 80 18 60" fill="none"/>
    <path d="M 60 120 Q 28 122 12 110" fill="none"/>
    <path d="M 65 150 Q 38 162 26 178" fill="none"/>
    <path d="M 135 90  Q 165 80 182 60" fill="none"/>
    <path d="M 140 120 Q 172 122 188 110" fill="none"/>
    <path d="M 135 150 Q 162 162 174 178" fill="none"/>
  </g>
  <text x="600" y="540" text-anchor="middle" fill="#f4f4f5" font-family="system-ui,sans-serif" font-size="44" font-weight="700">cockroach</text>
  <text x="600" y="585" text-anchor="middle" fill="#9ca3af" font-family="system-ui,sans-serif" font-size="22">a public network for civic signal</text>
</svg>`;

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function attrEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function renderPermalinkHTML(ev: SignedEvent, origin: string): string {
  const content = (ev.content || "").trim();
  const tags = ev.tags.filter((t) => t[0] === "t").map((t) => t[1]);
  const geo = ev.tags.find((t) => t[0] === "g")?.[1] || "";
  const media = ev.tags.filter((t) => t[0] === "media");
  const time = new Date(ev.created_at * 1000).toISOString();
  const author = ev.pubkey.slice(0, 16);

  const titleSnippet = content.length > 80 ? content.slice(0, 77).trim() + "…" : content;
  const description = (tags.length ? "#" + tags.join(" #") : "") +
    (geo ? (tags.length ? " · " : "") + geo : "");

  // Use the first http(s) URL of the first media tag as og:image; otherwise the brand SVG.
  let ogImage = `${origin}/og.svg`;
  if (media.length) {
    const urls = media[0].slice(2).filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
    if (urls.length) ogImage = urls[0];
  }

  const kindLabel = ev.kind === 1 ? "civic report" : ev.kind === 2 ? "verification" : `kind ${ev.kind}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(titleSnippet || "Cockroach " + kindLabel)}</title>
  <meta name="description" content="${attrEscape(description || "Signed civic report on the Cockroach Relay network.")}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${attrEscape(titleSnippet || "Cockroach " + kindLabel)}">
  <meta property="og:description" content="${attrEscape(description || "Signed civic report on the Cockroach Relay network.")}">
  <meta property="og:image" content="${attrEscape(ogImage)}">
  <meta property="og:url" content="${attrEscape(origin + "/r/" + ev.id)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#0a0a0a">
  <link rel="icon" href="/og.svg" type="image/svg+xml">
  <style>
    *{box-sizing:border-box}
    body{margin:0;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;background:#0a0a0a;color:#f4f4f5;-webkit-font-smoothing:antialiased}
    main{max-width:680px;margin:0 auto;padding:32px 20px}
    header{display:flex;align-items:center;gap:10px;margin-bottom:28px}
    header svg{width:32px;height:32px;color:#f97316}
    header b{font-weight:700}
    .card{background:#111;border:1px solid #27272a;border-radius:14px;padding:22px}
    .meta{font-size:13px;color:#9ca3af;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    .meta .pub{font-family:ui-monospace,monospace}
    .meta .kind{background:#1f1f22;padding:3px 10px;border-radius:999px;font-size:12px;color:#f4f4f5}
    .content{white-space:pre-wrap;word-wrap:break-word;margin:14px 0;font-size:17px;line-height:1.55}
    .tags{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
    .tags span{background:#1f1f22;color:#cbd5e1;padding:3px 10px;border-radius:999px;font-size:12px}
    .media{margin:16px 0}
    .media img{max-width:100%;height:auto;border-radius:10px;border:1px solid #27272a}
    .ids{font-family:ui-monospace,monospace;font-size:11px;color:#71717a;word-break:break-all;margin-top:16px;line-height:1.6}
    .ids b{color:#a1a1aa;font-weight:600}
    .cta{margin-top:24px;display:flex;flex-wrap:wrap;gap:10px}
    .cta a{display:inline-block;padding:11px 18px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px}
    .cta .primary{background:#f97316;color:#0a0a0a}
    .cta .ghost{background:transparent;color:#f4f4f5;border:1px solid #27272a}
    footer{margin-top:36px;color:#71717a;font-size:13px;text-align:center;line-height:1.6}
    footer a{color:#a1a1aa}
  </style>
</head>
<body>
  <main>
    <header>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <ellipse cx="100" cy="115" rx="40" ry="60" fill="currentColor"/>
        <ellipse cx="100" cy="55" rx="22" ry="18" fill="currentColor"/>
      </svg>
      <b>cockroach</b>
      <span style="color:#71717a">·</span>
      <span style="color:#9ca3af">${htmlEscape(kindLabel)}</span>
    </header>

    <div class="card">
      <div class="meta">
        <span class="kind">${htmlEscape(kindLabel)}</span>
        <span class="pub" title="${attrEscape(ev.pubkey)}">${htmlEscape(author)}…</span>
        ${geo ? `<span>· <code style="font-family:ui-monospace,monospace">${htmlEscape(geo)}</code></span>` : ""}
        <span>· <time datetime="${attrEscape(time)}">${htmlEscape(time)}</time></span>
      </div>

      <div class="content">${htmlEscape(content) || "<em style='opacity:0.6'>(no description)</em>"}</div>

      ${tags.length ? `<div class="tags">${tags.map((t) => `<span>#${htmlEscape(t)}</span>`).join("")}</div>` : ""}

      ${media.length ? `<div class="media">${media.map((m) => {
        const url = m.slice(2).find((u) => typeof u === "string" && /^https?:\/\//.test(u));
        return url ? `<img src="${attrEscape(url)}" alt="">` : "";
      }).join("")}</div>` : ""}

      <div class="ids">
        <div><b>event id</b> ${htmlEscape(ev.id)}</div>
        <div><b>pubkey</b> ${htmlEscape(ev.pubkey)}</div>
        <div><b>sig</b> ${htmlEscape(ev.sig)}</div>
      </div>
    </div>

    <div class="cta">
      <a class="primary" href="/">About this relay</a>
      <a class="ghost" href="https://github.com/hemant1996/thecockroachnetwork">Use a client</a>
    </div>

    <footer>
      This is a static rendering of a signed event served by one relay. The event itself is portable — copy the event id and any other relay holding it serves the same content.<br>
      <a href="/policy">Relay policy</a> &nbsp;·&nbsp; <a href="https://github.com/hemant1996/thecockroachnetwork">Protocol</a>
    </footer>
  </main>
</body>
</html>`;
}


// ──────────────────────────────────────────────────────────────────────────
// Config

const PORT = Number(process.env.PORT ?? 7447);
const DB_PATH = process.env.DB ?? defaultDbPath();
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 90);
const MAX_SUBS_PER_CONN = 64;
const MAX_FILTERS_PER_REQ = 10;
const DEFAULT_LIMIT = 500;

// ──────────────────────────────────────────────────────────────────────────
// Storage

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    pubkey      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    kind        INTEGER NOT NULL,
    raw         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_pubkey       ON events(pubkey);
  CREATE INDEX IF NOT EXISTS idx_events_kind         ON events(kind);
  CREATE INDEX IF NOT EXISTS idx_events_created_at   ON events(created_at);

  CREATE TABLE IF NOT EXISTS tags (
    event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    value       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tags_name_value     ON tags(name, value);
  CREATE INDEX IF NOT EXISTS idx_tags_event_id       ON tags(event_id);
`);

const insertEventStmt = db.prepare(
  "INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, raw) VALUES (?, ?, ?, ?, ?)"
);
const insertTagStmt = db.prepare(
  "INSERT INTO tags (event_id, name, value) VALUES (?, ?, ?)"
);

function storeEvent(e: SignedEvent): boolean {
  const tx = db.transaction(() => {
    const r = insertEventStmt.run(e.id, e.pubkey, e.created_at, e.kind, JSON.stringify(e));
    if ((r.changes as number) === 0) return false;
    for (const t of e.tags) {
      if (t.length >= 2 && t[0].length === 1) insertTagStmt.run(e.id, t[0], t[1]);
    }
    return true;
  });
  return tx() as boolean;
}

// Build a SQL query from a filter (best-effort indexed; full match re-checked in JS).
function queryEvents(filters: Filter[]): SignedEvent[] {
  const results = new Map<string, SignedEvent>();
  for (const f of filters) {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.kinds?.length) {
      where.push(`kind IN (${f.kinds.map(() => "?").join(",")})`);
      params.push(...f.kinds);
    }
    if (f.since !== undefined) { where.push("created_at >= ?"); params.push(f.since); }
    if (f.until !== undefined) { where.push("created_at <= ?"); params.push(f.until); }
    if (f.authors?.length) {
      where.push("(" + f.authors.map(() => "pubkey LIKE ?").join(" OR ") + ")");
      params.push(...f.authors.map((a) => a + "%"));
    }
    if (f.ids?.length) {
      where.push("(" + f.ids.map(() => "id LIKE ?").join(" OR ") + ")");
      params.push(...f.ids.map((a) => a + "%"));
    }
    // For each #x filter, intersect with a subquery on tags.
    const tagFilters: { name: string; values: string[] }[] = [];
    for (const k of Object.keys(f)) {
      if (k.length === 2 && k.startsWith("#")) {
        const vals = (f as Record<string, string[] | undefined>)[k];
        if (vals && vals.length) tagFilters.push({ name: k[1], values: vals });
      }
    }
    for (const tf of tagFilters) {
      if (tf.name === "g") {
        where.push(
          `id IN (SELECT event_id FROM tags WHERE name='g' AND (${tf.values.map(() => "value LIKE ?").join(" OR ")}))`
        );
        params.push(...tf.values.map((v) => v + "%"));
      } else {
        where.push(
          `id IN (SELECT event_id FROM tags WHERE name=? AND value IN (${tf.values.map(() => "?").join(",")}))`
        );
        params.push(tf.name, ...tf.values);
      }
    }
    const limit = Math.min(f.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT);
    const sql =
      "SELECT raw FROM events" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = db.query(sql).all(...params) as { raw: string }[];
    for (const row of rows) {
      const ev = JSON.parse(row.raw) as SignedEvent;
      if (matchesFilter(ev, f)) results.set(ev.id, ev);
    }
  }
  return [...results.values()].sort((a, b) => b.created_at - a.created_at);
}

function purgeOld() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  db.run("DELETE FROM events WHERE created_at < ?", [cutoff]);
}
setInterval(purgeOld, 3600_000);
purgeOld();

// ──────────────────────────────────────────────────────────────────────────
// Subscriptions

interface Sub { filters: Filter[]; }
interface ConnState { subs: Map<string, Sub>; }
const conns = new WeakMap<WebSocket, ConnState>();

function broadcast(e: SignedEvent) {
  for (const ws of liveSockets) {
    const state = conns.get(ws as unknown as WebSocket);
    if (!state) continue;
    for (const [subId, sub] of state.subs) {
      if (sub.filters.some((f) => matchesFilter(e, f))) {
        try { ws.send(JSON.stringify(["EVENT", subId, e])); } catch { /* ignore */ }
      }
    }
  }
}

const liveSockets = new Set<any>();

// ──────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket server

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    // WebSocket upgrade must be checked before any other handling, since the
    // upgrade request also arrives at "/".
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (srv.upgrade(req)) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(JSON.stringify({
        name: "cockroach-relay",
        version: "0.1.0",
        spec: "https://github.com/hemant1996/thecockroachnetwork/blob/main/SPEC.md",
        retention_days: RETENTION_DAYS,
      }, null, 2), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/og.svg") {
      return new Response(OG_SVG, {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
      });
    }
    if (url.pathname.startsWith("/r/")) {
      const id = url.pathname.slice(3);
      if (!/^[0-9a-f]{64}$/.test(id)) return new Response("invalid event id", { status: 400 });
      const row = db.query("SELECT raw FROM events WHERE id = ?").get(id) as { raw: string } | undefined;
      if (!row) return new Response("not found on this relay — try another", { status: 404 });
      const ev = JSON.parse(row.raw) as SignedEvent;
      return new Response(renderPermalinkHTML(ev, url.origin), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      conns.set(ws as unknown as WebSocket, { subs: new Map() });
      liveSockets.add(ws);
    },
    close(ws) {
      conns.delete(ws as unknown as WebSocket);
      liveSockets.delete(ws);
    },
    message(ws, raw) {
      let msg: unknown;
      try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array)); }
      catch { ws.send(JSON.stringify(["NOTICE", "invalid JSON"])); return; }
      if (!Array.isArray(msg) || typeof msg[0] !== "string") {
        ws.send(JSON.stringify(["NOTICE", "invalid message"])); return;
      }
      const state = conns.get(ws as unknown as WebSocket)!;
      const verb = msg[0];

      if (verb === "EVENT") {
        const result = validateEvent(msg[1]);
        if (!result.ok) {
          const id = (msg[1] as { id?: string })?.id ?? "";
          ws.send(JSON.stringify(["OK", id, false, result.reason]));
          return;
        }
        const stored = storeEvent(result.event);
        ws.send(JSON.stringify(["OK", result.event.id, true, stored ? "" : "duplicate: ok"]));
        if (stored) broadcast(result.event);
        return;
      }

      if (verb === "REQ") {
        const subId = msg[1];
        if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) {
          ws.send(JSON.stringify(["NOTICE", "invalid sub id"])); return;
        }
        const filters = msg.slice(2) as Filter[];
        if (!filters.length || filters.length > MAX_FILTERS_PER_REQ) {
          ws.send(JSON.stringify(["NOTICE", "bad filter count"])); return;
        }
        if (state.subs.size >= MAX_SUBS_PER_CONN && !state.subs.has(subId)) {
          ws.send(JSON.stringify(["NOTICE", "too many subscriptions"])); return;
        }
        state.subs.set(subId, { filters });
        const stored = queryEvents(filters);
        for (const e of stored) ws.send(JSON.stringify(["EVENT", subId, e]));
        ws.send(JSON.stringify(["EOSE", subId]));
        return;
      }

      if (verb === "CLOSE") {
        const subId = msg[1];
        if (typeof subId === "string") state.subs.delete(subId);
        return;
      }

      ws.send(JSON.stringify(["NOTICE", `unknown verb: ${verb}`]));
    },
  },
  });
} catch (e: any) {
  if (e?.code === "EADDRINUSE") {
    console.error("");
    console.error(`  ✗ Port ${PORT} is already in use.`);
    console.error("");
    console.error(`    Try a different port: PORT=7448 ./cockroach-relay`);
    console.error("");
  } else {
    console.error("✗ Failed to start:", e?.message ?? e);
  }
  process.exit(1);
}

console.log("");
console.log("  cockroach-relay v0.1.0 running");
console.log("");
console.log(`  WebSocket:  ws://localhost:${server.port}`);
console.log(`  Info:       http://localhost:${server.port}/`);
console.log(`  Database:   ${DB_PATH}`);
console.log(`  Retention:  ${RETENTION_DAYS} days`);
console.log("");
console.log("  Press Ctrl+C to stop.");
console.log("");
