/* FlixMine web client — consumes the same GitHub-hosted catalog as the TV app. */

const CATALOG_URL = 'https://raw.githubusercontent.com/neekogaming/FreeFlix/main/movies.json';
const CHANNELS_URL = 'https://raw.githubusercontent.com/neekogaming/FreeFlix/main/approved_channels.json';

const TABS = ['Home', 'All', 'Action', 'Comedy', 'Drama', 'Thriller', 'Sci-Fi', 'Family', 'Horror'];
// TMDB genre names don't always match tab labels 1:1
const GENRE_ALIASES = { 'Sci-Fi': 'Science Fiction' };

const state = {
  movies: [],
  channels: [],
  activeTab: 'Home',
  heroMovie: null,
};

const $ = (id) => document.getElementById(id);

/* ---------- helpers ---------- */
const posterUrl = (m) => m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null;
const backdropUrl = (m) => m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null;
const year = (m) => (m.release_date || '').substring(0, 4);
const runtimeFmt = (m) => {
  if (!m.runtime) return null;
  const h = Math.floor(m.runtime / 60), min = m.runtime % 60;
  return h > 0 ? `${h}h ${min}m` : `${min}m`;
};
const channelFor = (m) => state.channels.find((c) => c.id === m.channel_id) || null;
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const genreMatch = (m, tab) => {
  const target = GENRE_ALIASES[tab] || tab;
  return (m.genres || []).some((g) => g.name === target || g.name === tab);
};

const YT_ICON = `<svg class="yt-icon" viewBox="0 0 28 20"><path fill="#FF0000" d="M27.4 3.1A3.5 3.5 0 0 0 25 .7C22.8 0 14 0 14 0S5.2 0 3 .7A3.5 3.5 0 0 0 .6 3.1 36.6 36.6 0 0 0 0 10a36.6 36.6 0 0 0 .6 6.9A3.5 3.5 0 0 0 3 19.3c2.2.7 11 .7 11 .7s8.8 0 11-.7a3.5 3.5 0 0 0 2.4-2.4A36.6 36.6 0 0 0 28 10a36.6 36.6 0 0 0-.6-6.9z"/><path fill="#fff" d="M11.2 14.3 18.5 10l-7.3-4.3z"/></svg>`;

/* ---------- boot ---------- */
async function boot() {
  try {
    const [moviesRes, channelsRes] = await Promise.all([fetch(CATALOG_URL), fetch(CHANNELS_URL)]);
    if (!moviesRes.ok) throw new Error(`catalog HTTP ${moviesRes.status}`);
    state.movies = (await moviesRes.json()).filter((m) => m.status === 'active');
    // Same fallback as the TV app: bundled channels file if GitHub copy is missing
    if (channelsRes.ok) {
      state.channels = await channelsRes.json();
    } else {
      const local = await fetch('channels.json');
      state.channels = local.ok ? await local.json() : [];
    }
  } catch (err) {
    const el = $('splash-status');
    el.textContent = 'Could not load the catalog. Check your connection and refresh.';
    el.classList.add('error');
    return;
  }
  $('splash').hidden = true;
  $('browse').hidden = false;
  $('site-footer').hidden = false;
  renderTabs();
  renderBrowse();
}

/* ---------- nav tabs ---------- */
function renderTabs() {
  const tabsEl = $('tabs');
  tabsEl.innerHTML = '';
  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (tab === state.activeTab ? ' active' : '');
    btn.textContent = tab;
    btn.addEventListener('click', () => {
      state.activeTab = tab;
      renderTabs();
      renderBrowse();
      window.scrollTo({ top: 0 });
    });
    tabsEl.appendChild(btn);
  }
}

/* ---------- hero ---------- */
function setHero(movie) {
  state.heroMovie = movie;
  const bd = backdropUrl(movie);
  $('hero-backdrop').style.backgroundImage = bd ? `url(${bd})` : 'none';

  const ch = channelFor(movie);
  const meta = [];
  if (movie.vote_average) meta.push(`<span class="rating-badge">★ ${movie.vote_average.toFixed(1)}</span>`);
  const parts = [year(movie), runtimeFmt(movie), (movie.genres || []).slice(0, 3).map((g) => g.name).join(', ')]
    .filter(Boolean);
  meta.push(parts.map((p) => `<span class="meta-text">${p}</span>`).join('<span class="meta-dot">·</span>'));

  $('hero-content').innerHTML = `
    <h1 class="hero-title">${escapeHtml(movie.title)}</h1>
    <div class="meta-row">${meta.join('')}</div>
    <p class="hero-overview">${escapeHtml(movie.overview || '')}</p>
    <div class="source-row">
      <span class="yt-label">${YT_ICON} Free on YouTube</span>
      ${channelPill(ch)}
    </div>`;
  $('hero-content').style.cursor = 'pointer';
  $('hero-content').onclick = () => openDetail(movie);
}

function channelPill(ch) {
  if (!ch) return '';
  const logo = ch.logo_url ? `<img src="${ch.logo_url}" alt="">` : '';
  return `<span class="channel-pill${ch.logo_url ? '' : ' no-logo'}">${logo}via ${escapeHtml(ch.name)}</span>`;
}

/* ---------- browse rows ---------- */
function buildRows() {
  const movies = state.movies;
  if (state.activeTab === 'Home') {
    const rows = [
      ['For You', shuffle(movies).slice(0, 15)],
      ['New on FlixMine', movies.slice(-10).reverse()],
      ['Popular', [...movies].sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0)).slice(0, 15)],
    ];
    // + up to 2 random genre rows that actually have movies
    const genreTabs = shuffle(TABS.slice(2)).filter((t) => movies.some((m) => genreMatch(m, t)));
    for (const t of genreTabs.slice(0, 2)) rows.push([t, movies.filter((m) => genreMatch(m, t))]);
    return rows.filter(([, list]) => list.length > 0);
  }
  const pool = state.activeTab === 'All' ? movies : movies.filter((m) => genreMatch(m, state.activeTab));
  const rows = [];
  for (let i = 0; i < pool.length; i += 10) {
    rows.push([i === 0 ? `${state.activeTab} · ${pool.length} movies` : '', pool.slice(i, i + 10)]);
  }
  return rows;
}

function renderBrowse() {
  const rowsEl = $('rows');
  rowsEl.innerHTML = '';
  const rows = buildRows();

  let first = true;
  for (const [title, list] of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    if (title) {
      const h = document.createElement('div');
      h.className = 'row-header';
      h.textContent = title;
      row.appendChild(h);
    }
    const scroller = document.createElement('div');
    scroller.className = 'row-scroller';
    for (const movie of list) {
      scroller.appendChild(posterCard(movie));
    }
    row.appendChild(scroller);
    rowsEl.appendChild(row);
    if (first && list.length) { setHero(list[0]); first = false; }
  }

  if (!rows.length) {
    rowsEl.innerHTML = '<div class="row-header">No movies in this category yet.</div>';
    $('hero-content').innerHTML = '';
    $('hero-backdrop').style.backgroundImage = 'none';
  }
}

function posterCard(movie) {
  const btn = document.createElement('button');
  btn.className = 'poster-card';
  btn.setAttribute('aria-label', movie.title || 'Movie');
  const p = posterUrl(movie);
  btn.innerHTML = p
    ? `<img src="${p}" alt="${escapeHtml(movie.title || '')}" loading="lazy">`
    : `<span class="poster-fallback">${escapeHtml(movie.title || 'Untitled')}</span>`;
  // TV behavior: focusing a poster updates the hero; clicking opens detail
  btn.addEventListener('mouseenter', () => { if (!$('browse').hidden) setHero(movie); });
  btn.addEventListener('focus', () => { if (!$('browse').hidden) setHero(movie); });
  btn.addEventListener('click', () => openDetail(movie));
  return btn;
}

/* ---------- detail ---------- */
function openDetail(movie) {
  const ch = channelFor(movie);
  const bd = backdropUrl(movie);
  $('detail-backdrop').style.backgroundImage = bd ? `url(${bd})` : 'none';

  const metaParts = [year(movie), runtimeFmt(movie), (movie.genres || []).map((g) => g.name).join(', ')].filter(Boolean);
  const credits = [];
  if (movie.director) credits.push(`<div class="credit-line"><span class="label">Director&nbsp;&nbsp;</span><span class="names">${escapeHtml(movie.director)}</span></div>`);
  if (movie.cast && movie.cast.length) credits.push(`<div class="credit-line"><span class="label">Cast&nbsp;&nbsp;</span><span class="names">${escapeHtml(movie.cast.join(', '))}</span></div>`);

  $('detail-body').innerHTML = `
    <div class="detail-poster">${
      posterUrl(movie)
        ? `<img src="${posterUrl(movie)}" alt="${escapeHtml(movie.title || '')}">`
        : `<span class="poster-fallback">${escapeHtml(movie.title || '')}</span>`
    }</div>
    <div class="detail-info">
      <h1 class="detail-title">${escapeHtml(movie.title)}</h1>
      <div class="meta-row">
        ${movie.vote_average ? `<span class="rating-badge">★ ${movie.vote_average.toFixed(1)}</span>` : ''}
        ${metaParts.map((p) => `<span class="meta-text">${p}</span>`).join('<span class="meta-dot">·</span>')}
      </div>
      <p class="detail-overview">${escapeHtml(movie.overview || '')}</p>
      <div class="credits">${credits.join('')}</div>
      <div class="detail-actions">
        <button class="btn-watch" id="btn-play">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>
          Watch Now
        </button>
        <a class="btn-youtube" href="https://www.youtube.com/watch?v=${encodeURIComponent(movie.video_id)}" target="_blank" rel="noopener">
          ${YT_ICON} Open on YouTube
        </a>
        ${channelPill(ch)}
      </div>
      <div class="detail-attribution">Free on YouTube${ch ? ` via ${escapeHtml(ch.name)}` : ''} · Movie data provided by TMDB</div>
    </div>`;

  $('btn-play').addEventListener('click', () => openPlayer(movie));
  $('detail').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  $('detail').hidden = true;
  document.body.style.overflow = '';
}

/* ---------- player ---------- */
function openPlayer(movie) {
  $('player-frame').innerHTML =
    `<iframe src="https://www.youtube.com/embed/${encodeURIComponent(movie.video_id)}?autoplay=1"
      title="${escapeHtml(movie.title || 'Player')}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen></iframe>`;
  $('player').hidden = false;
}

function closePlayer() {
  $('player-frame').innerHTML = '';
  $('player').hidden = true;
}

/* ---------- search ---------- */
function openSearch() {
  $('search').hidden = false;
  document.body.style.overflow = 'hidden';
  renderSearchResults('');
  $('search-input').value = '';
  $('search-input').focus();
}

function closeSearch() {
  $('search').hidden = true;
  document.body.style.overflow = '';
}

function renderSearchResults(query) {
  const q = query.trim().toLowerCase();
  const results = q
    ? state.movies.filter((m) =>
        (m.title || '').toLowerCase().includes(q) ||
        (m.genres || []).some((g) => g.name.toLowerCase().includes(q)) ||
        (m.cast || []).some((c) => c.toLowerCase().includes(q)) ||
        (m.director || '').toLowerCase().includes(q))
    : state.movies;
  const el = $('search-results');
  el.innerHTML = '';
  if (!results.length) {
    el.innerHTML = `<div class="search-empty">No movies found for “${escapeHtml(query)}”.</div>`;
    return;
  }
  for (const m of results) {
    const card = posterCard(m);
    card.addEventListener('click', closeSearch);
    el.appendChild(card);
  }
}

/* ---------- about ---------- */
function openAbout() { $('about').hidden = false; document.body.style.overflow = 'hidden'; }
function closeAbout() { $('about').hidden = true; document.body.style.overflow = ''; }

/* ---------- misc ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('btn-back').addEventListener('click', closeDetail);
$('btn-search').addEventListener('click', openSearch);
$('btn-search-close').addEventListener('click', closeSearch);
$('btn-about').addEventListener('click', openAbout);
$('btn-about-close').addEventListener('click', closeAbout);
$('btn-player-close').addEventListener('click', closePlayer);
$('search-input').addEventListener('input', (e) => renderSearchResults(e.target.value));
document.querySelector('.logo').addEventListener('click', (e) => {
  e.preventDefault();
  closeDetail(); closeSearch(); closeAbout(); closePlayer();
  state.activeTab = 'Home';
  renderTabs(); renderBrowse();
  window.scrollTo({ top: 0 });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('player').hidden) closePlayer();
  else if (!$('detail').hidden) closeDetail();
  else if (!$('search').hidden) closeSearch();
  else if (!$('about').hidden) closeAbout();
});

boot();
