#!/usr/bin/env node
/**
 * Kertas feed ingestion.
 *
 * Reads config/sources.json, fetches every enabled RSS/Atom feed, normalises the
 * items and writes data/articles.json for the static site to consume.
 *
 * Design notes:
 *  - Zero dependencies. Node 20+ (global fetch, no npm install in CI).
 *  - Fails soft. A dead feed logs a warning and falls back to whatever that feed
 *    contributed to the previous data/articles.json. The build never publishes an
 *    empty site because one publisher moved a URL.
 *  - Stores headline, excerpt, publisher, timestamp and the publisher's own image
 *    URL only. Never full article text.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = resolve(ROOT, 'config/sources.json');
const OUTPUT_PATH = resolve(ROOT, 'data/articles.json');
// Bodies live in their own file so the index stays small and the site paints
// before any article text is fetched. The reader loads this on first open.
const BODIES_PATH = resolve(ROOT, 'data/bodies.json');

const USER_AGENT =
  'KertasBot/1.0 (+https://github.com/t66yymvd5y-rgb/news; static news aggregator; contact via repo issues)';

/* ------------------------------------------------------------------ XML bits */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', eacute: 'é',
  pound: '£', euro: '€', copy: '©', trade: '™', deg: '°'
};

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+[0-9]*);/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

function safeCodePoint(code) {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  } catch {
    return '';
  }
}

const TAG = /<\/?[a-zA-Z][^>]*>/g;

function stripTags(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h\d)>/gi, ' ')
    .replace(TAG, '');
}

/**
 * Reduce feed markup to plain text.
 *
 * Tags are stripped, entities decoded, then tags stripped once more: Atom
 * <content type="html"> arrives entity-escaped, so its markup only becomes
 * markup after the decode step. The tag pattern requires a letter after the
 * angle bracket, so prose such as "5 < 10" survives.
 */
function toText(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = stripTags(s);
  s = decodeEntities(s);
  if (TAG.test(s)) {
    TAG.lastIndex = 0;
    s = stripTags(s);
  }
  TAG.lastIndex = 0;
  return s.replace(/\s+/g, ' ').trim();
}

/** All occurrences of <tag ...>...</tag>, returning the raw inner content. */
function findAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push({ attrs: m[1] || '', inner: m[2] });
  return out;
}

function firstTag(xml, tag) {
  const all = findAll(xml, tag);
  return all.length ? all[0] : null;
}

/** Self-closing or attribute-only elements, e.g. <media:content url="..."/>. */
function findSelfClosing(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(\\s[^>]*?)\\/?>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1] || '');
  return out;
}

function attr(attrString, name) {
  const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrString || '');
  return m ? decodeEntities(m[1]) : '';
}

/** Split a document into <item> (RSS) or <entry> (Atom) blocks. */
function splitEntries(xml) {
  const items = findAll(xml, 'item');
  if (items.length) return { kind: 'rss', blocks: items.map((i) => i.inner) };
  const entries = findAll(xml, 'entry');
  if (entries.length) return { kind: 'atom', blocks: entries.map((e) => e.inner) };
  return { kind: 'unknown', blocks: [] };
}

/* -------------------------------------------------------------- field pickers */

function pickLink(block, kind) {
  if (kind === 'atom') {
    const links = findSelfClosing(block, 'link');
    const alternate = links.find(
      (a) => (attr(a, 'rel') || 'alternate') === 'alternate' && attr(a, 'href')
    );
    if (alternate) return attr(alternate, 'href');
    const anyHref = links.map((a) => attr(a, 'href')).find(Boolean);
    if (anyHref) return anyHref;
  }
  const linkTag = firstTag(block, 'link');
  if (linkTag) {
    const text = toText(linkTag.inner);
    if (text) return text;
    const href = attr(linkTag.attrs, 'href');
    if (href) return href;
  }
  const guid = firstTag(block, 'guid');
  if (guid) {
    const text = toText(guid.inner);
    if (/^https?:\/\//i.test(text)) return text;
  }
  return '';
}

const DATE_TAGS = ['pubDate', 'published', 'updated', 'dc:date', 'date'];

function pickDate(block) {
  for (const tag of DATE_TAGS) {
    const found = firstTag(block, tag.replace(':', '\\:'));
    if (!found) continue;
    const parsed = Date.parse(toText(found.inner));
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif)(\?|$)/i;

function pickImage(block) {
  // Preferred: explicit media elements, largest declared width first.
  const media = [
    ...findSelfClosing(block, 'media:content'),
    ...findAll(block, 'media:content').map((m) => m.attrs),
    ...findSelfClosing(block, 'media:thumbnail'),
    ...findAll(block, 'media:thumbnail').map((m) => m.attrs)
  ];
  const candidates = [];
  for (const a of media) {
    const url = attr(a, 'url');
    const type = attr(a, 'type');
    const medium = attr(a, 'medium');
    if (!url) continue;
    if (type && !type.startsWith('image/')) continue;
    if (medium && medium !== 'image') continue;
    candidates.push({ url, width: parseInt(attr(a, 'width'), 10) || 0 });
  }

  for (const a of findSelfClosing(block, 'enclosure')) {
    const url = attr(a, 'url');
    const type = attr(a, 'type');
    if (url && (type.startsWith('image/') || IMAGE_EXT.test(url))) {
      candidates.push({ url, width: parseInt(attr(a, 'length'), 10) ? 0 : 0 });
    }
  }

  const itunes = findSelfClosing(block, 'itunes:image').map((a) => attr(a, 'href')).filter(Boolean);
  for (const url of itunes) candidates.push({ url, width: 0 });

  if (candidates.length) {
    candidates.sort((a, b) => b.width - a.width);
    return normaliseImageUrl(candidates[0].url);
  }

  // Fallback: first <img> inside the description/content HTML.
  for (const tag of ['content:encoded', 'description', 'summary', 'content']) {
    const found = firstTag(block, tag.replace(':', '\\:'));
    if (!found) continue;
    const html = found.inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    const img = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html);
    if (img) return normaliseImageUrl(decodeEntities(img[1]));
  }
  return '';
}

function normaliseImageUrl(url) {
  if (!url) return '';
  const clean = url.trim();
  if (clean.startsWith('//')) return `https:${clean}`;
  if (!/^https?:\/\//i.test(clean)) return '';
  // Only ever hotlink over https; http images are blocked as mixed content on Pages.
  return clean.replace(/^http:\/\//i, 'https://');
}

const PARA = '\u0000';

/**
 * Reduce syndicated article HTML to plain-text paragraphs.
 *
 * Plain text, not HTML: feed content is untrusted third-party input, and the
 * reader renders these with textContent, so there is no path from a hostile or
 * compromised feed to script execution in the page.
 */
function htmlToParagraphs(html) {
  if (!html) return [];
  let s = String(html).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // Elements whose text is furniture rather than article, dropped whole.
  s = s.replace(/<(script|style|noscript|iframe|form|figcaption|aside)\b[\s\S]*?<\/\1>/gi, ' ');

  // Mark paragraph boundaries before the tags are stripped.
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section)\s*>/gi, PARA);
  s = s.replace(/(<br\s*\/?>\s*){2,}/gi, PARA);

  s = stripTags(s);
  s = decodeEntities(s);
  if (TAG.test(s)) {
    TAG.lastIndex = 0;
    s = stripTags(s);
  }
  TAG.lastIndex = 0;

  return s
    .split(PARA)
    .map((para) => para.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((para) => !BOILERPLATE.test(para));
}

const BOILERPLATE =
  /^(the post .+ appeared first on|read more|continue reading|share (this|on)|related (stories|articles)|advertisement|sign up|subscribe|follow us|click here|photo:|image:|source:)/i;

const MAX_PARAGRAPHS = 80;
const MAX_BODY_CHARS = 20000;
/* Below this a "body" is just the teaser again, and a reader view adds nothing. */
const MIN_BODY_CHARS = 320;

/**
 * The article body as the publisher chose to syndicate it, or null.
 *
 * Only what the feed itself carries is used. Nothing is fetched from the
 * publisher's site, so a metered article stays metered.
 */
function pickBody(block) {
  for (const tag of ['content:encoded', 'content', 'description']) {
    const found = firstTag(block, tag.replace(':', '\\:'));
    if (!found) continue;
    let paragraphs = htmlToParagraphs(found.inner).slice(0, MAX_PARAGRAPHS);

    let total = 0;
    const capped = [];
    for (const para of paragraphs) {
      if (total + para.length > MAX_BODY_CHARS) break;
      capped.push(para);
      total += para.length;
    }
    if (total >= MIN_BODY_CHARS) return capped;
  }
  return null;
}

function pickSummary(block) {
  for (const tag of ['description', 'summary', 'content:encoded', 'content', 'subtitle']) {
    const found = firstTag(block, tag.replace(':', '\\:'));
    if (!found) continue;
    const text = toText(found.inner);
    if (text) return truncate(text, 260);
  }
  return '';
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/* ------------------------------------------------------------------ pipeline */

/** Strip tracking noise so the same article from two feeds dedupes to one key. */
function canonicalLink(link) {
  try {
    const u = new URL(link);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|cmpid|at_)/i.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.replace(/^www\./i, '');
    return u.toString().replace(/\/$/, '');
  } catch {
    return link;
  }
}

function titleKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

const compact = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Strip the attribution Google News appends to every headline.
 *
 * The appended name is whatever Google calls the publisher, which is not
 * always what we call it: a bernama.com query returns items credited to
 * "majujohor.bernama.com". So the trailing segment is removed when it reduces
 * to something containing the source's own name — which catches subdomains and
 * variants like "The Star Online" — and left alone otherwise, so a headline
 * that simply ends in a dash keeps its words.
 */
function stripAttribution(title, source) {
  const match = /^([\s\S]+?)\s*[-–—|]\s*([^-–—|]{1,60})$/.exec(title);
  if (!match) return title;
  const [, head, tail] = match;
  if (!head.trim()) return title;
  return compact(tail).includes(compact(source)) ? head.trim() : title;
}

/**
 * Normalisation for feeds that carry a publisher's headlines rather than the
 * publisher's own feed.
 *
 * Google News search feeds append the publisher to every headline, and use the
 * description for a block of markup rather than a summary, so both are
 * corrected here instead of being shown as-is.
 */
function applyFeedQuirks(article, feed) {
  if (feed.via !== 'google-news') return article;

  article.title = stripAttribution(article.title, feed.source);
  // The description is a link blob, and there is no syndicated article text.
  article.summary = '';
  article.body = null;
  return article;
}

function parseFeed(xml, feed) {
  const { kind, blocks } = splitEntries(xml);
  if (!blocks.length) throw new Error('no <item> or <entry> elements found');

  const articles = [];
  for (const block of blocks) {
    const titleTag = firstTag(block, 'title');
    const title = toText(titleTag ? titleTag.inner : '');
    const link = pickLink(block, kind).trim();
    if (!title || !link) continue;

    const canonical = canonicalLink(link);
    const body = pickBody(block);
    articles.push(applyFeedQuirks({
      id: hash(canonical),
      title,
      link,
      canonical,
      summary: pickSummary(block),
      image: pickImage(block),
      published: pickDate(block),
      source: feed.source,
      feedId: feed.id,
      topic: feed.topic,
      body
    }, feed));
  }
  return articles;
}

async function fetchFeed(feed, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const body = await res.text();
    if (!body.trim()) throw new Error('empty response body');
    return parseFeed(body, feed);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------- optional API supplement */

/**
 * Optional enrichment. Off unless NEWS_API_KEY is present in the environment
 * (a repository secret consumed by the workflow, never committed and never
 * exposed to the browser — the key is used here, at build time, and only the
 * resulting headlines are published).
 *
 *   NEWS_API_KEY       the key
 *   NEWS_API_PROVIDER  "gnews" (default) or "newsapi"
 *   NEWS_API_COUNTRY   ISO country code, default "my"
 */
async function fetchApiSupplement(timeoutMs) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];

  const provider = (process.env.NEWS_API_PROVIDER || 'gnews').toLowerCase();
  const country = process.env.NEWS_API_COUNTRY || 'my';
  const url =
    provider === 'newsapi'
      ? `https://newsapi.org/v2/top-headlines?country=${encodeURIComponent(country)}&pageSize=40&apiKey=${encodeURIComponent(key)}`
      : `https://gnews.io/api/v4/top-headlines?country=${encodeURIComponent(country)}&lang=en&max=25&apikey=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const items = body.articles || [];
    const mapped = items
      .map((item) => {
        const link = item.url || '';
        const title = (item.title || '').trim();
        if (!link || !title) return null;
        const canonical = canonicalLink(link);
        return {
          id: hash(canonical),
          title,
          link,
          canonical,
          summary: truncate((item.description || '').replace(/\s+/g, ' ').trim(), 260),
          image: normaliseImageUrl(item.image || item.urlToImage || ''),
          published: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
          source: (item.source && (item.source.name || item.source.title)) || 'Wire',
          feedId: `api:${provider}`,
          topic: 'malaysia'
        };
      })
      .filter(Boolean);
    console.log(`  ok    ${`api:${provider}`.padEnd(18)} ${mapped.length} items`);
    return mapped;
  } catch (err) {
    console.warn(`  FAIL  ${`api:${provider}`.padEnd(18)} ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function readPreviousBodies() {
  try {
    const parsed = JSON.parse(await readFile(BODIES_PATH, 'utf8'));
    return parsed.bodies || {};
  } catch {
    return {};
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function scoreArticle(article, now) {
  // Top Stories ranking: recency, with a nudge for items that carry imagery
  // (a mosaic built entirely of text tiles reads badly) and for Malaysian desks.
  const published = article.published ? Date.parse(article.published) : now - 36e5 * 12;
  const ageHours = Math.max(0, (now - published) / 36e5);
  let score = 100 - ageHours * 2.5;
  if (article.image) score += 12;
  if (article.topic === 'malaysia') score += 10;
  if (article.topic === 'opinion') score -= 8;
  return score;
}

/* ----------------------------------------------------------------- probes */

/**
 * Try candidate feed URLs and report what came back, without adding any of
 * them to the site.
 *
 * Publishers move their feeds, and the URLs cannot be checked from a dev
 * machine behind an egress policy. Listing candidates under "probe" in the
 * config gets them checked by the runner, which can reach them, so a working
 * URL is promoted to a real feed on evidence rather than on a guess — and a
 * wrong guess never reaches the site's "feeds unavailable" banner.
 */
async function runProbes(config, timeoutMs) {
  const probes = config.probe || [];
  if (!probes.length) return;

  console.log(`\nKertas: probing ${probes.length} candidate URLs (not published)`);
  for (const candidate of probes) {
    const label = candidate.id.padEnd(26);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(candidate.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, */*' }
      });
      if (!res.ok) {
        console.log(`  probe FAIL ${label} HTTP ${res.status}`);
        continue;
      }
      const body = await res.text();
      const { kind, blocks } = splitEntries(body);
      if (!blocks.length) {
        console.log(`  probe FAIL ${label} HTTP 200 but no items — not a feed (${body.length} bytes)`);
        continue;
      }
      const parsed = parseFeed(body, { id: candidate.id, source: 'probe', topic: 'probe' });
      const bodied = parsed.filter((a) => a.body && a.body.length).length;
      console.log(
        `  probe OK   ${label} ${kind} · ${blocks.length} items · ` +
          `${parsed.filter((a) => a.image).length} with images · ${bodied} with full text` +
          (res.url !== candidate.url ? ` · redirected to ${res.url}` : '')
      );
    } catch (err) {
      console.log(`  probe FAIL ${label} ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log('');
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const { maxItemsPerFeed, maxAgeDays, timeoutMs, topStoriesSize } = config.fetch;
  const enabled = config.feeds.filter((f) => f.enabled !== false);
  const previous = await readPrevious();
  const now = Date.now();
  const cutoff = now - maxAgeDays * 864e5;

  console.log(`Kertas: fetching ${enabled.length} feeds`);
  await runProbes(config, timeoutMs);

  const results = await Promise.all(
    enabled.map(async (feed) => {
      try {
        const articles = await fetchFeed(feed, timeoutMs);
        const bodied = articles.filter((a) => a.body && a.body.length);
        const chars = bodied.map((a) => a.body.join(' ').length);
        console.log(
          `  ok    ${feed.id.padEnd(18)} ${String(articles.length).padStart(3)} items` +
            `  ·  full text: ${String(bodied.length).padStart(3)}/${articles.length}` +
            (bodied.length ? `  median ${median(chars)} chars` : '')
        );
        return { feed, articles, ok: true };
      } catch (err) {
        const carried = previous
          ? previous.articles.filter((a) => a.feedId === feed.id)
          : [];
        console.warn(
          `  FAIL  ${feed.id.padEnd(18)} ${err.message}` +
            (carried.length ? ` — carrying ${carried.length} previous items` : '')
        );
        return { feed, articles: carried, ok: false };
      }
    })
  );

  const failures = results.filter((r) => !r.ok).map((r) => r.feed.id);
  const supplement = await fetchApiSupplement(timeoutMs);
  if (supplement.length) results.push({ feed: { id: 'api' }, articles: supplement, ok: true });

  // Trim per feed before merging so one prolific publisher cannot dominate.
  const merged = [];
  for (const { feed, articles } of results) {
    const fresh = articles
      .filter((a) => !a.published || Date.parse(a.published) >= cutoff)
      .sort((a, b) => (Date.parse(b.published || 0) || 0) - (Date.parse(a.published || 0) || 0))
      .slice(0, feed.maxItems || maxItemsPerFeed);
    merged.push(...fresh);
  }

  // De-duplicate: same canonical URL, or same headline from the same publisher.
  const seen = new Set();
  const deduped = [];
  for (const article of merged.sort(
    (a, b) => (Date.parse(b.published || 0) || 0) - (Date.parse(a.published || 0) || 0)
  )) {
    // Items carried forward from a previous run have had `canonical` stripped
    // before being written, so derive it rather than trusting the field.
    const canonical = article.canonical || canonicalLink(article.link);
    const keys = [`u:${canonical}`, `t:${article.source}|${titleKey(article.title)}`];
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    delete article.canonical;
    deduped.push(article);
  }

  // Bodies are held separately and carried forward for items whose feed was
  // down, so a reader view does not empty out during an outage.
  const previousBodies = await readPreviousBodies();
  const bodies = {};
  for (const article of deduped) {
    const body = article.body && article.body.length ? article.body : previousBodies[article.id];
    if (body && body.length) bodies[article.id] = body;
    article.hasBody = Boolean(bodies[article.id]);
    delete article.body;
  }

  const topIds = new Set(
    [...deduped]
      .sort((a, b) => scoreArticle(b, now) - scoreArticle(a, now))
      .slice(0, topStoriesSize)
      .map((a) => a.id)
  );
  for (const article of deduped) article.top = topIds.has(article.id);

  const payload = {
    generatedAt: new Date(now).toISOString(),
    site: config.site,
    topics: config.topics,
    sources: [...new Set(deduped.map((a) => a.source))].sort(),
    counts: config.topics.reduce((acc, t) => {
      acc[t.id] = t.id === 'top'
        ? deduped.filter((a) => a.top).length
        : deduped.filter((a) => a.topic === t.id).length;
      return acc;
    }, {}),
    failedFeeds: failures,
    withBody: Object.keys(bodies).length,
    articles: deduped
  };

  // Only a total wipeout is a build failure; partial outages are normal. Fail
  // before writing, so a wipeout leaves the previous data file untouched
  // rather than replacing a stale site with an empty one.
  if (!deduped.length) {
    console.error('Kertas: no articles produced — leaving the existing data in place.');
    process.exitCode = 1;
    return;
  }

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
  await writeFile(
    BODIES_PATH,
    `${JSON.stringify({ generatedAt: payload.generatedAt, bodies }, null, 1)}\n`,
    'utf8'
  );

  const bodyCount = Object.keys(bodies).length;
  console.log(
    `Kertas: wrote ${deduped.length} articles from ${payload.sources.length} sources` +
      `, ${bodyCount} with syndicated full text (${Math.round((100 * bodyCount) / deduped.length)}%)` +
      (failures.length ? ` (${failures.length} feed(s) failed: ${failures.join(', ')})` : '')
  );
}

main().catch((err) => {
  console.error('Kertas: fatal', err);
  process.exitCode = 1;
});
