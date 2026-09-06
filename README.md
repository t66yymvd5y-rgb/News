# Kertas

A magazine-style news reader over public RSS feeds. Malaysian desks lead,
international sources follow. Static site, no server, no accounts, no tracking.

Pages turn along a horizontal fold, as a printed magazine does. Stories are
packed into full-screen pages by a layout engine that gives the largest slots to
the stories that carry imagery.

## How it works

```
config/sources.json ──► scripts/fetch-feeds.mjs ──► data/articles.json ──► the site
      (feed list)         (GitHub Actions, hourly)      (committed JSON)     (static)
```

The browser never fetches a third-party feed. A scheduled GitHub Action fetches
them, normalises the items, commits the result, and deploys to GitHub Pages.
That sidesteps browser CORS restrictions entirely — no proxy service to depend
on — and means there are no secrets in the deployed site.

Just before the site is uploaded, `scripts/stamp-assets.mjs` rewrites the
stylesheet and script URLs in `index.html` to carry a hash of the file they
point at. GitHub Pages serves everything with `Cache-Control: max-age=600`, so
without the stamp a browser that already has the site would keep the previous
`app.js` and `styles.css` next to a freshly fetched `index.html` — new markup
driven by old code. The stamp is applied to the published copy only; the file
in the repository keeps plain paths, so opening it from disk still works.
`index.html` itself is still subject to that ten-minute window, which is the
remaining bound on how long a change takes to appear.

## Setting it up

1. **Enable Pages.** Repository *Settings → Pages → Build and deployment →
   Source: GitHub Actions*.
2. **Run it once.** *Actions → Refresh feeds and publish → Run workflow*. The
   first run replaces the placeholder sample data with real headlines.

After that it refreshes hourly on its own.

## Editing the feeds

Everything lives in `config/sources.json`. To add a source:

```json
{ "id": "unique-id", "source": "Publisher name", "topic": "malaysia",
  "url": "https://example.com/feed", "enabled": true }
```

`topic` must match one of the ids in the `topics` array. Set `"enabled": false`
to park a feed without deleting it. `fetch` controls how many items each feed
contributes by default, how far back to keep them, and how many stories reach
Top Stories; an individual feed can override the default with `"maxItems"`, so
one prolific publisher cannot swamp its section.

A feed that 404s or times out does not break the build: the fetch logs a
warning and carries forward that feed's items from the previous run. Only a
total wipeout — every feed down — fails the workflow, so a stale site is never
replaced by an empty one.

### Checking a feed URL before shipping it

Publishers move and withdraw their feeds. Rather than guess a URL and discover
it is wrong on the live site, list candidates under `probe`:

```json
"probe": [ { "id": "star-a", "url": "https://example.com/rss" } ]
```

The next run fetches each one and reports what came back, without publishing
any of them. A candidate passes only if it returns 200 **and** parses as a feed
with items — a publisher's 200-with-an-HTML-error-page does not count. Promote
whatever works into `feeds`, and delete the rest.

### Notes on particular sources

**Malaysiakini** publishes free headlines but meters some articles, so a
proportion of those tiles will hit a paywall.

**The Star, Bernama and The Edge Malaysia** no longer publish RSS. Every
candidate path was probed on 5.9.2026 and every one returned 404; they appear to
have withdrawn public feeds rather than moved them. Their direct entries are
left in the config, disabled, so re-enabling is one flag if they return.

In the meantime all three are bridged through Google News, which still carries
their headlines. A bridged feed is marked `"via": "google-news"`, which strips
the " - Publisher" suffix Google appends to every headline and discards the
description, since Google fills it with a block of markup rather than a summary.
The trade-off is real and worth knowing: **links go to a Google redirect that
forwards to the publisher rather than straight there, and there is no imagery
and no article text for the reader.** Those tiles show a headline and a link,
nothing more. Delete the three `gnews-` entries to drop the bridge.

**Reuters** is disabled for the same reason — they withdrew their public RSS
feeds some time ago.

## Optional: a news API on top of RSS

Off by default. RSS alone is enough to run the site. If you want a wire
supplement, add a repository **secret** `NEWS_API_KEY`, and optionally the
repository **variables** `NEWS_API_PROVIDER` (`gnews`, the default, or
`newsapi`) and `NEWS_API_COUNTRY` (default `my`). The key is used inside the
Action at build time and never reaches the browser.

## Running it locally

`data/articles.json` is loaded over `fetch`, which browsers block on `file://`.
Serve the folder:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

To refresh the data on your own machine:

```bash
node scripts/fetch-feeds.mjs    # Node 22+, no dependencies to install
```

## Reading it

| Action | Desktop | Phone |
| --- | --- | --- |
| Next / previous page | `↓` `↑`, space, scroll, or the pager | Swipe up / down |
| First / last page | `Home` / `End` | — |
| Search | `/` or the search icon | Search icon |
| Save a story | Bookmark icon on any tile | Bookmark icon |
| Light / dark | Theme icon (follows the system by default) | Theme icon |

Saved stories are kept in the browser's own storage as a snapshot of the
headline, so they survive the feed rotating them out. Nothing is sent anywhere;
there is no account and no sync between devices.

## Reading a story

Tapping a story opens it in the reader rather than jumping straight out to the
publisher. Cmd-click, middle-click and "open in new tab" still go to the
publisher directly, and every reader view carries a link there.

What the reader shows is decided entirely by the publisher. Feeds that syndicate
the whole article — `content:encoded` in RSS, `content` in Atom — are shown in
full. Feeds that carry only a teaser show the teaser and say so. Nothing is ever
fetched from the publisher's own pages, so a metered article stays metered.

Bodies are stored in `data/bodies.json`, separate from the index, so the site
paints before any article text is loaded; the reader fetches it once, on first
open. They are stored as plain-text paragraphs rather than HTML and rendered
with `textContent`: feed content is untrusted third-party input, and this leaves
no path from a hostile or compromised feed to script execution in the page.

## What it does not do

It shows a headline, the publisher's name, the timestamp, the publisher's own
image, and whatever text the publisher puts in their own feed. Every story links
back to the source. It does not fetch or reproduce article text beyond the feed,
cache publisher pages, or work around paywalls.

## Layout

`assets/js/app.js` holds a set of grid templates over a 12-column, 8-row page,
one set per breakpoint. Pagination walks the article list, assigns each page a
template in rotation, and within a page sorts slots by area so stories with
imagery land in the largest ones.

Every tile is one design: a dark ground carrying knocked-out type. A story with
a photograph gets the photograph and a scrim over its foot; a story without one
gets a colour block drawn from the five editorial grounds in the stylesheet, and
its headline is set about a third larger to take the room the image would have
had. Many feeds carry no images at all — Business and Opinion are entirely
imageless — so that path is a finished design rather than a fallback, and a
mixed page still reads as one family. Grounds are seeded from the article id, so
a story keeps its colour, but a repeat is nudged to the next colour when it would
land beside its twin.

Tiles clamp their own text against the slot they were given, through container
queries on the tile itself: a short slot drops the summary, and then a headline
line, rather than letting the body run past the tile and slice a line of type in
half.

The fold is three layers: two static clipped half-pages, and a rotating leaf
whose front face is the outgoing half and whose back face is the incoming one.
`prefers-reduced-motion` swaps the animation for an instant change.
