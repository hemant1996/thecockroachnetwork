# Changelog

All notable changes to the Cockroach Relay Protocol and its reference implementations are documented here.

The format follows the spirit of [Keep a Changelog](https://keepachangelog.com). The protocol versioning policy is in [SPEC.md §11](SPEC.md#11-forward-compatibility): new event kinds and new tag names are additive; only changes to the event format, signing rules, or wire verbs bump the major version.

## v0.7.7 — "Hindi" mode is now actually Hinglish (Roman script) (2026-05-22)

The `hi` language bundle was full of Devanagari (क्या टूटा है?, रिपोर्ट, फ़ीड, पहचान, etc.). Most of the audience reads and *types* Hindi in Roman letters on a phone — Devanagari is a register switch they rarely use casually. The intent was always Hinglish.

### Bundle rewrite (`client/lang/hi.json`)

Every value converted from Devanagari to Roman-script Hinglish:

| Key | Was | Now |
|---|---|---|
| `tab.compose` | `रिपोर्ट` | `Report` |
| `tab.feed` | `फ़ीड` | `Feed` |
| `tab.identity` | `पहचान` | `Pehchaan` |
| `compose.what_broken` | `क्या टूटा है?` | `Kya tuta hai?` |
| `compose.tags_label` | `टैग` | `Tags` |
| `compose.add_tag_placeholder` | `टैग लिखें और एंटर दबाएँ` | `tag likhiye aur enter dabaiye` |
| `compose.get_gps` | `GPS स्थान लें` | `GPS lijiye` |
| `compose.privacy_note` | `कम सटीकता = ज़्यादा निजता…` | `Kam sateekta = zyada privacy…` |
| `compose.publish` | `साइन करके भेजें` | `Sign karke bhejiye` |
| `verdict.true` / `verdict.fake` | `सही` / `झूठा` | `sahi` / `jhutha` |
| `verdict.request_evidence` | `सबूत माँगें` | `sabut maango` |
| `feed.your_weight` | `यहाँ आपका भार` | `yahan aapka weight` |
| `feed.new_here` | `नया इलाक़ा` | `naya ilaaka` |
| `identity.your_identity` | `आपकी पहचान` | `Aapki pehchaan` |
| `identity.relays` | `रिले` | `Relays` |
| `identity.about` | `बारे में` | `Baare mein` |
| `identity.privacy` | `निजता` | `Privacy` |
| `identity.language` | `भाषा` | `Bhasha` |
| `lang.hindi` | `हिन्दी` | `Hinglish` |

All ~30+ Hinglish/Devanagari mixed strings rewritten in pure Roman script. The bundle key stays `hi` (so browser locale matching still works) but the `_note` at the top now explicitly explains the bundle is Hinglish.

### Lang button label

The toggle pill went from `हिं · EN` to `Hin · EN`. Same change in the landing's `<button id="lang-hi">` — was `हिं`, now `Hin`. The landing's bilingual `.hi` spans were already Roman-script — no changes needed there.

### Identity tab language card

| Field | Before | After |
|---|---|---|
| Description | "Switch the interface between English and हिन्दी." | "Switch the interface between English and Hinglish (Hindi in Roman letters — the way most people actually type Hindi on a phone)." |
| Dropdown option | `<option>हिन्दी</option>` | `<option>Hinglish</option>` |
| en.json `lang.hindi` value | `हिन्दी` | `Hinglish` |

### Versions

- Client brand chip + about-card footer `v0.7.6 → v0.7.7`.
- Landing hero pill `v0.7.6 → v0.7.7`.
- Service-worker cache key `v076 → v077`.

Verified at desktop: switching to Hinglish mode shows `REPORT · FEED · PEHCHAAN` tabs, `KYA TUTA HAI?` composer label, `GPS LIJIYE` button, `Aapki pehchaan / Relays / Baare mein / Privacy / Bhasha` Identity headings — zero Devanagari anywhere on screen.

VERSION → 0.7.7.

## v0.7.6 — no name on the topbar + no auto-geolocation prompt (2026-05-22)

Two fixes pulled directly from user feedback after v0.7.5.

### Topbar no longer shows my GitHub username

The slim "Open source · CC0 public domain · github.com/hemant1996/thecockroachnetwork →" strip exposed my username on every page load. The repo is open-source and CC0 — the *handle* isn't the point. Stripped the visible URL across all three pages while keeping the `href` targets unchanged:

| Where | Before | After |
|---|---|---|
| Landing topbar | `· github.com/hemant1996/thecockroachnetwork` | `· Source on GitHub` |
| Client topbar | (same) | `· Source on GitHub` |
| `build/` topbar | `github.com/hemant1996/thecockroachnetwork` | `Source on GitHub` |
| `build/` primary action subtitle | `github.com/hemant1996/thecockroachnetwork — spec, reference relay …` | `Spec, reference relay, reference client, deploy templates — all CC0 public domain on GitHub.` |
| `build/` "Fork" section CTA | `github.com/hemant1996/thecockroachnetwork →` | `Open the source on GitHub →` |

Mobile bug caught while testing: at <640 px the `.long` span was hiding ` · CC0 public domain · ` but left "Open source" and "Source on GitHub" smushed together with no separator. Fixed by wrapping the entire lead-in (including "Open source") in `.long` so mobile shows just `Source on GitHub` cleanly.

### No more geolocation prompt on first page load

A brand-new visitor opening the client triggered the browser's "allow location?" dialog immediately. That's terrible — they haven't even seen what the site does, much less indicated any intent to share location. Privacy-by-default rule: the geolocation prompt only fires in response to a deliberate user action.

The three boot paths that called `fetchLocation()` implicitly:

| Path | Behavior before | Behavior now |
|---|---|---|
| `showScreen("compose"); refreshGeo()` at boot | Prompted immediately on first load | Removed. No prompt until the user does something that needs location. |
| `precSel.addEventListener("change", refreshGeo)` (precision dropdown) | Prompted when user picked a precision pill | If a fix already exists, re-encode at the new precision. Otherwise just re-render the live preview — no prompt. |
| `precision-grid` click handler | (same as above — would prompt) | Same fix — only re-encode if `lastFix` exists. |

What still prompts (correctly — these are deliberate actions):

- Clicking the `get GPS fix` button.
- Clicking `Sign and publish` without a fix (location is `REQUIRED` on `kind:1` per SPEC §3.2 — if no fix, we ask once, then publish; if denied, we toast and abort).

### Versions

- Client brand chip `v0.7.5 → v0.7.6`, about-card footer same.
- Landing hero pill `v0.7.4 → v0.7.6`.
- Service-worker cache key `v075 → v076`.

VERSION → 0.7.6.

## v0.7.5 — mobile overflow fix + always-on lang pill + share-the-network UX (2026-05-22)

### Mobile overflow — the blocker

Long post content (the seeded CJI declaration in particular) was forcing the page wider than the viewport on mobile Safari. The cause: grid + flex children default to `min-width: auto` which lets intrinsic content size dictate width. The fix is two-part — `min-width: 0` on every grid/flex child at mobile, plus `overflow-wrap: anywhere` on the content blocks so long unbroken text can break at any character. Also `overflow-x: hidden` on `html, body` as a safety net.

Verified: the seeded CJI report now wraps cleanly in a 390 px viewport — every line stays inside the card, no horizontal scroll, no clipped text.

### Always-visible language toggle

The Hindi/English switch was buried in Identity. Moved into the app-bar as a `[हिं · EN]` pill chip next to the relay/peer status — same visual pattern the landing page uses. Click flips `LANG_STORAGE` and reloads so every translated string updates from the freshly-loaded bundle.

### Tell another cockroach — share UX

The site had a per-card `↗ share` button but no clear "share the network itself" surface, and no copy explaining how sharing works. v0.7.5 adds a full-width accent-bordered card on the Identity tab:

- **Headline**: `Tell another cockroach` / `Doosre cockroach ko bataiye`
- **Body**: explains the link works without sign-up — anyone who opens it is in.
- **How sharing works (Instrument Serif italic)**: every report has its own permalink (the existing per-card `↗ share` button); the whole network has one address (`thecockroachnetwork.com`); both work.
- **📲 Get share link** primary CTA — uses the Web Share API when available, falls back to clipboard copy + toast.
- **↗ Share on WhatsApp** secondary link — pre-fills the message text.

i18n strings added for both languages (`share.tell_friend`, `share.tell_friend_blurb`, `share.tell_friend_how`, `share.tell_friend_btn`, `share.tell_friend_text`, `share.send_whatsapp`, `share.tell_friend_copied`).

### Other stale-data fixes caught in the same pass

- `client/index.html` about-card footer: `COCKROACH V0.2 · CC0 ...` (stale by 5 versions) → `V0.7.5`.
- `client/lang/en.json` compose placeholder: "in-app upload lands in v0.2" (shipped in v0.5) → describes the photo attach button.
- `client/lang/hi.json` compose placeholder: same stale "v0.2 mein aayega" claim → rewritten in Hinglish.
- Client brand chip `v0.7.4` → `v0.7.5`.
- Service-worker cache key `v074` → `v075`.

VERSION → 0.7.5.

## v0.7.4 — open-source topbar + stale-data sweep (2026-05-22)

A sweep of the whole repo for stale references, broken links, and pages still on the v0.4 mental model — plus a slim sticky announcement bar across the landing + client that says "we are open source, here is the repo."

### Top announcement bar (landing + client)

- 36 px sticky bar at the very top of the page: `★ Open source · CC0 public domain · github.com/hemant1996/thecockroachnetwork →`.
- Dismissible with a × button. State persists in `sessionStorage` (clears on tab close) so returning visitors aren't nagged within a session but get reminded across sessions.
- When dismissed, the sticky nav (landing) / app-bar (client) slides back up to `top: 0` and the feed-side / preview / rail sticky positions also rewind from 132 px to 96 px.
- Mobile (<640 px): hides the "· CC0 public domain ·" middle segment so the link still fits without wrapping.
- Pre-paint script reads the sessionStorage flag and adds a class on `<html>` before the first render so the page doesn't flash the bar at returning visitors.

### Stale-reference sweep

| File | Was | Now |
|---|---|---|
| `README.md` line 19 | `Current version (0.4.1)` | `Current version (0.7.4)` |
| `README.md` § Status | block locked on v0.4.1 with claims like "no in-client media upload" (false since v0.5) | full version list v0.1 → v0.7 with one-line summaries; known-limits block rewritten for v0.7 (encrypted key backup still TODO, native apps still TODO, SPEC §8.1 multiplier on consensus still TODO) |
| `client/index.html` "Source on GitHub" link | `hemantbangar/cockroachparty` (wrong repo from a v0.6 typo) | `hemant1996/thecockroachnetwork` (canonical) |
| `client/README.md` privacy section | "client strips no media metadata in v0.1 because it does not yet handle media uploads" (stale since v0.5) | accurate description of v0.5+ canvas re-encode + EXIF drop + SHA-256 binding |
| `build/index.html` SPEC summary | "v0.2 WebRTC mesh kinds (10001/10002/10003)" — single-feature snapshot | broader summary mentioning the v0.7 verdict split, the peer-mesh kinds, and locality-weighted rep |
| `client/index.html` brand chip | `v0.7.3` | `v0.7.4` |
| `client/sw.js` cache key | `cockroach-shell-v3` | `cockroach-shell-v074` — also added `verdicts.js` + `media.js` to the precache (they were missing) |
| `index.html` hero pill | `v0.7.1 · janta ka network` | `v0.7.4 · janta ka network` |

### Hyperlink audit

All `href=` and `[text](url)` references across `*.html` and `*.md` re-grepped. Internal links (`SPEC.md`, `WHITEPAPER.md`, `relay/RUN.md`, `client/`) resolve. External links (`github.com/hemant1996/thecockroachnetwork/...`, `render.com/deploy`, `replit.com`, font CDNs, CC0 license) are all correct. The single drift was the `hemantbangar/cockroachparty` URL in the client's Identity-tab "Source on GitHub" button — now fixed.

Verified at 1480×900 and 390×900 across landing + client. No console errors. Dismiss button works; refreshing the page keeps the bar dismissed within the session.

VERSION → 0.7.4.

## v0.7.3 — mobile fix: sort + filter no longer fight the viewport (2026-05-22)

The v0.7 feed sidebar (Sort list + Filter chips) was sized for desktop; at mobile it collapsed into a side-by-side row that crammed both into a narrow column, wrapping the filter chips into a multi-line wall and squeezing the sort list into a vertical strip. This rewrites the mobile pattern entirely.

### Mobile feed (<820px)

- Sort list flips from a vertical column to a **horizontal scrollable pill row** (matching the chip aesthetic everywhere else in the design — `border-radius: 99px`, accent fill on the active item).
- Filter chips switch to **horizontal scroll** (no-wrap) instead of multi-line wrap.
- Both strips are full-width, stacked vertically, with their own small `<h5>` label. Scrollbars are hidden (`scrollbar-width: none`).
- Card density at mobile: padding 16/18 → 14/14, content 15px → 14px, closure badge 11px → 10px, verdict buttons 11px → 10px, media `max-height` 240px → 220px.
- Panel title 38px → 30px on mobile, 26px at <480px.
- App-bar tabs scroll horizontally if needed; status chips tighten to 10px.
- `<480px`: the `v0.7.x` chip in the brand hides (saves ~50px of header width on the smallest phones).

### Other small things

- `nav.tabs` overflow now hides the scrollbar visually but stays scrollable on touch.
- Identity cards tighten on mobile: padding 24 → 18, headings 22 → 18.
- Composer padding 22 → 18 on mobile so the textarea has more usable width.
- Sign-row stacks vertically on mobile with `gap: 14px` so the big sign button has breathing room.

Verified at 390×900 and 1480×900 — feed, report, identity all clean.

VERSION → 0.7.3.

## v0.7.2 — density pass + seed reports + honest placeholders (2026-05-22)

Three small things that came up the moment v0.7.1 went live.

### Density pass on the feed

The post image was eating the card and the hero title (56px) was over-dramatic for a content app. Tightened:

- `panel-title h1` 56px → 38px; `kicker` 11px → 10px; sub 18px → 15px
- Media `max-height` 360px → 240px, capped at `max-width: 360px` (no more full-column hero images)
- Card padding 20px 22px → 16px 18px; content font 16px → 15px; line-height 1.55 → 1.5
- Closure badge padding 10px 14px → 7px 11px; gap 12 → 10
- Verdict buttons 8px 16px → 6px 12px; share/attach/actions all 6px 11px
- `feed-list` gap 14 → 16 (more breathing room *between* cards)
- Feed-layout columns 240/720/280 → 200/640/260 — center column tighter
- `main` 1480px → 1320px, padding 40px 32px 96px → 28px 28px 64px

Three full cards fit comfortably on a 900px viewport now.

### Seed reports — including the project's founding signal

`relay/scripts/seed-reports.ts` is a small Bun script that signs and publishes a starter set of civic reports across all three live relays. Each report uses a fresh ed25519 key so the feed shows multiple voices, not one author. Topics match the existing tag vocabulary: a *main bhi cockroach* declaration (the project's founding signal), road, paperleak, election, harassment, ghosted/coaching, electricity, water. Geographies span Delhi, Nagpur, Patna, Hardoi, Mumbai, Kota, Gurugram, Andheri. Ages are spread under 24h so relays don't reject for clock-skew per SPEC §3.1.

Run: `cd relay && bun run scripts/seed-reports.ts`. Use `--skip=0,1,6` to skip specific indexes on a partial-success rerun.

### Honest placeholders on the landing page

A few hardcoded "we have 1 Pehredaar" / "v0.4" strings from earlier days were still showing on first paint before the live relay-info poll resolved. Replaced with neutral placeholders:

- Hero eyebrow `v0.4` → `v0.7.1` (now matches what's actually deployed)
- Tape marquee `1 public Pehredaar live` → `— Pehredaar live` (JS fills in)
- Pehredaar headline `Sirf ek / Only one Pehredaar alive` → `… Pehredaar alive` (JS fills in)
- Alarm-box stat `01` → `—` (JS fills in)
- Client brand chip `v0.7.1` → `v0.7.2`

A visitor with slow JS or a relay-info hiccup now sees an obviously-unset value instead of stale-looking numbers from an older epoch.

VERSION → 0.7.2.

## v0.7.1 — scale-safe feed + the give-proof flow (2026-05-22)

Two issues surfaced post-ship that v0.7.0 left half-done. Both fixed in one patch — no protocol change, no relay change.

### Feed wouldn't survive scale

`renderFeed()` re-filtered the global event arrays for every card on every render. At ~1k reports × 10k events that's tens of millions of ops per render — mid-second jank on mobile. At 10k × 100k it freezes the tab for multiple seconds.

**Fix: index-on-ingest.** Five new Maps populated as events arrive — `truthByReport`, `statusByReport`, `evidenceByReport`, `relationsBySource`, `evidenceAttachByReport`, plus a `myReportsByCell` counter and a `verifierByCell` Set. Per-card lookups go from O(M) to O(1). Out-of-order delivery handled by a pending-verifiers Map that flushes when the parent `kind:1` lands.

`renderFeed` now uses fast-accessor wrappers (`truthCountsFast`, `latestStatusFast`, etc.) that read from the indexes instead of filtering. The pure helpers in `verdicts.js` stay the source of truth; the wrappers are just the performance path. Same outputs, dramatically faster.

**Also: visible-cap.** Default 50 cards rendered, plus a `load more · N remaining` button at the bottom. Sort/filter changes reset the cap. Keeps the DOM cost bounded regardless of network size.

### The "give proof" path was missing

v0.7.0 added `↺ asking proof` (kind:4) but had no UI to *answer* it. Someone asked for proof, the badge updated, and the loop dead-ended.

**Fix: evidence-reply composer.** A new `↳ attach evidence` button on every card (and in the `⋯ more` menu) stashes the parent report id and switches to the Report tab. A red-accented banner above the composer reads `↳ attaching evidence to #abcd · [× cancel]`. Publishing appends `["e", parent, "evidence"]` to the new `kind:1` event per SPEC §4.2.6. After publish the parent id clears.

Inline rendering: evidence-attachment replies are hidden from the top-level feed and render as a small thread under the parent card. The closure badge counts them via `▸ N evidence`. The full reply flow now has an answer.

### Files

- `client/app.js` — index Maps + ingest routing + fast accessors + `renderCard` extraction + `evidenceReplyTo` state + click handlers (`load-more`, `attach-evidence`, `evidence-cancel`).
- `client/index.html` — `#evidence-banner` markup, brand chip → `v0.7.1`.
- `client/styles.css` — `.evidence-banner`, `.evidence-thread`, `.evidence-reply`, `.attach-btn`, `.load-more`.
- `client/lang/en.json`, `client/lang/hi.json` — `verdict.attach_evidence`, `feed.load_more`, `feed.remaining`.

### Dev probe

Added a `window.lastFix` getter/setter on localhost only so headless QA can stub a GPS fix without the geolocation permission prompt. No-op on the production host.

### Operator action required

None.

VERSION → 0.7.1.

## v0.7.0 — verdict honesty + ranking that matters (2026-05-22)

The v0.6 five-verdict row (`true / fake / needs-more-proof / duplicate / resolved`) mashed three different questions into one mutually-exclusive click — *is the claim true?* *is the issue resolved?* *is this a copy?* — which trapped reports in "needs-more-proof" purgatory and made consensus math lose information. A skeptic clicking "needs proof" would silently drown out three honest "true" voters; reports stuck at "needs proof" had no defined path to resolution; "resolved" and "duplicate" weren't truth claims at all.

v0.7 splits the model into orthogonal axes. Each event kind answers one question. A voter may simultaneously hold a `true` truth-verdict, a `resolved` status, an outstanding evidence-request, and a duplicate-of relation on the same report — none of them compete.

### Wire format (SPEC §4.2)

| Kind | Purpose | Dedupe key |
|---|---|---|
| `2` truth-verdict | `v` ∈ {`true`, `fake`}. Binary. | `(pubkey, e-tag, v-tag)` |
| `3` status | `status` ∈ {`resolved`, `reopened`} | `(pubkey, e-tag)` |
| `4` evidence-request | A question, not a verdict | `(pubkey, e-tag)` |
| `5` relation | `rel` ∈ {`duplicate-of`, `continuation-of`} with two `e` tags | `(pubkey, e-source, rel, e-target)` |

Retraction (kind:2 only): republish with the same `(e, v)` plus `["state","retracted"]`. Status reverses by publishing `kind:3 status=reopened` after a `kind:3 status=resolved`.

**Legacy translation (§4.2.6).** Pre-v0.7 clients published all five outcomes as `kind:2`. v0.7+ clients translate at ingestion: `v=needs-more-proof` → local-only `kind:4`, `v=resolved` → local-only `kind:3`, `v=duplicate` → discarded (no target id to interpret as a relation). Translated events are NOT re-broadcast. v0.7+ clients publish only the new forms. The translation block can be removed in a future revision after a deprecation window.

### What you actually see (UI)

- **Closure-absence badge** is now the headline line on every card: `[consensus pill] ✓ N · ✗ M · ↺ K asking proof · ▸ J evidence · Xd open` — or `▣ resolved by #abcd` once resolved. Old confirmed-and-unresolved reports are immediately visible as the most important thing on screen.
- **Verdict row** is binary `✓ true / ✗ fake` toggles with an `⋯ more` overflow menu for *request evidence* / *mark duplicate of…* / *mark resolved*. Each truth button independently fills when cast and retracts when re-clicked.
- **Voter weight (SPEC §8.3)** is surfaced on every card: `your weight here: N reports` or `your weight here: 0 (new to this area)`. Voting stops being a tribal click and starts being a stake — voters self-select toward places they actually know.
- **Sparse-cell badge (SPEC §8.4)** appears on cards in cells with fewer than 3 distinct verifiers. Honest "low-density area · N/3 verifiers in cell" instead of misleading "awaiting verification" that will never resolve.
- **Sort modes**: `newest` (default), `near you` (geohash prefix-match against your last GPS fix), `most verified` (truth-only count × evidence multiplier — `+0.5` for photo, `+0.3` for specific date/time mention), `unresolved` (unresolved first, then highest truth, then oldest — the fixer view), `needs proof` (most outstanding evidence-requests).

### Client architecture

- **New `client/verdicts.js`** — pure helper module, no DOM, no network, no globals. Exports `translateLegacyVerdict`, `dedupeTruthVerdicts`, `truthCounts`, `truthConsensus`, `latestStatus`, `evidenceRequestCount`, `duplicatesOf`, `myActiveTruth`, `voterLocalReportCount`, `cellVerifierCount`, `geohashMatchLen`, `evidenceMultiplier`. Tested via `client/test/verdicts.test.js` (29 assertions, `bun test`).
- **Per-kind stores in `app.js`** replace the single `verifications` Map: `truthEvents`, `statusEvents`, `evidenceEvents`, `relationEvents`. The kind:1 `events` Map is unchanged.
- **New publish helpers**: `publishTruthVerdict`, `publishStatus`, `publishEvidenceRequest`, `publishRelation`. All route through one `_signAndFanout` that handles ingest + relay fan-out + peer broadcast.
- **Subscription extended** with kinds 3/4/5 (WebRTC signaling subscription unchanged).
- **All ranking computation is client-local on the local event store.** No new shared state, no coordination, no learning. SPEC §8.1's full locality weighting remains a v0.10+ ambition; the v0.7 implementation is the floor: report-count-in-cell as a legibility signal, not a multiplier on consensus.

### What was dropped from the original roadmap

The originally-planned v1.0 feedback loop (track which signals predicted resolutions; tune ranking weights from observed correlations) is dropped. It can't be done simply *and* decentralized at this scale — any "learning" would need shared state across clients. The honest move is to ship the legible signals and let each client weight them; ranking-as-research belongs in a separate project.

### Operator action required

None. The relay code is unchanged. New kinds are additive (SPEC §11) and ignored by relays that don't know them. Pre-v0.7 clients continue to render correctly because v0.7+ clients translate legacy `kind:2` verdicts client-side. Relays do not need redeployment.

VERSION → 0.7.0.

## v0.6.0 — web client redesign: typography, live preview, sort/filter rail (2026-05-22)

A visual-only release. The protocol, signing, relay sync, peer mesh, geohash logic, verification consensus, and in-event media flow from v0.5.0 are unchanged byte-for-byte. The web client now wears the design that was prototyped in the Claude Design handoff and ported to the reference client.

### Added

- **Typography system** — Anton (display), Instrument Serif (italic counterpoint), JetBrains Mono (sigs/keys/labels), Inter (body). Self-hosted via Google Fonts with preconnect.
- **Live preview pane on Report** — sticky right pane that mirrors what gets signed: body text, tags, geohash precision indicator, sig-strip with `kind / pubkey / created / tags / geohash / sig`. Updates on every keystroke, tag toggle, GPS fix, and photo attach.
- **Precision pill grid** — six-pill picker (`9 ~5m` → `4 ~40km`) replacing the dropdown; drives the existing geohash logic.
- **Feed sort + filter sidebar** — sort by newest / most verified / needs proof; filter chips derived from tags present in the live event store.
- **Right rail on Feed** — live relay-mini list, trending-tag leaderboard computed from the last-7-day event window, and a Pehredaar CTA linking to the run-a-relay guide.
- **Keyboard shortcuts** — `1` Report, `2` Feed, `3` Identity, with the standard input-focus guard.
- **Identity grid layout** — 2-column card grid (Relays / Peer Mode / Language / Privacy), full-width Identity and About cards top and bottom; title shows `#<your-shortid>` from the live pubkey.

### Changed

- **Accent color** orange `#f97316` → red `#e63b2e`. Ink `#f4ead5` on bg `#0a0a0a`. The accent cascades to focus rings, primary buttons, status chips, verdict highlights, and the "broken" / "network" emphases in the page titles.
- **Status chips** — header pills now mirror the dot state on their borders (live = green, warn = amber, off = neutral). Both the relay chip and the peer chip read live counts from `pool.connectedCount()` and `peers.status()`.

### Deliberately not adopted from the design mock

The handoff bundle contained a few decorative or regressive elements that would have shipped non-functional UI; they were dropped during the port:

- A hardcoded `npub1c0ck7r…` pseudo-pubkey, `2 relays / 3 peers` counts, and a static feed seed — all replaced with live data.
- A "Photo URL" text input — would have regressed the in-event base64 media flow from v0.5.0. The existing file-attach + auto-compress path is unchanged.
- A header `हिं · EN` lang toggle button — duplicates the Identity-tab language selector which already drives the existing i18n bundle.
- The Claude-Design tweaks panel overlay — a design-tool affordance, not a product feature.

### Files touched

- `client/styles.css` — rewritten around the new design system (~1000 lines).
- `client/index.html` — restructured layout; all functional element IDs and `data-i18n` attributes preserved, so the existing `lang/en.json` and `lang/hi.json` bundles keep working.
- `client/app.js` — added `renderLivePreview`, `renderRail`, `renderFilterChips`, precision-pill ↔ select sync, sort/filter state for the feed, kbd shortcut handler with input guard, sign-row meta wiring. The crypto path, relay pool, peer pool, event store, and verification consensus are untouched.

### Operator action required

None. The wire format is unchanged. Relays do not need redeployment.

VERSION → 0.6.0.

## v0.5.0 — in-event base64 media: photos with zero operator (2026-05-21)

The simpler answer that the Helia / IPFS detour was missing: civic thumbnails fit in 64 KiB if you downscale them, and the protocol already syncs events between relays. So the event itself can carry the photo.

### Added

- **`client/media.js`** — `compressImage(file)` uses the Canvas API to downscale (max 720 px longest edge, dropping to 320 px if needed) and re-encode as JPEG (quality 0.7 → 0.4 in 0.1 steps) until the raw payload fits in 48 KB. Returns `{ dataUrl, sha256, mime, size }`. SHA-256 is computed over the final byte stream so the media tag binding is verifiable (SPEC §7.1).
- **File attach UI in compose** — bare-bones picker that runs `compressImage()`, previews the result, and shows the final size. The bytes go directly into the published event's `media` tag as a `data:image/jpeg;base64,…` URL.
- **Inline render in feed cards** — `renderMediaTags()` accepts `data:`, `http(s):`, and `ipfs:` URLs. Data URLs render instantly (no network call); other schemes fall through standard `<img>` loading.
- **SPEC §7** rewritten to document `data:` URLs as the recommended low-friction transport for thumbnails, with the SHA-256 binding rule restated as §7.1.

### Changed

- **`MAX_EVENT_BYTES`** in the reference relay bumped from 8 KiB → 64 KiB. Was sized for the text-only v0.1-v0.4 era; the new ceiling accommodates one thumbnail per event while still being modest enough that a 200-event feed over mobile stays in single-digit megabytes.
- v0.4's gzip storage compression now applies to media-bearing events too — though JPEG bytes are already entropy-dense so the savings are modest (a few %).

### Why this beat the IPFS path

The Helia / IPFS browser approach (v0.2.4) was fundamentally fighting two things at once: ESM CDN brittleness and the IPFS DHT bootstrap difficulty. The fixed cost was high (hundreds of KB of libp2p, flaky in real browsers) and the variable cost (anything bigger than tiny isn't really decentralized without a pin). For the actual civic-signal use case — thumbnails of a broken road, a paper-leak screenshot, a paper-trail photo — in-event base64 IS the simplest decentralized answer:

- Zero operator infrastructure required
- Replicates via the same relay-to-relay sync we already built in v0.4
- Renders in any browser natively via `data:` URLs
- Content-addressed via the existing SHA-256 media-tag binding
- No external service of any kind to pin, host, or trust

The trade-off is event size. A 200-event feed where 30% have thumbnails is ~3 MB on first load, vs ~200 KB for text-only. Acceptable for the value of "no operator anywhere."

### Operator action required

The Fly relays (Mumbai + Singapore) need a `fly deploy` to pick up the new `MAX_EVENT_BYTES`. Until they do, the Mumbai/Singapore relays still reject any event larger than 8 KiB even though clients can now produce them.

VERSION → 0.5.0.

## v0.4.1 — zero-config Render deploy: peers seeded from JSON + hardcoded backup (2026-05-21)

### Fixed — the "every new Render operator needs to set COCKROACH_PEERS in their dashboard" friction

A fresh deploy via the Render one-click button now joins the mesh automatically with **zero env vars**. Three-layer resolution at first boot:

1. `COCKROACH_PEERS` env var (explicit operator intent, wins if set)
2. `relay/seeds.json` shipped alongside the binary (editable before first start, idempotent re-seed on each boot via `INSERT OR IGNORE`)
3. `HARDCODED_DEFAULT_PEERS` constants in `server.ts` — last-resort backup so the relay never bricks on a missing/corrupted seeds.json

Default seed file now ships with Mumbai + Singapore + the Render Pehredaar — three independent jurisdictions / hosting providers. Operators editing `seeds.json` before first start get full control; everyone else just clicks Deploy and joins.

This file lookup checks four conventional paths (`./seeds.json`, `./relay/seeds.json`, `/etc/cockroach-relay/seeds.json`, `import.meta.url`-relative) so the same code works for `bun run`, `bun --compile` binaries, Docker, and Render deploys.

VERSION → 0.4.1. No protocol change, no SPEC change — operator-friction patch.

## v0.4.0 — share-URL discovery + relay-to-relay sync + storage compression (2026-05-21)

The full anti-silo release.  Three coordinated pieces, all shipping in one
version, all using zero new dependencies.

### Added — share-URL discovery (SPEC §4.8)

- `client/app.js` parses `#relays=<wss-urls>` from the URL fragment on app
  load.  Each URL is health-checked against `GET /` for the canonical
  `name: "cockroach-relay"` response, then added to the relay pool with
  provenance source `"share"` and the originating event id as detail.
- `shareUrlFor(eventId)` now appends `#relays=<encoded primary>` so every
  share is also a discovery hint.  Hash fragment, not query — keeps the
  list out of HTTP logs and Referer headers.
- Identity tab displays per-relay provenance: `via share #abcd · 5m ago`,
  `seed list`, or `added manually · 2h ago`.  Per-source insight, per-relay
  remove.

### Added — `PEERS` wire verb (SPEC §4.9)

- Client opportunistically sends `["PEERS", "wss://r1", "wss://r2", ...]`
  after each relay connection, naming every other relay it knows about.
  The receiving relay treats these as candidate peers for relay-to-relay
  sync.

### Added — relay-to-relay sync (SPEC §4a)

- New `peers` SQLite table with source provenance + watermark per peer.
- Operator baseline via `COCKROACH_PEERS` env (comma-separated wss:// URLs).
- Auto-discovery via the `PEERS` verb (§4.9).  Every auto-discovered
  candidate is HTTP-verified before any WebSocket connection is opened.
- For each known peer, the relay maintains an outgoing WebSocket
  subscription on `kinds: [1, 2]` since `watermark - 60s` (60-second
  overlap absorbs clock skew).  Events arriving from peers go through the
  same `storeEvent` path as direct client publishes; dedup-by-id makes
  loops single hash-lookup no-ops.
- Exponential reconnect backoff (1s → 60s cap) per peer.
- `GET /peers` exposes the relay's known peer set with provenance and
  current connected state, for operator inspection.

### Added — gzip storage compression (SPEC §6)

- `relay/server.ts` adds a `compressed` column to `events`; new events
  whose raw JSON exceeds 256 bytes are gzipped via `Bun.gzipSync`,
  base64-encoded, and stored compressed iff the encoded length is
  strictly smaller than the original.  Older events keep `compressed=0`
  and read unchanged.
- Civic-text expected compression ratio is 3–5×.  No protocol change,
  no client visibility — purely a storage optimization.
- Zero new dependencies; Bun ships gzip in the runtime.

### Notes

- Version bump to v0.4.0.  Relay binary banner + `/info` reflect this.
- All three pieces use only existing dependencies: `@noble/hashes` (already
  present for ed25519), Bun built-ins (`gzipSync`, `gunzipSync`, `WebSocket`,
  `sqlite`).
- The `media.js` direction from v0.2.4.x stays pulled; SPEC §3.4 media tag
  format remains valid for future implementations.

## v0.2.4.2 — pull media-upload feature (2026-05-21)

### Removed

- `client/media.js`, the file-attach UI in the compose form, and the
  related render path. After landing v0.2.4 (Helia) and v0.2.4.1
  (local-only CID), we concluded that media uploads without a
  meaningful cross-user retrieval story aren't worth the surface area.
  A local-only attach button promises something the network can't
  currently deliver.
- The protocol's content-addressed media tag format (SPEC §3.4) is
  unchanged — events with `["media", "<url>", "sha256:<hex>"]` are still
  valid and any future client can render them. We just don't produce or
  display them right now.

### What this means going forward

- Media will return once there's a real cross-user storage story —
  either (a) a BYO-pin Settings flow where users wire their own
  Storacha/Pinata token, or (b) more Pehredaars choose to run an
  optional IPFS pin alongside their relay. Both are v0.3 work.

## v0.2.4.1 — drop Helia, ship pragmatic local-first IPFS (2026-05-21)

### Fixed

- **Helia (browser-native IPFS) was bombing out with "Failed to fetch dynamically imported module" on real browsers.** The transitive `helia` → `libp2p` → `@chainsafe/*` import graph is too brittle for the esm.sh / jsdelivr CDN delivery path in 2026; even when it loads, the libp2p bootstrap dance fails often enough on mobile/NAT'd connections to be unshippable. Pulled it out.

### Changed

- `client/media.js` is now a 130-line zero-dependency module that computes real IPFS CIDv1 (raw codec, base32 multibase — what `ipfs add --cid-version=1 --raw-leaves` produces) locally using only `@noble/hashes/sha2` (already in the bundle).
- Files are stored in browser IndexedDB keyed by CID. Survives reloads on the same device.
- Compose-screen status flipped from `✓ pinned in browser` (which implied IPFS-network pinning) to `✓ saved locally` (the honest truth). New help text and a "copy CID" affordance so users can pin elsewhere if they want.
- Feed cards still render media via `<img src=ipfs://CID resolved through public gateway>` for cross-user retrieval. Now ALSO upgrades to instant `blob:` URLs from local IndexedDB when the viewer is the uploader or has previously fetched the file. `upgradeLocalMedia()` runs after every feed render.

### Honest decentralization status

- Local-only by default. Anyone except the uploader gets the gateway fallback chain (`dweb.link` → `w3s.link` → `cf-ipfs.com`), which only succeeds if the CID is pinned somewhere. **We pin nothing.**
- For cross-user permanence, advanced users need BYO Storacha / Pinata pin (Settings UI deferred to v0.2.5).
- The CID itself is real and IPFS-gateway-compatible — anyone who manages to pin those bytes (by any means) makes the file available globally.

## v0.2.4 — IPFS media uploads via Helia (browser-native, no operator) (2026-05-21)

### Client

- **File attachments now upload to IPFS directly from the browser** via Helia (`client/media.js`). When a user attaches a file, a Helia node spins up in their browser, the bytes get a real IPFS CID, and the uploader's tab serves the file via libp2p + bitswap to any other IPFS node — including public gateways like Cloudflare's `cf-ipfs.com`, Protocol Labs' `dweb.link`, and Storacha's `w3s.link`. Helia is lazy-loaded (~500 KB) on first attach to keep the initial page fast.
- The published event carries the media as a SPEC §3.4 tag: `["media", "ipfs://<cid>", "sha256:<hex>", "<mime>", "<size-bytes>"]`. SHA-256 is computed independently so non-IPFS readers can verify the bytes against the claim even if they fetched via an HTTP gateway.
- Feed cards now render `ipfs://` media inline as `<img>` / `<video>` from the first public gateway. If a gateway 404s, the element's `onerror` falls through the gateway list. After all gateways fail the image stays broken — an honest signal that nobody has the CID anymore.
- **Decentralization model**: we operate no pinning service. The protocol author and relay operators carry zero responsibility for media storage. A file is reachable as long as the uploader's tab is open OR somebody else pinned it (could be a public gateway that cached it during retrieval; could be a user's own Storacha/Pinata account). For permanence, advanced users can configure their own pinning credentials (Settings UI deferred to v0.2.5).
- 20 MB per-file cap in the client; helps keep browser memory + DHT round-trips manageable.

### Protocol / relay

- No changes. SPEC §3.4 already specified the content-addressed `media` tag format; the client now produces it via real IPFS for the first time.

## v0.2.3 — landing redesign: agitprop poster with live cockroach (2026-05-21)

### Landing

- Full visual rewrite of `index.html` from the Claude Design handoff. Dark editorial / agitprop poster aesthetic — black background, cream paper ink, rebel-red accent (`#e63b2e`). Anton (display) + Instrument Serif (italic pull) + JetBrains Mono (tags / metadata) + Inter (body).
- The cockroach is now the lead character: giant 🪳 in the hero stage with idle wiggle, cursor parallax, click-to-startle bounce, an orbiting ring of four stamps (Janta ka, Indestructible, est. 2026, Signed · Forever), and a constant background swarm of smaller scurriers crossing the viewport.
- Marquee tape strip across the top with data-driven Pehredaar count (`1 public Pehredaar live` updates to the real `relaysAlive`).
- New "Live wall" section between *What* and *How* — shows real-time `reports/24h`, `#mainbhicockroach/7d`, `cities` stats plus the latest six declarations as Instrument Serif pull-quote cards.
- Pehredaar alarm box now drives off real data: the giant "01" is `relaysAlive` padded, the headline switches between "Sirf ek Pehredaar zinda hai" / "N Pehredaar zinda hain" based on count, and the live status line in the footer shows aggregated relay + peer count + last-event time in IST.
- Mascot health caption (the honest "Akela · 1 Pehredaar · bachao" line) sits below the mascot and updates from the same resilience metric as v0.2.2.
- Removed the v0.1 stylesheet path — the landing is now self-contained with inline styles. `web/styles.css` remains for the `/build/` developer page.
- The Tweaks panel from the design handoff is intentionally excluded — it was the designer's authoring surface, not a production component.

### Protocol / relay / client

- No changes.

## v0.2.2 — relay stats endpoint + network-wide health aggregator (2026-05-21)

### Relay

- `GET /` JSON now includes a `stats` block — `ws_connected` (real-time WebSocket connections), `unique_pubkeys_1h` (distinct authors in the last hour), `peer_offers_15m` (kind:10001 events in the last 15 min, proxy for active peer mesh), `events_24h` (total events in last day). Cached for 10s to keep the endpoint cheap under load. Other relays and clients can pull this without subscribing.
- Version banner bumped to v0.2.2.

### Landing

- Cockroach health metric now aggregates `stats` from EVERY responding relay in `client/relays.json`, not just the relay the landing happens to be subscribed to. The score reads the whole network's state, not one slice of it.
- `effectivePeers()` returns the max of (locally observed kind:10001 publishers) and (network-wide peer_offers_15m sum). Whichever is more accurate wins.
- Captions now show the aggregated peer count: *"Mazboot. 5 Pehredaar, 47 peers meshing."* — the user sees the real network-wide state.

### Deploy

- Operators on v0.2.1 should `fly deploy` (or pull + restart) to pick up the new `/stats` block. Old relays that don't have it still count as "alive" — they just don't contribute to the aggregated peer/connection signal.

## v0.2.1 — peer mode on by default + Cloudflare Tunnel guide (2026-05-20)

### Changed

- **Peer mode now ON by default** in the reference client. Previous v0.2.0 default was off-with-opt-in dialog. The mesh is now alive from the first page load. Users who don't want IP exposure can explicitly disable in the Identity tab; that disable persists across reloads. Trade-off documented in WHITEPAPER §7 — operators in hostile jurisdictions should disable.
- First-time peer enablement now surfaces as a **non-blocking toast** ("Peer mode on — your device is now part of the mesh. IP exposed to peers. Disable in Identity tab anytime.") rather than a confirm dialog.

### Added

- `relay/RUN.md` — new subsection on **Cloudflare Quick Tunnel**, the fastest way to make a local relay binary publicly reachable. ~30 seconds, no account, no TLS cert, no port forwarding. URL is ephemeral and resets when cloudflared restarts; good for launch demos and short-lived experiments. Sits alongside Tor hidden service and TLS reverse proxy as the third pathway from a localhost relay to the public network.

### Known still-open

- IP exposure on first load is no longer behind a consent dialog. Users in hostile contexts should be onboarded to disable peer mode before publishing sensitive reports.

## v0.2.0 — WebRTC peer-relay mesh (2026-05-20)

### Added

- **WebRTC peer-relay mesh in the reference client** (opt-in, default off). Every PWA install can now connect directly to other peers and gossip events over RTCDataChannels. The network survives any single relay going offline; events fan out across both relays and peer connections; new clients can warm-start from existing peers without needing relays first.
- **New event kinds for peer signaling** — SPEC §4.4–4.7:
  - `kind:10001` — peer offer (SDP, expires, optional geohash)
  - `kind:10002` — peer answer (addressed to a specific offerer)
  - `kind:10003` — ICE candidate (reserved for trickle-ICE; the v0.2 reference client gathers all ICE before publishing offers/answers)
- **Peer mode toggle in Identity tab** with explicit IP-exposure disclosure on first enable. Preference persists across reloads; defers enabling until at least one relay is connected.
- **Header peer indicator** next to the relay status, showing live peer count when peer mode is on.
- **Client-side signature verification** of peer-sourced events. Relays validate events on receipt, but events arriving over WebRTC haven't been through a relay; the client now re-verifies before ingesting. Untrusted-source defense.
- **`client/peers.js`** — new file, self-contained `PeerPool` class (~270 LoC). Implements the offer / answer / ICE dance, channel wiring, fan-out, dedupe, and the 12-peer soft cap. Uses public STUN servers (Google, Cloudflare); no TURN for v0.2 — peers behind symmetric NATs stay relay-only.

### Reference relay

- No code changes required. The relay accepts any non-negative kind and indexes by single-letter tags. `kind:10001/10002/10003` events route through the existing storage and filter paths unchanged.
- The new client subscription includes the signaling kinds (10001 globally with a 1-hour window; 10002/10003 only when addressed to the user's pubkey).

### Documentation

- SPEC §4.4–4.7 formalize the three new kinds and the peer mesh trust model.
- WebRTC design doc at `docs/v0.2-webrtc-peer-relay.md` is now backed by working code.

### Known limits in v0.2

- No TURN servers shipped. Peers behind symmetric NATs cannot establish direct connections; they remain relay-only. Operators or interested users can configure their own TURN list later.
- ICE is gathered fully before publishing the offer/answer (slower first-connection latency in exchange for simpler signaling). Trickle ICE via `kind:10003` is a future enhancement.
- Subscription to `kind:10001` is global — scales to small networks. At larger scale, geohash-prefix filtering on the `#g` tag will be required.
- Mobile background tabs throttle aggressively; peer connections drop on iOS Safari / Chrome backgrounding. Peer mesh is most useful while the app is in the foreground.

## v0.1.2 — runs out of the box (2026-05-20)

### Added

- **`start.command` (Mac/Linux) and `start.bat` (Windows) launchers** bundled inside each release archive. Double-click the launcher to skip every `chmod` / `xattr` / "is damaged" ceremony — the launcher strips quarantine, sets the executable bit, and runs the relay. The "common teenager" path.
- **`client/relays.json` now seeds `ws://localhost:7447`** so a freshly downloaded relay binary + the deployed client at `thecockroachnetwork.com/client/` connect automatically with zero config.

### Fixed

- Relay startup banner now reports the correct version (was hard-coded to v0.1.0 in v0.1.1 — visible cosmetic bug, no functional impact).

### Known still-open

- macOS unsigned-binary warnings remain on the **first run** of the binary when downloaded outside the archive (raw download from the release page). The `start.command` wrapper inside the archive bypasses this. Future v0.2 work: build Mac binaries on a macOS runner so we can ad-hoc codesign them, eliminating the "is damaged" message entirely.

## v0.1.1 — release UX fixes (2026-05-20)

### Changed

- **Binary distribution now ships archives** (`.tar.gz` for Mac/Linux, `.zip` for Windows) alongside raw binaries. The archive preserves the executable bit, so `chmod +x` is no longer required after download. The previous v0.1.0 raw binaries still work but required a manual `chmod` after browser download stripped the exec bit.
- **Landing page rewritten with action-first hero.** "Open the client" is now the primary CTA (truly zero-install — just tap the URL on a phone). "Run a relay" is the secondary CTA (operator path; light terminal use required for unsigned binaries). The reframing reflects what's actually friction-free vs. what isn't.
- **SEO + social-share hardening on the landing page.** Added Open Graph meta tags including `og:image` pointing at a 1200×630 cover SVG (`web/assets/og-cover.svg`), Twitter `summary_large_image` card, JSON-LD `SoftwareSourceCode` structured data, canonical URL, expanded `<meta name="description">`, `keywords`, and a `<title>` rewritten for SEO weight.
- Added top-level `robots.txt` and `sitemap.xml` so search engines can index the protocol pages.

### Known still-open

- Native binaries remain unsigned. macOS Gatekeeper and Windows SmartScreen still warn on first run. True "double-click and go" awaits v0.2's WebRTC peer-relay mode (every PWA install becomes a relay automatically — zero binary, zero install, zero permissions). See [`docs/v0.2-webrtc-peer-relay.md`](docs/v0.2-webrtc-peer-relay.md).
- Client crypto still loaded from esm.sh CDN without SRI (HIGH finding from the v0.1.0 CSO audit, deferred to v0.2 with the noble-bundle vendoring work).

## v0.1.0 — initial release (2026-05-20)

The first public release. Sets the wire protocol baseline; subsequent v0.x releases improve reference implementations and operator tooling without changing the spec.

### Protocol

- Defined the wire protocol: ed25519 keypairs, SHA-256 event ids, canonical compact JSON, WebSocket transport.
- Defined event kinds `1` (civic-report) and `2` (verification).
- Fixed verification verb vocabulary: `true`, `duplicate`, `resolved`, `fake`, `needs-more-proof`.
- Indexed single-letter tags (`g`, `t`, `e`, `p`); free-form multi-letter tags.
- Content-addressed media via `["media", "sha256:<hex>", "<url>", ...]` — never embedded.
- Reference reputation algorithm: locality × accuracy with burst-tolerance for crowd events.

### Reference relay (`relay/`)

- Bun + TypeScript + SQLite, L1-conformant per SPEC §12.
- WebSocket broker with filter queries on ids, authors, kinds, tags, time bounds.
- 90-day default retention; per-relay configurable.
- Containerized (`Dockerfile`, `docker-compose.yml`).
- Fly.io template (`fly.toml`), bare-VPS installer (`install.sh`), operator guide (`RUN.md`).

### Reference client (`client/`)

- Vanilla JavaScript PWA, L3-conformant per SPEC §12.
- Multi-relay fan-out via a `RelayPool` abstraction; per-relay connection state.
- Seed list from `relays.json`; user-editable via Identity tab.
- ed25519 keypair generated in browser; stored in `localStorage`.
- Geohash encoding (precision 4–9) with privacy-aware default at 7.
- Verification UI with the five verbs and client-computed consensus.

### Release artifacts

- Whitepaper (`WHITEPAPER.md`).
- Normative spec (`SPEC.md`).
- Landing page (`web/`) positioning the protocol as a release, not a service.
- Release process (`RELEASE.md`) for multi-host Git mirroring and IPFS pinning.
- **Standalone executables** for Mac (arm64 + x64), Windows (x64), and Linux (x64 + arm64), built via Bun's `--compile` mode. ~70 MB per binary, no install needed, no Bun runtime required on the user's machine. Built on tag push by `.github/workflows/release.yml`; reproducible locally with `relay/scripts/build-binaries.sh`.

### Known limits in v0.1

- Media is referenced by URL; no in-client upload to IPFS (deferred to v0.2).
- No encrypted key backup; losing the device loses the identity (deferred to v0.2).
- No vouching events; web of trust is intentionally absent (deferred to v0.2+).
- No relay federation; clients fan out to multiple relays themselves.
- No native mobile apps; PWA only.

## v0.2.0 — planned

- **WebRTC peer-relay mesh.** Every PWA install of the reference client joins a peer-to-peer mesh automatically (opt-in toggle). Opening the client makes the device part of the network — no hosted infrastructure required. Design: [docs/v0.2-webrtc-peer-relay.md](docs/v0.2-webrtc-peer-relay.md). Reserves event kinds `10001` (peer offer), `10002` (peer answer), `10003` (ICE candidate).
- Direct media upload from client to a user-configured pinning service.
- Encrypted seed-phrase backup of the keypair.
- Map view with clustering.
- Push notifications for events matching saved filters.
- Optional `INFO` verb for relay self-description and peer advertisement.
