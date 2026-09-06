/* =========================================================================
   Kertas — client application.

   Responsibilities, in order:
     1. Load data/articles.json (written by scripts/fetch-feeds.mjs).
     2. Pack articles into fixed-height magazine pages using layout templates.
     3. Turn between pages with a horizontal fold.
     4. Sections, search and filters, save-for-later, theme.

   There is no framework and no build step. Everything runs from static files.
   ========================================================================= */

const DATA_URL = 'data/articles.json';
const BODIES_URL = 'data/bodies.json';
const STORE_SAVED = 'kertas.saved.v1';
const STORE_THEME = 'kertas.theme.v1';

/* ---------------------------------------------------- layout templates ---

   Each template is a list of grid areas over a 12-column / 8-row page, given
   as [rowStart, colStart, rowEnd, colEnd]. Slot size class is derived from the
   area so typography scales with the space available.
   ------------------------------------------------------------------------ */

const TEMPLATES = {
  wide: [
    [[1, 1, 6, 8], [1, 8, 4, 13], [4, 8, 6, 13], [6, 1, 9, 5], [6, 5, 9, 9], [6, 9, 9, 13]],
    [[1, 1, 5, 6], [1, 6, 5, 13], [5, 1, 9, 4], [5, 4, 9, 8], [5, 8, 9, 13]],
    [[1, 1, 9, 6], [1, 6, 4, 13], [4, 6, 7, 10], [4, 10, 7, 13], [7, 6, 9, 13]],
    [[1, 1, 4, 5], [1, 5, 6, 13], [4, 1, 9, 5], [6, 5, 9, 9], [6, 9, 9, 13]],
    [[1, 1, 5, 7], [1, 7, 5, 13], [5, 1, 9, 5], [5, 5, 9, 9], [5, 9, 9, 13]],
    [[1, 1, 6, 9], [1, 9, 4, 13], [4, 9, 7, 13], [6, 1, 9, 5], [6, 5, 9, 9], [7, 9, 9, 13]]
  ],
  medium: [
    [[1, 1, 5, 13], [5, 1, 7, 7], [5, 7, 7, 13], [7, 1, 9, 13]],
    [[1, 1, 4, 13], [4, 1, 7, 13], [7, 1, 9, 7], [7, 7, 9, 13]],
    [[1, 1, 5, 7], [1, 7, 5, 13], [5, 1, 9, 13]]
  ],
  narrow: [
    [[1, 1, 5, 13], [5, 1, 7, 13], [7, 1, 9, 13]],
    [[1, 1, 4, 13], [4, 1, 7, 13], [7, 1, 9, 13]]
  ]
};

function breakpoint() {
  const w = window.innerWidth;
  if (w < 680) return 'narrow';
  if (w < 1080) return 'medium';
  return 'wide';
}

function slotSize([r1, c1, r2, c2]) {
  const area = (r2 - r1) * (c2 - c1);
  if (area >= 40) return 'xl';
  if (area >= 22) return 'lg';
  if (area >= 10) return 'md';
  return 'sm';
}

/* --------------------------------------------------------------- state --- */

const state = {
  data: null,
  topic: 'top',
  view: 'section',          // 'section' | 'saved'
  pages: [],
  index: 0,
  busy: false,
  saved: loadSaved(),
  bp: breakpoint()
};

const el = (id) => document.getElementById(id);
const dom = {
  stage: el('stage'), empty: el('empty'), emptyBody: el('empty-body'),
  sections: el('sections-list'), notice: el('notice'),
  pagerCount: el('pager-count'), prev: el('btn-prev'), next: el('btn-next'),
  colophon: el('colophon-line'),
  panel: el('search-panel'), scrim: el('scrim'),
  searchInput: el('search-input'), searchResults: el('search-results'),
  searchTally: el('search-tally'),
  filterTopic: el('filter-topic'), filterSource: el('filter-source'),
  savedCount: el('saved-count'), btnSaved: el('btn-saved'),
  tpl: el('tpl-tile'),
  reader: el('reader'), readerSheet: null,
  readerArt: el('reader-art'), readerImage: el('reader-image'),
  readerSource: el('reader-source'), readerTime: el('reader-time'),
  readerTitle: el('reader-title'), readerBody: el('reader-body'),
  readerNote: el('reader-note'), readerLink: el('reader-link'),
  readerSave: el('reader-save'), readerClose: el('reader-close'),
  readerScrim: el('reader-scrim')
};

/* ------------------------------------------------------------ storage --- */

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORE_SAVED);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSaved() {
  try {
    localStorage.setItem(STORE_SAVED, JSON.stringify(state.saved.slice(0, 300)));
  } catch {
    /* Private mode, or storage disabled. Saving degrades to this session only. */
  }
  const n = state.saved.length;
  dom.savedCount.textContent = String(n);
  dom.savedCount.hidden = n === 0;
}

const isSaved = (id) => state.saved.some((a) => a.id === id);

function toggleSaved(article) {
  if (isSaved(article.id)) {
    state.saved = state.saved.filter((a) => a.id !== article.id);
  } else {
    // Store a snapshot: feeds rotate, and a saved story must survive that.
    state.saved.unshift({
      id: article.id, title: article.title, link: article.link,
      summary: article.summary, image: article.image,
      published: article.published, source: article.source, topic: article.topic
    });
  }
  persistSaved();
  if (state.view === 'saved') build({ keepIndex: true });
  else refreshSaveButtons();
}

function refreshSaveButtons() {
  document.querySelectorAll('.tile__save').forEach((btn) => {
    const on = isSaved(btn.dataset.id);
    btn.classList.toggle('is-saved', on);
    btn.setAttribute('aria-label', on ? 'Remove from saved' : 'Save this story');
  });
}

/* --------------------------------------------------------------- theme --- */

/** Stamp an explicit choice, or clear it so the system setting governs. */
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function storedTheme() {
  try {
    const value = localStorage.getItem(STORE_THEME);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** What the reader is actually seeing, stored choice or system default. */
function effectiveTheme() {
  return storedTheme() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

/* ---------------------------------------------------------- formatting --- */

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function relativeTime(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((then - Date.now()) / 60000);
  const abs = Math.abs(mins);
  if (abs < 60) return rtf.format(mins, 'minute');
  if (abs < 60 * 36) return rtf.format(Math.round(mins / 60), 'hour');
  return rtf.format(Math.round(mins / 1440), 'day');
}

const GROUNDS = 5;

/* Grounds come from the five editorial colours in the stylesheet rather than
   from anywhere on the hue circle: a page of text pieces should look like one
   publication, not a paint chart.

   The seed is the article id, so a story keeps its colour, but the low bits of
   a plain rolling hash are too regular to pick one of five evenly — hence the
   avalanche step before the modulo. */
function groundSeed(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) % GROUNDS;
}

/* An even hash still lets two neighbours land on the same colour, and a page
   carrying four identical blocks looks like a mistake rather than a palette.
   Walk the page in reading order and push a repeat on to the next colour. */
function assignGrounds(slots) {
  const recent = [];
  for (const slot of slots) {
    if (!slot.article) continue;
    let g = groundSeed(slot.article.id);
    let tries = 0;
    while (recent.includes(g) && tries < GROUNDS) { g = (g + 1) % GROUNDS; tries += 1; }
    recent.push(g);
    if (recent.length > 2) recent.shift();
    slot.ground = g + 1;
  }
}

/* --------------------------------------------------------- page build --- */

function articlesForView() {
  if (state.view === 'saved') return state.saved;
  const all = state.data.articles;
  return state.topic === 'top'
    ? all.filter((a) => a.top)
    : all.filter((a) => a.topic === state.topic);
}

/**
 * Pack articles into pages. Within each page the largest slots go to articles
 * that carry imagery, so a hero is never a bare text block while a thumbnail
 * sits beside it holding a photograph.
 */
function paginate(articles) {
  const templates = TEMPLATES[state.bp];
  const pages = [];
  let cursor = 0;
  let t = 0;

  while (cursor < articles.length) {
    const template = templates[t % templates.length];
    t += 1;
    const chunk = articles.slice(cursor, cursor + template.length);
    cursor += chunk.length;

    const slots = template
      .slice(0, chunk.length)
      .map((area, i) => ({ area, size: slotSize(area), order: i }))
      .sort((a, b) => {
        const rank = { xl: 3, lg: 2, md: 1, sm: 0 };
        return rank[b.size] - rank[a.size];
      });

    const withArt = chunk.filter((a) => a.image);
    const withoutArt = chunk.filter((a) => !a.image);
    const queue = [...withArt, ...withoutArt];

    const placed = slots
      .map((slot, i) => ({ ...slot, article: queue[i] }))
      .sort((a, b) => a.order - b.order);

    pages.push(placed);
  }
  return pages;
}

function buildTile({ area, size, article, ground }) {
  const node = dom.tpl.content.firstElementChild.cloneNode(true);
  const [r1, c1, r2, c2] = area;
  node.style.gridArea = `${r1} / ${c1} / ${r2} / ${c2}`;
  node.classList.add(`tile--${size}`);
  node.classList.add(article.image ? 'has-art' : 'no-art');

  const link = node.querySelector('.tile__link');
  link.href = article.link || '#';
  if (!article.link || article.link === '#') {
    link.removeAttribute('target');
    link.setAttribute('aria-disabled', 'true');
  }

  // Every tile carries a ground: it backs a photograph while it loads, and it
  // is the whole design of a tile that has none. Held as a custom property
  // reference so the colour follows a theme change without a re-render.
  node.style.setProperty('--ground', `var(--ground-${ground || 1})`);

  const img = node.querySelector('img');
  if (article.image) {
    img.src = article.image;
    img.alt = '';
    // A dead hotlink must not leave a grey rectangle in the middle of a page.
    // Dropping to no-art turns it into a text piece, which is a finished
    // design rather than a fallback.
    img.addEventListener('error', () => {
      node.classList.remove('has-art');
      node.classList.add('no-art');
    }, { once: true });
  }

  node.querySelector('.tile__source').textContent = article.source;
  node.querySelector('.tile__time').textContent = relativeTime(article.published);
  node.querySelector('.tile__title').textContent = article.title;
  node.querySelector('.tile__summary').textContent = article.summary || '';

  wireStoryOpen(link, article);

  const save = node.querySelector('.tile__save');
  save.dataset.id = article.id;
  save.classList.toggle('is-saved', isSaved(article.id));
  save.setAttribute('aria-label', isSaved(article.id) ? 'Remove from saved' : 'Save this story');
  save.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSaved(article);
  });

  return node;
}

function renderPage(i) {
  const page = document.createElement('div');
  page.className = 'page';
  const slots = state.pages[i] || [];
  assignGrounds(slots);
  for (const slot of slots) {
    if (slot.article) page.appendChild(buildTile(slot));
  }
  return page;
}

/* ------------------------------------------------------------- the fold --- */

/** Wrap a page copy in a clipping half. */
function half(pageIndex, which) {
  const wrap = document.createElement('div');
  wrap.className = `half half--${which}`;
  wrap.appendChild(renderPage(pageIndex));
  return wrap;
}

function paintStatic(index) {
  dom.stage.replaceChildren(half(index, 'top'), half(index, 'bottom'));
  refreshSaveButtons();
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The fold duration, read from CSS so there is a single source of truth. */
function flipDuration() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--flip-ms').trim();
  const ms = raw.endsWith('ms') ? parseFloat(raw)
    : raw.endsWith('s') ? parseFloat(raw) * 1000
    : parseFloat(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 620;
}

/**
 * Build one turning leaf: half a page, hinged at the fold.
 *
 * @param {'top'|'bottom'} region  which half of the stage it occupies
 * @param {number} pageIndex       the page whose half it shows
 * @param {number} from            starting rotation, degrees
 * @param {number} shade           starting shade opacity
 */
function makeLeaf(region, pageIndex, from, shade) {
  const leaf = document.createElement('div');
  leaf.className = `leaf leaf--${region}`;
  leaf.appendChild(renderPage(pageIndex));

  const veil = document.createElement('div');
  veil.className = 'leaf__shade';
  veil.style.opacity = String(shade);
  leaf.appendChild(veil);

  leaf.style.transform = `rotateX(${from}deg)`;
  return leaf;
}

function goTo(target) {
  if (state.busy) return;
  const last = state.pages.length - 1;
  const next = Math.max(0, Math.min(last, target));
  if (next === state.index || state.pages.length === 0) return;

  const forward = next > state.index;
  const from = state.index;
  state.index = next;
  updatePager();

  if (reducedMotion()) {
    paintStatic(next);
    return;
  }

  state.busy = true;

  // Static layers. The half the leaves uncover shows the incoming page; the
  // half they sweep across keeps the outgoing page until it is covered.
  const staticTop = half(forward ? from : next, 'top');
  const staticBottom = half(forward ? next : from, 'bottom');

  // Going forward the lower half lifts up and over; going back the upper half
  // folds down. The incoming leaf starts flipped away and lands flat.
  //
  // Sign matters and is easy to get backwards. Under CSS's axes a positive
  // rotateX brings the edge below the hinge towards the reader, so the outgoing
  // lower half lifts off the page the way a hand turns it. Negative angles fold
  // it away into the screen, which reads as the page falling over backwards.
  const outRegion = forward ? 'bottom' : 'top';
  const inRegion = forward ? 'top' : 'bottom';
  const outEnd = forward ? 180 : -180;
  const inStart = forward ? -180 : 180;

  const leafOut = makeLeaf(outRegion, from, 0, 0);
  const leafIn = makeLeaf(inRegion, next, inStart, 0.34);

  dom.stage.replaceChildren(staticTop, staticBottom, leafOut, leafIn);
  refreshSaveButtons();

  // Force a frame so each transition has a start value to animate from.
  void leafOut.offsetHeight;

  leafOut.classList.add('is-animating');
  leafIn.classList.add('is-animating');
  leafOut.style.transform = `rotateX(${outEnd}deg)`;
  leafIn.style.transform = 'rotateX(0deg)';
  leafOut.querySelector('.leaf__shade').style.opacity = '0.34';
  leafIn.querySelector('.leaf__shade').style.opacity = '0';

  // Hand the incoming leaf's page to the static half of the same region rather
  // than re-rendering the stage. The node is already laid out and its images
  // already decoded, so the turn ends without the flash that rebuilding both
  // halves produced. The two leaf wrappers are all that need removing; the
  // other half was rendered with the incoming page when the turn began.
  const settle = () => {
    const landing = inRegion === 'top' ? staticTop : staticBottom;
    const arrived = leafIn.querySelector('.page');
    if (arrived) landing.replaceChildren(arrived);
    leafOut.remove();
    leafIn.remove();
    state.busy = false;
  };
  leafIn.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'transform') settle();
  }, { once: true });
  // Belt and braces: a dropped transitionend must not wedge navigation. The
  // guard is derived from the configured duration so retuning --flip-ms in CSS
  // cannot leave the guard firing mid-turn.
  setTimeout(() => { if (state.busy) settle(); }, flipDuration() + 260);
}

/* --------------------------------------------------------------- chrome --- */

function updatePager() {
  const total = state.pages.length;
  dom.pagerCount.textContent = total
    ? `Page ${state.index + 1} of ${total}`
    : '';
  dom.prev.disabled = state.index === 0 || total === 0;
  dom.next.disabled = state.index >= total - 1 || total === 0;
}

function renderSections() {
  const counts = state.data.counts || {};
  dom.sections.replaceChildren(
    ...state.data.topics.map((topic) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'sections__btn';
      btn.type = 'button';
      btn.dataset.topic = topic.id;
      btn.innerHTML = '';
      btn.append(topic.label);
      const n = counts[topic.id];
      if (n) {
        const sup = document.createElement('span');
        sup.className = 'n';
        sup.textContent = String(n);
        btn.appendChild(sup);
      }
      btn.addEventListener('click', () => {
        state.view = 'section';
        state.topic = topic.id;
        dom.btnSaved.classList.remove('is-on');
        build();
      });
      li.appendChild(btn);
      return li;
    })
  );
  markCurrentSection();
}

function markCurrentSection() {
  dom.sections.querySelectorAll('.sections__btn').forEach((btn) => {
    const on = state.view === 'section' && btn.dataset.topic === state.topic;
    btn.setAttribute('aria-current', on ? 'true' : 'false');
  });
}

function renderNotice() {
  const bits = [];
  if (state.data.sample) {
    bits.push(
      '<strong>Sample data.</strong> These are placeholder stories, not real news. ' +
      'The scheduled feed refresh replaces them on its first run.'
    );
  }
  const failed = state.data.failedFeeds || [];
  if (failed.length) {
    bits.push(`<strong>${failed.length} feed${failed.length > 1 ? 's' : ''} unavailable</strong> at the last refresh (${failed.join(', ')}). Older items from ${failed.length > 1 ? 'those feeds' : 'that feed'} are still shown.`);
  }
  dom.notice.innerHTML = bits.join(' ');
  dom.notice.hidden = bits.length === 0;
}

function renderColophon() {
  const when = state.data.generatedAt ? new Date(state.data.generatedAt) : null;
  const stamp = when
    ? when.toLocaleString('en-MY', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        timeZone: 'Asia/Kuala_Lumpur'
      })
    : 'unknown';
  const n = state.data.articles.length;
  const s = state.data.sources.length;
  dom.colophon.textContent = `Kertas · ${n} stories from ${s} sources · last refreshed ${stamp} (MYT)`;
}

/* ---------------------------------------------------------------- build --- */

function build({ keepIndex = false } = {}) {
  const articles = articlesForView();
  state.pages = paginate(articles);
  state.index = keepIndex ? Math.min(state.index, Math.max(0, state.pages.length - 1)) : 0;

  const empty = state.pages.length === 0;
  dom.empty.hidden = !empty;
  dom.emptyBody.textContent = state.view === 'saved'
    ? 'Stories you save are kept in this browser. Tap the bookmark on any tile to put one here.'
    : 'This section had no stories in the last refresh. Try another section, or check back after the next update.';

  if (empty) dom.stage.replaceChildren();
  else paintStatic(state.index);

  markCurrentSection();
  updatePager();
}

/* --------------------------------------------------------------- reader --- */

/**
 * Article bodies, loaded once on first use.
 *
 * Only what a publisher syndicates in their own feed is ever shown. Nothing is
 * fetched from the publisher's site, so a metered article stays metered and no
 * article text is reproduced beyond what the feed itself offers.
 */
let bodiesPromise = null;

function loadBodies() {
  if (!bodiesPromise) {
    bodiesPromise = fetch(BODIES_URL, { cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : { bodies: {} }))
      .then((data) => data.bodies || {})
      .catch(() => ({}));
  }
  return bodiesPromise;
}

let readerReturnFocus = null;
let readerArticle = null;

function renderReaderSaveButton() {
  if (!readerArticle) return;
  const on = isSaved(readerArticle.id);
  dom.readerSave.textContent = on ? 'Saved' : 'Save for later';
  dom.readerSave.classList.toggle('btn--primary', false);
  dom.readerSave.setAttribute('aria-pressed', String(on));
}

async function openReader(article, returnTo) {
  readerArticle = article;
  readerReturnFocus = returnTo || null;

  dom.readerSource.textContent = article.source;
  dom.readerTime.textContent = relativeTime(article.published);
  dom.readerTitle.textContent = article.title;
  dom.readerLink.href = article.link || '#';
  dom.readerLink.textContent = `Read the full story at ${article.source}`;
  renderReaderSaveButton();

  if (article.image) {
    dom.readerArt.hidden = false;
    dom.readerImage.src = article.image;
    dom.readerImage.addEventListener('error', () => { dom.readerArt.hidden = true; }, { once: true });
  } else {
    dom.readerArt.hidden = true;
  }

  // Show the excerpt immediately; swap in the full text once it arrives.
  dom.readerBody.replaceChildren(paragraph(article.summary || ''));
  dom.readerNote.hidden = true;

  dom.reader.hidden = false;
  document.body.style.overflow = 'hidden';
  dom.readerClose.focus();

  const bodies = await loadBodies();
  // The reader may have been closed, or moved on to another story, while the
  // bodies file was in flight.
  if (!readerArticle || readerArticle.id !== article.id || dom.reader.hidden) return;

  const body = bodies[article.id];
  if (body && body.length) {
    dom.readerBody.replaceChildren(...body.map(paragraph));
    dom.readerNote.hidden = true;
  } else {
    dom.readerBody.replaceChildren(paragraph(article.summary || ''));
    dom.readerNote.textContent =
      `${article.source} publishes only a summary in their feed, so that is all there is to show here. The full article is on their site.`;
    dom.readerNote.hidden = false;
  }
}

/** Text nodes only — feed content is never trusted as markup. */
function paragraph(text) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

function closeReader() {
  dom.reader.hidden = true;
  document.body.style.overflow = '';
  readerArticle = null;
  if (readerReturnFocus && document.contains(readerReturnFocus)) readerReturnFocus.focus();
  readerReturnFocus = null;
}

const readerOpen = () => !dom.reader.hidden;

/**
 * Open the reader on a plain left click, and leave every other click to the
 * browser so cmd-click, middle-click and "open in new tab" still reach the
 * publisher directly.
 */
function wireStoryOpen(link, article) {
  link.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!article.link || article.link === '#') return;
    e.preventDefault();
    openReader(article, link);
  });
}

/* --------------------------------------------------------------- search --- */

function openSearch() {
  dom.panel.hidden = false;
  dom.scrim.hidden = false;
  el('btn-search').setAttribute('aria-expanded', 'true');
  dom.searchInput.focus();
  runSearch();
}

function closeSearch() {
  dom.panel.hidden = true;
  dom.scrim.hidden = true;
  el('btn-search').setAttribute('aria-expanded', 'false');
  el('btn-search').focus();
}

function runSearch() {
  const q = dom.searchInput.value.trim().toLowerCase();
  const topic = dom.filterTopic.value;
  const source = dom.filterSource.value;

  const matches = state.data.articles.filter((a) => {
    if (topic && a.topic !== topic) return false;
    if (source && a.source !== source) return false;
    if (!q) return true;
    return `${a.title} ${a.summary} ${a.source}`.toLowerCase().includes(q);
  });

  dom.searchTally.textContent = matches.length
    ? `${matches.length} ${matches.length === 1 ? 'story' : 'stories'}`
    : 'No matches';

  dom.searchResults.replaceChildren(
    ...matches.slice(0, 120).map((a) => {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = a.link || '#';
      if (a.link && a.link !== '#') { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      wireStoryOpen(link, a);

      const text = document.createElement('div');
      const meta = document.createElement('p');
      meta.className = 'results__meta';
      const b = document.createElement('b');
      b.textContent = a.source;
      meta.append(b, ` · ${relativeTime(a.published)}`);
      const title = document.createElement('p');
      title.className = 'results__title';
      title.textContent = a.title;
      text.append(meta, title);
      link.appendChild(text);

      if (a.image) {
        const img = document.createElement('img');
        img.className = 'results__thumb';
        img.src = a.image;
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => img.remove(), { once: true });
        link.appendChild(img);
      }
      li.appendChild(link);
      return li;
    })
  );

  if (!matches.length) {
    const li = document.createElement('li');
    li.className = 'results__none';
    li.textContent = 'Nothing matches that. Try a shorter search, or clear the filters.';
    dom.searchResults.replaceChildren(li);
  }
}

/**
 * Back to the front: Top Stories, first page, nothing overlaying it.
 *
 * State reset rather than a reload, so the turn is instant and saved stories
 * and theme are untouched. The wordmark stays a real link, so cmd-click and
 * middle-click still open the site in a new tab.
 */
function goHome() {
  if (readerOpen()) closeReader();
  if (!dom.panel.hidden) closeSearch();
  dom.btnSaved.classList.remove('is-on');
  state.view = 'section';
  state.topic = 'top';
  build();
  dom.sections.scrollTo({ left: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

/* ---------------------------------------------------------------- input --- */

function wireEvents() {
  dom.prev.addEventListener('click', () => goTo(state.index - 1));
  dom.next.addEventListener('click', () => goTo(state.index + 1));

  el('wordmark-link').addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    goHome();
  });

  dom.readerClose.addEventListener('click', closeReader);
  dom.readerScrim.addEventListener('click', closeReader);
  dom.readerSave.addEventListener('click', () => {
    if (!readerArticle) return;
    toggleSaved(readerArticle);
    renderReaderSaveButton();
  });

  document.addEventListener('keydown', (e) => {
    // The reader sits above everything; while it is open it owns the keyboard.
    if (readerOpen()) {
      if (e.key === 'Escape') closeReader();
      return;
    }
    if (!dom.panel.hidden) {
      if (e.key === 'Escape') closeSearch();
      return;
    }
    if (e.target.matches('input, select, textarea')) return;

    if (['ArrowDown', 'PageDown', 'ArrowRight'].includes(e.key) || (e.key === ' ' && !e.shiftKey)) {
      e.preventDefault(); goTo(state.index + 1);
    } else if (['ArrowUp', 'PageUp', 'ArrowLeft'].includes(e.key) || (e.key === ' ' && e.shiftKey)) {
      e.preventDefault(); goTo(state.index - 1);
    } else if (e.key === 'Home') {
      e.preventDefault(); goTo(0);
    } else if (e.key === 'End') {
      e.preventDefault(); goTo(state.pages.length - 1);
    } else if (e.key === '/') {
      e.preventDefault(); openSearch();
    }
  });

  // Wheel: one page per gesture, not one per tick. The quiet period is tied to
  // the turn itself, so a trackpad's momentum tail cannot queue up further
  // turns behind the one already running.
  let wheelLock = 0;
  dom.stage.parentElement.addEventListener('wheel', (e) => {
    if (state.busy) return;
    if (Math.abs(e.deltaY) < 12) return;
    const now = Date.now();
    if (now - wheelLock < flipDuration() + 120) return;
    wheelLock = now;
    goTo(state.index + (e.deltaY > 0 ? 1 : -1));
  }, { passive: true });

  // Vertical swipe, matching the fold direction.
  let touchY = null;
  let touchX = null;
  const deck = dom.stage.parentElement;
  deck.addEventListener('touchstart', (e) => {
    touchY = e.touches[0].clientY;
    touchX = e.touches[0].clientX;
  }, { passive: true });
  deck.addEventListener('touchend', (e) => {
    if (touchY === null) return;
    const dy = e.changedTouches[0].clientY - touchY;
    const dx = e.changedTouches[0].clientX - touchX;
    touchY = null;
    if (Math.abs(dy) < 45 || Math.abs(dy) < Math.abs(dx)) return;
    goTo(state.index + (dy < 0 ? 1 : -1));
  }, { passive: true });

  el('btn-search').addEventListener('click', openSearch);
  el('btn-search-close').addEventListener('click', closeSearch);
  dom.scrim.addEventListener('click', closeSearch);
  dom.searchInput.addEventListener('input', runSearch);
  dom.filterTopic.addEventListener('change', runSearch);
  dom.filterSource.addEventListener('change', runSearch);

  dom.btnSaved.addEventListener('click', () => {
    state.view = state.view === 'saved' ? 'section' : 'saved';
    dom.btnSaved.classList.toggle('is-on', state.view === 'saved');
    build();
  });

  el('btn-theme').addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(STORE_THEME, next); } catch { /* ignore */ }
    applyTheme(next);
  });

  // Re-paginate when the page shape changes: a template that fits a desktop
  // stage will not fit a phone one.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const bp = breakpoint();
      if (bp === state.bp) return;
      state.bp = bp;
      build();
    }, 180);
  });
}

/* ----------------------------------------------------------------- boot --- */

async function boot() {
  // Only an explicit choice is stamped; with none, the system setting governs
  // and keeps governing if the reader changes it while the page is open.
  applyTheme(storedTheme());
  persistSaved();

  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    dom.notice.innerHTML =
      '<strong>Could not load the story file.</strong> ' +
      'If you are opening index.html directly from disk, serve the folder over HTTP instead — ' +
      'browsers block file:// fetches.';
    dom.notice.hidden = false;
    dom.pagerCount.textContent = '';
    console.error('Kertas: failed to load', DATA_URL, err);
    return;
  }

  renderSections();
  renderNotice();
  renderColophon();

  for (const t of state.data.topics) {
    if (t.id === 'top') continue;
    dom.filterTopic.appendChild(new Option(t.label, t.id));
  }
  for (const s of state.data.sources) {
    dom.filterSource.appendChild(new Option(s, s));
  }

  wireEvents();
  build();
}

boot();
