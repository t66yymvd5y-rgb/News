# PRD — Private full-text reader for Kertas

Status: SHELVED — 24.10.2026. Approved (strict), then shelved at step 1 in favour of
sourcing feeds that syndicate full text; see §8.
Date: 24.10.2026
Owner: Nicholas Hor

## 1. Problem

About 55% of Kertas stories show only a teaser, because the publisher's feed
carries no article text (BBC, Al Jazeera, CNA, CNBC, TechCrunch, Wired, Google,
DeepMind, among others). Reading those means leaving Kertas for the publisher's
page, with its ads, pop-ups and cookie banners.

The public site cannot fix this. Copying whole articles onto a public page is
republication. That engages the owner's exclusive rights under s.13 of the
Copyright Act 1987, and the fair dealing exception for reporting current events
(s.13(2)(a)) is unlikely to cover reproducing the whole work. So the public site
stays as it is, and full text becomes a feature of a **private copy only Nicholas
can open**.

## 2. Success criteria

1. A private Kertas URL that asks for a login and admits only
   nicholas@nicholashor.com.
2. On a teaser-only story from an allowed publisher, a **Full text** button in
   the reader shows the article body, natively styled, within about three
   seconds.
3. Nothing is stored. Article text is fetched when Nicholas opens a story, shown
   once, and discarded. No corpus is built up in git, in caches or in logs.
4. Paywalled publishers are never fetched.
5. The public site, its repository and its data files are unchanged.
6. Running cost is RM 0 on free tiers.

## 3. Proposed design

```
Public:   GitHub Pages (unchanged) ── data/articles.json, data/bodies.json (feed text only)

Private:  Cloudflare Pages, behind Cloudflare Access (email one-time code)
          └─ same Kertas build, with a flag that turns on the Full text button
                └─ Cloudflare Worker /extract?url=…   (also behind Access)
                      1. reject unless the domain is on the allowlist
                      2. fetch the one article page
                      3. extract the body (Mozilla Readability)
                      4. return plain-text paragraphs; store nothing
```

**Why on demand rather than in the hourly job.** Extracting in the hourly job
would copy every article, read or not, and keep them. On demand fetches only the
story being read, once, at the moment of reading. That is closer to what a
browser's Reader button does, and it means far fewer requests to publishers.

**Why not GitHub Pages for the private copy.** A Pages site is publicly
reachable even when built from a private repository; access control needs
GitHub Enterprise Cloud. Cloudflare Access gives a login wall on the free tier.

**Rendering.** The same rule as today: extracted text goes in as plain-text
paragraphs rendered with `textContent`, so untrusted page content has no path to
running script in Kertas.

## 4. Scope

### In scope (v1)
- Cloudflare Pages deployment of the existing site with a `privateMode` flag.
- Cloudflare Access policy for one email address.
- Worker endpoint with a domain allowlist, a 10-second timeout, and a clear
  "Could not extract — open at the publisher" fallback.
- A Full text button in the reader, shown only in private mode and only on
  teaser-only stories from allowed domains.
- An attribution line and the publisher link kept on every extracted article.

### Out of scope (v1)
- **Paywalled sources:** FT, The Economist and Malaysiakini. They go on a hard
  denylist; see §5.
- **Google News bridged sources:** The Star, Bernama, The Edge, Reuters, StarBiz
  and NST Business. Their links are Google redirects that cannot be reliably
  resolved to the publisher's URL. They are deferred, not ruled out.
- Storing, caching, searching or exporting extracted text.
- Any user other than Nicholas, including firm staff (see §5).
- Changes to the public site.

## 5. Legal assessment and constraints

| Issue | Assessment | Mitigation in the design |
| --- | --- | --- |
| Reproduction, s.13(1)(a) | The Worker makes a transient copy to extract and display. Personal, single-viewer reading with nothing retained is low risk, but not zero: there is no general private-use exception for literary works. | No storage; one user; nothing shared. |
| Communication to the public, s.13(1)(aa) | Avoided only while access stays limited to one person. Adding users moves it towards communication to the public. | Access policy for a single email; adding anyone is a new decision, not a config tweak. |
| Technological protection measures, s.36A | Fetching paywalled text would circumvent access controls. This is the clearest line. | Hard denylist; the Worker refuses any domain not on the allowlist. |
| Website terms of use | Many publishers' terms prohibit automated access. A breach is contractual, not criminal, and enforcement against a single private reader is unlikely, but it is a breach. | Allowlist limited to publishers whose terms are checked at build time; see open question 2. |
| Bot blocking | Some publishers block cloud IP ranges. Not a legal issue, but it will make some sources unusable. | Fallback to the publisher link; such sources are removed from the allowlist. |

Net position: defensible as a personal reading aid, provided it stays private,
single-user, retains nothing and never touches a paywall. It should not be
described or used as a way to give anyone else access to articles.

## 6. Plan

1. **Allowlist.** Check the terms of use of each candidate publisher (BBC, Al
   Jazeera, CNA, CNBC, TechCrunch, Wired, Google, DeepMind) and record the
   result in the config. Present the list for approval.
2. **Worker.** Readability extraction, allowlist and denylist, timeout,
   plain-text output. Test against five live articles per publisher.
3. **Private deployment.** Cloudflare Pages project plus Access policy, with a
   second workflow that deploys the same build with `privateMode` on.
4. **Reader button.** Shown only in private mode; loading and fallback states.
5. **Review.** Walk through on phone and desktop; confirm that nothing is
   written anywhere; confirm that the public site is byte-for-byte unchanged.

Nicholas's part: create a free Cloudflare account and add an API token as a
repository secret. Everything else is in the repository.

## 7. Open questions

1. **Cloudflare account.** Is Cloudflare acceptable as the host for the private
   copy, or is there a preferred provider?
2. **Terms of use.** If a publisher's terms prohibit automated access, should it
   be excluded outright (recommended) or kept, given the low enforcement risk?
3. **Google News sources.** The Star, Bernama and The Edge are the Malaysian
   sources most likely to be wanted in full. Is it worth a v2 to resolve their
   redirect links, accepting that it may break whenever Google changes them?
4. **Single user.** Confirm the private copy stays Nicholas-only, with no access
   for Allya or Shannon.

## 8. Decisions and step 1 findings (24.10.2026)

**Approved, strict:** Cloudflare as host; Nicholas as the only user; any
publisher whose terms of use prohibit automated access is excluded outright.
Open question 3 (the Google News sources) remains deferred to v2.

**Step 1, terms-of-use check — incomplete.** The primary terms pages could not
be read from the build environment (its network policy blocks the publishers'
sites), so what follows rests on secondary sources and must be confirmed
against the live terms before any domain goes on the allowlist.

| Publisher | Indication | Status |
| --- | --- | --- |
| BBC | Formally told Perplexity in 2025 that scraping BBC content breaches its terms of use. | Exclude |
| TechCrunch | Listed by a terms tracker under Yahoo's terms, which bar collecting data with scrapers or other automated tools without prior permission. Which terms now govern TechCrunch needs confirming. | Exclude unless confirmed otherwise |
| Google, Google DeepMind | Google's current terms reportedly prohibit automated access only where it breaks machine-readable instructions such as robots.txt. | Likely allowed, subject to robots.txt |
| Wired (Condé Nast) | User agreement has a "Prohibitions on Use of the Service" section; its wording was not seen. | Unverified |
| CNBC (NBCUniversal) | NBCUniversal's prohibited-actions page was seen only in excerpt; no automated-access clause was visible. | Unverified |
| Al Jazeera | Not found. | Unverified |
| CNA (Mediacorp) | Not found. | Unverified |

**Implication.** If the unverified publishers follow the industry norm of
prohibiting automated access, the strict allowlist shrinks to the Google and
DeepMind blogs. That would not justify the build. Step 1 should be finished
before step 2 starts.
