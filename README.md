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
contributes, how far back to keep them, and how many stories reach Top Stories.

A feed that 404s or times out does not break the build: the fetch logs a
warning and carries forward that feed's items from the previous run. Only a
total wipeout — every feed down — fails the workflow, so a stale site is never
replaced by an empty one.

Two of the shipped sources, **Malaysiakini** and **The Edge Malaysia**, publish
free headlines but meter some articles, so a proportion of those tiles will hit
a paywall. Reuters is listed but disabled — they withdrew their public RSS
feeds; re-enable it if that changes.

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
imagery land in the largest ones. Stories without an image get a deterministic
tint and larger type instead of an empty frame — many feeds carry no images, and
that path has to look deliberate rather than broken.

The fold is three layers: two static clipped half-pages, and a rotating leaf
whose front face is the outgoing half and whose back face is the incoming one.
`prefers-reduced-motion` swaps the animation for an instant change.
