# PRD — Flipboard-style News Aggregator

Status: DRAFT — awaiting sign-off
Date: 5.9.2026
Owner: Nicholas Hor

## 1. Problem

There is no single place to read Malaysian and international news in a format
that is pleasant to look at. Existing aggregators are either ugly link lists or
apps that own the reading experience. The aim is a self-hosted, zero-cost
magazine-style reader over feeds we choose.

## 2. Success criteria

1. Loads at a public GitHub Pages URL with no server and no runtime secrets.
2. Headlines are refreshed automatically on a schedule without manual work.
3. Reads as a magazine: full-bleed imagery, editorial typography, page-turn
   navigation — not a list of links.
4. Works on phone (swipe) and desktop (arrow keys, click, scroll).
5. Adding or removing a source is a one-line edit to a config file.
6. Every article links out to the publisher; we never reproduce full text.

## 3. Scope

### In scope
- Static site: HTML/CSS/vanilla JS, no framework, no build toolchain beyond a
  Node fetch script.
- Feed ingestion at build time via GitHub Actions on a schedule (default hourly),
  writing normalised JSON into the repo for the site to consume.
- RSS/Atom as the primary source. An optional API key slot (GNews/NewsAPI) read
  from Actions secrets, off by default, that enriches items when present.
- Malaysia-first source set, international secondary, in an editable config.
- Topic sections: Top Stories, Malaysia, World, Business, Tech, Sport, Opinion.
- Magazine mosaic layout — one hero tile plus asymmetric supporting tiles —
  paginated, with a page-turn (fold) animation between pages.
- Save for later, stored in browser localStorage. No accounts, no server.
- Search across fetched headlines; filter by source and by topic.
- Light/dark theme following the system setting, with a manual override.
- Manual refresh of the story file, plus an automatic one when an installed
  copy is brought back from suspension with data older than ten minutes.

### Out of scope (v1)
- User accounts, sync across devices, comments, sharing back to a server.
- Full-article text extraction or reader-mode reproduction of publisher content.
- Push notifications, email digests, personalisation/recommendation ranking.
- Native mobile app.

## 4. Constraints and risks

- **CORS.** Browsers cannot fetch third-party RSS directly. Resolved by fetching
  at build time in the Action; the browser only ever reads our own JSON.
- **Copyright.** We store and display headline, publisher, timestamp, feed
  excerpt (2-3 lines as supplied by the feed) and the publisher's own image URL.
  Click-through always goes to the publisher. No full text, no paywall bypass.
  This is standard RSS use, which publishers offer for the purpose, but the line
  is: excerpt and link only.
- **Images.** Hotlinked from the publisher. Some feeds supply none; the layout
  must degrade to a typographic tile rather than an empty box.
- **Feed drift.** Feeds move or die. The fetch script must fail soft: log the
  broken feed, keep the last good data, never publish an empty site.
- **Branding.** The site takes Flipboard's visual idiom but carries its own name
  and marks. No Flipboard name, logo, or trade dress.
- **Staleness.** GitHub Actions cron is best-effort and can lag; "last updated"
  is shown in the UI so staleness is visible rather than misleading.

## 5. Proposed sources (edit freely)

Malaysia: The Star, New Straits Times, Malay Mail, Bernama, Free Malaysia Today,
Malaysiakini (free feed), The Edge Malaysia (business).
International: BBC, Reuters, Al Jazeera, Channel NewsAsia, Guardian World.
Tech: Ars Technica, The Verge. Sport: BBC Sport.

## 6. Plan

1. Repo scaffold, config file of sources, feed-fetch script with normalisation
   and de-duplication; JSON output committed by the Action.
2. GitHub Actions workflow: hourly cron plus manual dispatch; commits refreshed
   JSON; deploys to Pages.
3. Layout engine: tile-size assignment from image availability and headline
   length; page packing into fixed-height magazine pages.
4. Flip animation: CSS 3D fold, swipe and keyboard and click navigation, reduced
   motion respected.
5. Sections, search, save-for-later, dark mode.
6. Responsive pass, accessibility pass, README with instructions for editing
   sources and enabling the optional API key.

## 7. Open questions

1. Site name and any wordmark.
2. Refresh cadence — hourly is proposed; 30 minutes is possible but noisier in
   commit history.
3. Whether Malaysiakini and The Edge should be included given partial paywalls.
