/* FlixMine Cataloger — web edition
 * Adds free YouTube movies to the FlixMine catalog with automated TMDb matching.
 * Static app: TMDb / OMDb / GitHub Contents API / noembed, all called from the browser.
 */
'use strict';

/* ============================== helpers ============================== */

const $ = id => document.getElementById(id);

const SETTINGS_KEY = 'fmc_settings';
const BATCH_KEY = 'fmc_batch';

const state = {
    settings: {
        repo: 'neekogaming/FreeFlix',
        path: 'movies.json',
        branch: 'main',
        token: '',
        remember: false,
        tmdb: '',
        omdb: '',
        yt: '',
        target: 'github'
    },
    // current single-movie workflow
    videoId: '',
    ytTitleRaw: '',
    ytChannelRaw: '',
    candidates: [],          // [{result, score, confidence}]
    selected: null,          // {result, details, imdbId}
    catalog: null,           // {movies, document, sha} — cached
    approvedChannels: [],
    batch: [],               // [{link, videoId, ytTitle, channel, status, catalogId, best, candidates}]
    batchActiveIndex: -1,    // item currently loaded in Add view
    batchRunning: false,
    channelImportBusy: false,
    appendBusy: false,
    lookupSeq: 0             // guards stale async lookups
};

function log(msg, isErr = false) {
    const li = document.createElement('li');
    const ts = new Date().toLocaleTimeString('en-GB');
    li.textContent = `${ts}  ${msg}`;
    if (isErr) li.classList.add('err');
    $('logList').prepend(li);
    while ($('logList').children.length > 200) $('logList').lastChild.remove();
    $('logLatest').textContent = msg.length > 90 ? msg.slice(0, 90) + '…' : msg;
}

function setDot(id, cls) {
    const dot = $(id);
    dot.classList.remove('ok', 'bad', 'warn');
    if (cls) dot.classList.add(cls);
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
        const msg = data?.status_message || data?.message || data?.error || `${res.status} ${res.statusText}`;
        const err = new Error(msg);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

/* base64 <-> UTF-8 (GitHub Contents API) */
function b64ToUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}
function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(bin);
}

/* ============================== YouTube ============================== */

function extractYouTubeId(text) {
    text = (text || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
    let m = text.match(/(?:[?&]v=|youtu\.be\/|embed\/|shorts\/|live\/|\/v\/)([A-Za-z0-9_-]{11})/i);
    if (!m) m = text.match(/youtube\.com\/(?:watch\?.*?v=|.*?\/)([A-Za-z0-9_-]{11})/i);
    return m ? m[1] : '';
}

function cleanTitle(title) {
    return (title || '')
        .replace(/\[[^\]]+\]|\([^)]*(?:full movie|hd|free|official)[^)]*\)/gi, ' ')
        .replace(/\b(full movie|free movie|full film|hd|4k|1080p|720p|official|english|subtitles?|subtitled|dubbed|remaster(ed)?|exclusive)\b/gi, ' ')
        .replace(/\(\s*\)|\[\s*\]/g, ' ')
        .replace(/(\s*\|\s*){2,}/g, ' | ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[\s\-|:]+|[\s\-|:]+$/g, '');
}

function extractYearHint(title) {
    const now = new Date().getFullYear() + 1;
    const matches = (title || '').match(/\b(19[2-9]\d|20\d{2})\b/g) || [];
    const years = matches.map(Number).filter(y => y <= now);
    return years.length ? years[years.length - 1] : 0;
}

function normalizeChannel(name) {
    return (name || '').toLowerCase().replace(/ /g, '_').replace(/[^a-z0-9_@-]+/g, '');
}

async function fetchYouTubeMeta(videoId) {
    const watch = `https://www.youtube.com/watch?v=${videoId}`;
    const data = await fetchJson(`https://noembed.com/embed?url=${encodeURIComponent(watch)}`);
    if (data?.error) throw new Error(data.error);
    return { title: data?.title || '', channel: data?.author_name || '' };
}

/* ============================== TMDb / OMDb ============================== */

function tmdbAuth(path, params = {}) {
    const key = state.settings.tmdb.trim();
    if (!key) throw new Error('Add your TMDb key in Settings first.');
    const query = new URLSearchParams(params);
    const headers = {};
    if (key.startsWith('eyJ')) headers['Authorization'] = `Bearer ${key}`;
    else query.set('api_key', key);
    return { url: `https://api.themoviedb.org/3/${path}?${query}`, headers };
}

async function tmdbGet(path, params = {}) {
    const { url, headers } = tmdbAuth(path, params);
    const data = await fetchJson(url, { headers });
    setDot('dotTmdb', 'ok');
    return data;
}

async function tmdbSearch(query, year = 0) {
    const params = { query, include_adult: 'false', language: 'en-US', page: '1' };
    if (year) params.primary_release_year = String(year);
    const data = await tmdbGet('search/movie', params);
    return data?.results || [];
}

async function tmdbDetails(id) {
    return tmdbGet(`movie/${id}`, { language: 'en-US', append_to_response: 'credits,external_ids' });
}

async function omdbSearchImdbId(title) {
    const key = state.settings.omdb.trim();
    if (!key) return '';
    const data = await fetchJson(`https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}&s=${encodeURIComponent(title)}&type=movie&r=json`);
    setDot('dotOmdb', 'ok');
    return data?.Search?.[0]?.imdbID || '';
}

/* ============================== matching ============================== */

function normForMatch(s) {
    return (s || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function bigrams(s) {
    const grams = new Map();
    const t = s.replace(/ /g, '');
    for (let i = 0; i < t.length - 1; i++) {
        const g = t.slice(i, i + 2);
        grams.set(g, (grams.get(g) || 0) + 1);
    }
    return grams;
}

function similarity(a, b) {
    a = normForMatch(a); b = normForMatch(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const ga = bigrams(a), gb = bigrams(b);
    let overlap = 0, total = 0;
    for (const [g, n] of ga) { total += n; if (gb.has(g)) overlap += Math.min(n, gb.get(g)); }
    for (const [, n] of gb) total += n;
    return total ? (2 * overlap) / total : 0;
}

/* How much of the TMDb title is present word-for-word in the YouTube title.
 * Catches "Rendel: Dark Vengeance | Action | Superhero" vs TMDb "Rendel". */
function containment(tmdbTitle, ytTitle) {
    const tokens = normForMatch(tmdbTitle).split(' ').filter(Boolean);
    const ytTokens = new Set(normForMatch(ytTitle).split(' ').filter(Boolean));
    if (!tokens.length) return 0;
    const hit = tokens.filter(t => ytTokens.has(t)).length / tokens.length;
    return hit === 1 ? 0.88 : hit * 0.5;
}

function scoreCandidate(result, ytTitle, yearHint) {
    const sim = Math.max(
        similarity(ytTitle, result.title || ''),
        similarity(ytTitle, result.original_title || ''),
        containment(result.title || '', ytTitle),
        containment(result.original_title || '', ytTitle)
    );
    const relYear = result.release_date ? Number(result.release_date.slice(0, 4)) : 0;
    let yearScore = 0.5; // unknown
    if (yearHint && relYear) yearScore = Math.abs(yearHint - relYear) <= 1 ? 1 : 0;
    const pop = Math.min((result.popularity || 0) / 40, 1);
    const score = 0.72 * sim + 0.18 * yearScore + 0.10 * pop;
    let confidence = 'low';
    if (sim >= 0.85 && (yearScore === 1 || !yearHint)) confidence = 'high';
    else if (sim >= 0.85 || (sim >= 0.62 && yearScore === 1)) confidence = 'med';
    return { score, confidence, sim };
}

function titleVariants(cleaned) {
    const variants = [cleaned];
    const pipe = cleaned.split('|')[0].trim();
    if (pipe && pipe !== cleaned) variants.push(pipe);
    const colon = cleaned.split(/[:–—-]/)[0].trim();
    if (colon.length > 3 && colon !== cleaned) variants.push(colon);
    const noYear = cleaned.replace(/\b(19[2-9]\d|20\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (noYear && noYear !== cleaned) variants.push(noYear);
    const noParens = cleaned.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (noParens && !variants.includes(noParens)) variants.push(noParens);
    return [...new Set(variants)].filter(v => v.length >= 2);
}

/* Full auto-match pipeline: returns scored candidates (best first). */
async function autoMatch(ytTitle, { useOmdb = true, log: doLog = true } = {}) {
    const cleaned = cleanTitle(ytTitle);
    const yearHint = extractYearHint(ytTitle);
    let results = [];
    for (const variant of titleVariants(cleaned)) {
        if (doLog) log(`Searching TMDb for "${variant}"${yearHint ? ` (${yearHint})` : ''}…`);
        results = await tmdbSearch(variant, yearHint);
        if (!results.length && yearHint) results = await tmdbSearch(variant);
        if (results.length) break;
    }
    if (!results.length && useOmdb && state.settings.omdb) {
        if (doLog) log('TMDb found nothing — trying OMDb fallback…');
        try {
            const imdbId = await omdbSearchImdbId(cleaned);
            if (imdbId) {
                const found = await tmdbGet(`find/${imdbId}`, { external_source: 'imdb_id' });
                results = found?.movie_results || [];
                if (results.length && doLog) log(`OMDb found IMDb ${imdbId} → TMDb match.`);
            }
        } catch (e) {
            if (doLog) log('OMDb fallback failed: ' + e.message, true);
        }
    }
    const scored = results.slice(0, 10).map(r => ({ result: r, ...scoreCandidate(r, cleaned || ytTitle, yearHint) }));
    scored.sort((a, b) => b.score - a.score);
    return scored;
}

/* ============================== catalog ============================== */

function githubHeaders() {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const token = state.settings.token.trim();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

function githubContentUrl() {
    const repo = state.settings.repo.trim();
    if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error('GitHub repo must look like owner/repo.');
    const path = state.settings.path.trim().replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${repo}/contents/${path}`;
}

function parseCatalog(raw) {
    if (!raw || !raw.trim()) return { movies: [], document: null };
    const node = JSON.parse(raw.trim());
    if (Array.isArray(node)) return { movies: node, document: null };
    if (node && Array.isArray(node.movies)) return { movies: node.movies, document: node };
    throw new Error('Catalog must be a top-level array or an object with a movies array.');
}

function serializeCatalog(movies, doc) {
    let payload;
    if (doc) { doc.movies = movies; payload = doc; } else payload = movies;
    return JSON.stringify(payload, null, 4) + '\n';
}

async function loadCatalog(force = false) {
    if (state.catalog && !force) return state.catalog;
    const branch = state.settings.branch.trim() || 'main';
    // no-store: GitHub's API is browser-cached for 60s, which made conflict
    // retries re-fetch the same stale sha and fail repeatedly
    const data = await fetchJson(`${githubContentUrl()}?ref=${encodeURIComponent(branch)}`, { headers: githubHeaders(), cache: 'no-store' });
    const raw = b64ToUtf8(data.content || '');
    const parsed = parseCatalog(raw);
    parsed.sha = data.sha;
    state.catalog = parsed;
    setDot('dotCatalog', 'ok');
    $('chipCatalogText').textContent = `Catalog · ${parsed.movies.length}`;
    return parsed;
}

function nextMovieId(movies) {
    let max = 0;
    for (const m of movies) {
        const match = /^movie_(\d+)$/.exec(m.id || '');
        if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return 'movie_' + String(max + 1).padStart(4, '0');
}

function findDuplicates(movies, entry) {
    const dupes = [];
    for (const m of movies) {
        const reasons = [];
        if (entry.video_id && m.video_id === entry.video_id) reasons.push(`same video_id ${entry.video_id}`);
        if (m.tmdb_id === entry.tmdb_id) reasons.push(`same tmdb_id ${entry.tmdb_id}`);
        if (reasons.length) dupes.push(`${m.id}: ${reasons.join(', ')}`);
    }
    return dupes;
}

function buildEntry(id) {
    const d = state.selected.details;
    const today = new Date().toISOString().slice(0, 10);
    const director = (d.credits?.crew || []).find(c => c.job === 'Director')?.name || '';
    const cast = (d.credits?.cast || []).map(c => c.name).filter(Boolean).slice(0, 4);
    return {
        id,
        tmdb_id: d.id,
        video_id: state.videoId,
        channel_id: currentChannelId(),
        status: 'active',
        last_checked: today,
        title: d.title || '',
        overview: d.overview || '',
        release_date: d.release_date || '',
        vote_average: d.vote_average || 0,
        runtime: d.runtime || 0,
        poster_path: d.poster_path || '',
        backdrop_path: d.backdrop_path || '',
        genres: (d.genres || []).filter(g => g.id && g.name).map(g => ({ id: g.id, name: g.name })),
        director,
        cast
    };
}

async function loadApprovedChannels() {
    try {
        const repo = state.settings.repo.trim();
        const branch = state.settings.branch.trim() || 'main';
        const dir = state.settings.path.includes('/') ? state.settings.path.replace(/\/[^/]*$/, '/') : '';
        const url = `https://raw.githubusercontent.com/${repo}/${branch}/${dir}approved_channels.json`;
        const data = await fetchJson(url);
        if (Array.isArray(data)) {
            state.approvedChannels = data;
            log(`Loaded ${data.length} approved channels.`);
        }
    } catch {
        log('Could not load approved_channels.json (channel list will be free-text).');
    }
}

/* ============================== single-movie UI ============================== */

function resetWorkflow(clearLink = true) {
    state.videoId = '';
    state.ytTitleRaw = '';
    state.ytChannelRaw = '';
    state.candidates = [];
    state.selected = null;
    if (clearLink) $('ytUrl').value = '';
    $('ytStatus').textContent = '';
    $('ytStatus').className = 'link-status';
    $('ytInfo').hidden = true;
    $('matchCard').hidden = true;
    $('verifyCard').hidden = true;
    $('candList').innerHTML = '';
    $('appendStatus').textContent = '';
    $('appendStatus').className = 'append-status';
    $('manTmdbId').value = '';
    $('manImdb').value = '';
}

function setYtStatus(text, cls = '') {
    $('ytStatus').textContent = text;
    $('ytStatus').className = 'link-status' + (cls ? ' ' + cls : '');
}

async function handleLink(rawText) {
    const videoId = extractYouTubeId(rawText);
    if (videoId.length !== 11) return;
    if (videoId === state.videoId) return;

    const seq = ++state.lookupSeq;
    resetWorkflow(false);
    state.videoId = videoId;

    $('ytInfo').hidden = false;
    $('ytThumb').src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    $('ytThumbLink').href = `https://www.youtube.com/watch?v=${videoId}`;
    $('ytOpenLink').href = `https://www.youtube.com/watch?v=${videoId}`;
    $('ytVideoId').textContent = videoId;
    $('ytChannelRaw').textContent = '—';
    $('ytTitle').value = '';

    setYtStatus('Loading video info…', 'busy');
    let meta = { title: '', channel: '' };
    try {
        meta = await fetchYouTubeMeta(videoId);
    } catch (e) {
        log(`Could not load YouTube metadata for ${videoId}: ${e.message}`, true);
    }
    if (seq !== state.lookupSeq) return;

    state.ytTitleRaw = meta.title;
    state.ytChannelRaw = meta.channel;
    $('ytChannelRaw').textContent = meta.channel || '—';
    $('ytTitle').value = cleanTitle(meta.title) || '';

    if (!meta.title) {
        setYtStatus('No title found — type it above and press Enter', 'err');
        $('matchCard').hidden = false;
        $('matchStatus').textContent = 'waiting for a title';
        return;
    }
    await runSearch(meta.title, seq);
}

async function runSearch(ytTitle, seq = ++state.lookupSeq) {
    setYtStatus('Matching on TMDb…', 'busy');
    $('matchCard').hidden = false;
    $('candList').innerHTML = '';
    $('matchStatus').textContent = 'searching…';
    $('verifyCard').hidden = true;
    try {
        const scored = await autoMatch(ytTitle);
        if (seq !== state.lookupSeq) return;
        state.candidates = scored;
        renderCandidates();
        if (scored.length) {
            setYtStatus(`${scored.length} match${scored.length === 1 ? '' : 'es'} found`, '');
            await selectCandidate(0);
        } else {
            setYtStatus('No matches found', 'err');
            $('matchStatus').textContent = 'no matches — edit the title above and press Enter, or use manual tools';
        }
    } catch (e) {
        if (seq !== state.lookupSeq) return;
        setYtStatus('Search failed', 'err');
        $('matchStatus').textContent = e.message;
        log('Search failed: ' + e.message, true);
    }
}

function confLabel(c) {
    return c === 'high' ? 'HIGH' : c === 'med' ? 'MEDIUM' : 'LOW';
}

function renderCandidates() {
    const list = $('candList');
    list.innerHTML = '';
    state.candidates.forEach((c, i) => {
        const r = c.result;
        const year = r.release_date ? r.release_date.slice(0, 4) : '????';
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'cand';
        el.dataset.index = i;
        el.innerHTML = `
            ${r.poster_path
                ? `<img loading="lazy" src="https://image.tmdb.org/t/p/w185${esc(r.poster_path)}" alt="">`
                : `<div class="noposter">no poster</div>`}
            <div class="c-title">${esc(r.title || 'Untitled')}</div>
            <div class="c-meta">${year} · ★ ${(r.vote_average || 0).toFixed(1)}</div>
            <span class="conf ${c.confidence}">${confLabel(c.confidence)}</span>`;
        el.addEventListener('click', () => selectCandidate(i));
        list.appendChild(el);
    });
    $('matchStatus').textContent = state.candidates.length
        ? 'best match auto-selected — click another card if it\'s wrong'
        : '';
}

async function selectCandidate(index) {
    const cand = state.candidates[index];
    if (!cand) return;
    document.querySelectorAll('.cand').forEach(el =>
        el.classList.toggle('selected', Number(el.dataset.index) === index));

    $('verifyCard').hidden = false;
    $('vTitle').textContent = 'Loading…';
    $('btnAppend').disabled = true;

    try {
        const details = await tmdbDetails(cand.result.id);
        state.selected = { result: cand.result, details, confidence: cand.confidence };
        renderVerify();
        await updatePreviewAndDupes();
    } catch (e) {
        $('vTitle').textContent = 'Failed to load details';
        log('Details failed: ' + e.message, true);
    }
}

function renderVerify() {
    const d = state.selected.details;
    const year = d.release_date ? d.release_date.slice(0, 4) : '????';
    const runtime = d.runtime ? (d.runtime >= 60 ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m` : `${d.runtime}m`) : '—';

    $('vPoster').src = d.poster_path ? `https://image.tmdb.org/t/p/w342${d.poster_path}` : '';
    $('vBackdrop').src = d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '';
    $('vBackdropWrap').style.display = d.backdrop_path ? '' : 'none';
    $('vYtThumb').src = state.videoId ? `https://i.ytimg.com/vi/${state.videoId}/hqdefault.jpg` : '';
    $('vTitle').textContent = d.title || 'Untitled';
    $('vMeta').innerHTML = `${year} · ${runtime} · <span class="rating">★ ${(d.vote_average || 0).toFixed(1)}</span>` +
        ` · TMDb #${d.id}` + (d.external_ids?.imdb_id ? ` · ${esc(d.external_ids.imdb_id)}` : '');
    $('vGenres').innerHTML = (d.genres || []).map(g => `<span>${esc(g.name)}</span>`).join('');
    $('vOverview').textContent = d.overview || '';
    const director = (d.credits?.crew || []).find(c => c.job === 'Director')?.name;
    const cast = (d.credits?.cast || []).slice(0, 4).map(c => c.name).join(', ');
    $('vDirector').innerHTML = director ? `Director: <b>${esc(director)}</b>` : '';
    $('vCast').innerHTML = cast ? `Cast: <b>${esc(cast)}</b>` : '';

    populateChannelSelect();
}

function populateChannelSelect() {
    const select = $('channelSelect');
    const normalized = normalizeChannel(state.ytChannelRaw);
    select.innerHTML = '';
    for (const ch of state.approvedChannels) {
        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.textContent = `${ch.name} (${ch.id})`;
        select.appendChild(opt);
    }
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom…';
    select.appendChild(customOpt);

    const match = state.approvedChannels.find(ch =>
        ch.id === normalized || normalizeChannel(ch.name) === normalized);
    if (match) {
        select.value = match.id;
        $('channelCustom').hidden = true;
        $('channelWarn').hidden = true;
    } else {
        select.value = '__custom__';
        $('channelCustom').hidden = false;
        $('channelCustom').value = normalized;
        $('channelWarn').hidden = !normalized;
    }
}

function currentChannelId() {
    const sel = $('channelSelect').value;
    return sel === '__custom__' ? $('channelCustom').value.trim() : sel;
}

async function updatePreviewAndDupes() {
    if (!state.selected) return;
    const badge = $('dupBadge');
    badge.className = 'badge';
    badge.textContent = 'Checking duplicates…';
    $('btnAppend').disabled = true;
    let movies = [], nextId = 'movie_0001', catalogOk = false;
    try {
        const cat = await loadCatalog();
        movies = cat.movies;
        nextId = nextMovieId(movies);
        catalogOk = true;
    } catch (e) {
        log('Catalog check skipped: ' + e.message, true);
    }
    $('nextIdText').textContent = 'Next ID: ' + nextId;
    const entry = buildEntry(nextId);
    $('jsonPreview').textContent = JSON.stringify(entry, null, 4);

    if (!catalogOk) {
        badge.classList.add('warn');
        badge.textContent = 'Catalog not checked';
        $('btnAppend').disabled = false; // final check runs again on append
        return;
    }
    const dupes = findDuplicates(movies, entry);
    if (dupes.length) {
        badge.classList.add('dup');
        badge.textContent = 'Duplicate: ' + dupes.join('; ');
        $('btnAppend').disabled = true;
    } else {
        badge.classList.add('ok');
        badge.textContent = 'No duplicates';
        $('btnAppend').disabled = false;
    }
}

/* ============================== append ============================== */

async function appendToCatalog() {
    if (state.appendBusy || !state.selected) return;
    if (!state.videoId) { setAppendStatus('Missing YouTube video ID.', 'err'); return; }
    if (!currentChannelId()) { setAppendStatus('Pick or type a channel ID first.', 'err'); return; }

    state.appendBusy = true;
    $('btnAppend').disabled = true;
    try {
        if (state.settings.target === 'download') {
            const cat = await loadCatalog(true);
            const entry = buildEntry(nextMovieId(cat.movies));
            const dupes = findDuplicates(cat.movies, entry);
            if (dupes.length) throw new Error('Duplicate: ' + dupes.join('; '));
            const content = serializeCatalog([...cat.movies, entry], cat.document);
            downloadFile(state.settings.path.split('/').pop() || 'movies.json', content);
            setAppendStatus(`${entry.id} added — updated file downloaded. Send it to neeko or commit it yourself.`, 'ok');
            log(`Added ${entry.id} (download mode).`);
            afterAdded(entry);
            return;
        }

        // Direct GitHub write with SHA-conflict retry.
        // Attempt 1 trusts our in-memory catalog (kept current after every save —
        // GitHub's API can serve stale reads for a few seconds after a commit).
        // Retries force a fresh download after a short wait.
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (attempt > 1) await new Promise(r => setTimeout(r, 1500 * (attempt - 1)));
            const cat = await loadCatalog(attempt > 1);
            const entry = buildEntry(nextMovieId(cat.movies));
            const dupes = findDuplicates(cat.movies, entry);
            if (dupes.length) throw new Error('Duplicate: ' + dupes.join('; '));
            const content = serializeCatalog([...cat.movies, entry], cat.document);
            setAppendStatus(`Committing ${entry.id} to GitHub…`, '');
            try {
                const result = await fetchJson(githubContentUrl(), {
                    method: 'PUT',
                    headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: `Add ${entry.id} to movie JSON`,
                        content: utf8ToB64(content),
                        sha: cat.sha,
                        branch: state.settings.branch.trim() || 'main'
                    })
                });
                const commitUrl = result?.commit?.html_url || '';
                setDot('dotGithub', 'ok');
                setAppendStatus(
                    `Added ${entry.id} ✓ ` + (commitUrl ? `<a href="${esc(commitUrl)}" target="_blank" rel="noopener">view commit</a>` : ''),
                    'ok', true);
                log(`Added ${entry.id} to GitHub.`);
                // Keep the in-memory catalog current: GitHub's PUT response carries
                // the new sha, so the next add doesn't depend on a (possibly stale) re-download.
                if (result?.content?.sha) {
                    state.catalog = { movies: [...cat.movies, entry], document: cat.document, sha: result.content.sha };
                    $('chipCatalogText').textContent = `Catalog · ${state.catalog.movies.length}`;
                } else {
                    state.catalog = null; // fall back to fresh load next time
                }
                afterAdded(entry);
                return;
            } catch (e) {
                lastError = e;
                if (e.status === 409 || (e.status === 422 && /sha|does not match/i.test(e.message))) {
                    log(`Write conflict (someone else just committed) — retrying (${attempt}/3)…`);
                    continue;
                }
                throw e;
            }
        }
        throw lastError || new Error('Write failed after retries.');
    } catch (e) {
        setAppendStatus(e.message, 'err');
        log('Append failed: ' + e.message, true);
        $('btnAppend').disabled = false;
    } finally {
        state.appendBusy = false;
    }
}

function setAppendStatus(msg, cls = '', isHtml = false) {
    const el = $('appendStatus');
    if (isHtml) el.innerHTML = msg; else el.textContent = msg;
    el.className = 'append-status' + (cls ? ' ' + cls : '');
}

function afterAdded(entry) {
    refreshRecent();
    if (state.batchActiveIndex >= 0) {
        const item = state.batch[state.batchActiveIndex];
        if (item) { item.status = 'added'; item.catalogId = entry.id; }
        state.batchActiveIndex = -1;
        saveBatch();
        renderBatch();
        const next = nextReviewable();
        if (next >= 0) {
            log('Loading next batch item…');
            setTimeout(() => reviewBatchItem(next), 600);
        } else {
            log('Batch: no more items to review.');
            setTimeout(() => { switchView('viewBatch'); resetWorkflow(); }, 900);
        }
    } else {
        // keep the success message visible; clear inputs for the next movie
        setTimeout(() => {
            const status = $('appendStatus').innerHTML;
            resetWorkflow();
            $('appendStatus').innerHTML = status;
        }, 400);
    }
}

function downloadFile(name, content) {
    const blob = new Blob([content], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
}

/* ============================== recent strip ============================== */

async function refreshRecent() {
    try {
        const cat = await loadCatalog(true);
        const recent = cat.movies.slice(-10).reverse();
        $('recentCard').hidden = recent.length === 0;
        $('recentList').innerHTML = recent.map(m => `
            <div class="recent-item" title="${esc(m.title)}">
                ${m.poster_path ? `<img loading="lazy" src="https://image.tmdb.org/t/p/w154${esc(m.poster_path)}" alt="">` : '<div class="noposter" style="width:92px;aspect-ratio:2/3"></div>'}
                <div class="r-id">${esc(m.id)}</div>
                <div class="r-title">${esc(m.title)}</div>
            </div>`).join('');
    } catch (e) {
        log('Could not refresh recent list: ' + e.message, true);
    }
}

/* ============================== batch mode ============================== */

function saveBatch() {
    try {
        localStorage.setItem(BATCH_KEY, JSON.stringify({
            items: state.batch.map(({ link, videoId, ytTitle, channel, status, catalogId, best }) =>
                ({ link, videoId, ytTitle, channel, status, catalogId, best })),
            linksText: $('batchLinks').value
        }));
    } catch { /* storage full — queue still works in memory */ }
}

function loadBatch() {
    try {
        const raw = localStorage.getItem(BATCH_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        state.batch = (data.items || []).map(i => ({ ...i, candidates: null }));
        $('batchLinks').value = data.linksText || '';
        if (state.batch.length) log(`Restored batch queue with ${state.batch.length} link(s).`);
    } catch { /* corrupt queue — start fresh */ }
}

async function buildQueue() {
    const text = $('batchLinks').value;
    const seen = new Set();
    const items = [];
    for (const tokenText of text.split(/\s+/)) {
        const trimmed = tokenText.trim();
        if (!trimmed) continue;
        const id = extractYouTubeId(trimmed);
        if (id.length !== 11 || seen.has(id)) continue;
        seen.add(id);
        const link = /^[A-Za-z0-9_-]{11}$/.test(trimmed) ? `https://www.youtube.com/watch?v=${id}` : trimmed;
        items.push({ link, videoId: id, ytTitle: '', channel: '', status: 'queued', catalogId: '', best: null, candidates: null });
    }
    if (!items.length) { log('No usable YouTube links found.', true); return; }

    state.batch = items;
    state.batchActiveIndex = -1;

    // pre-check against catalog
    try {
        const cat = await loadCatalog();
        const have = new Set(cat.movies.map(m => m.video_id));
        const before = state.batch.length;
        state.batch = state.batch.filter(i => !have.has(i.videoId));
        const dropped = before - state.batch.length;
        if (dropped) {
            // also scrub them from the links box so the list stays clean
            $('batchLinks').value = state.batch.map(i => i.link).join('\n');
            log(`Removed ${dropped} link(s) already in the catalog.`);
        }
    } catch (e) {
        log('Batch duplicate pre-check skipped: ' + e.message, true);
    }

    renderBatch();
    saveBatch();
    log(`Built batch queue with ${state.batch.length} link(s). Auto-matching…`);
    runBatchMatching();
}

async function runBatchMatching() {
    if (state.batchRunning) return;
    state.batchRunning = true;
    $('batchProgress').hidden = false;
    try {
        const todo = state.batch.filter(i => i.status === 'queued');
        let done = 0;
        for (const item of state.batch) {
            if (item.status !== 'queued') continue;
            item.status = 'matching';
            renderBatch();
            try {
                const meta = await fetchYouTubeMeta(item.videoId);
                item.ytTitle = meta.title;
                item.channel = meta.channel;
                if (!meta.title) throw new Error('no title');
                const scored = await autoMatch(meta.title, { log: false });
                item.candidates = scored;
                if (scored.length) {
                    const best = scored[0];
                    item.best = {
                        tmdbId: best.result.id,
                        title: best.result.title,
                        year: best.result.release_date ? best.result.release_date.slice(0, 4) : '????',
                        poster: best.result.poster_path || '',
                        confidence: best.confidence
                    };
                    item.status = 'ready';
                } else {
                    item.status = 'nomatch';
                }
            } catch (e) {
                item.status = item.ytTitle ? 'nomatch' : 'error';
                log(`Batch ${item.videoId}: ${e.message}`, true);
            }
            done++;
            $('batchProgressBar').style.width = `${Math.round(done / todo.length * 100)}%`;
            renderBatch();
            saveBatch();
            await new Promise(r => setTimeout(r, 250)); // be polite to APIs
        }
        const ready = state.batch.filter(i => i.status === 'ready').length;
        log(`Batch matching done — ${ready} ready to review.`);
    } finally {
        state.batchRunning = false;
        setTimeout(() => { $('batchProgress').hidden = true; }, 800);
    }
}

function batchCounts() {
    const counts = {};
    for (const i of state.batch) counts[i.status] = (counts[i.status] || 0) + 1;
    return counts;
}

function renderBatch() {
    const body = $('batchTableBody');
    body.innerHTML = '';
    state.batch.forEach((item, idx) => {
        const tr = document.createElement('tr');
        if (idx === state.batchActiveIndex) tr.classList.add('current');
        const stLabel = { queued: 'Queued', matching: 'Matching…', ready: 'Ready', added: 'Added', already: 'Already in catalog', skipped: 'Skipped', nomatch: 'No match', error: 'Error' }[item.status] || item.status;
        const best = item.best
            ? `${esc(item.best.title)} (${esc(item.best.year)})`
            : (item.status === 'already' ? esc(item.catalogId) : '—');
        const conf = item.best ? `<span class="conf ${item.best.confidence}">${confLabel(item.best.confidence)}</span>` : '';
        const canReview = ['ready', 'nomatch', 'error', 'queued'].includes(item.status);
        const canSkip = ['ready', 'nomatch', 'error', 'queued', 'matching'].includes(item.status);
        tr.innerHTML = `
            <td><span class="st ${item.status}">${stLabel}</span></td>
            <td class="batch-video-cell">
                <a href="${esc(item.link)}" target="_blank" rel="noopener" title="Open on YouTube">
                    <img class="batch-thumb" loading="lazy" src="https://i.ytimg.com/vi/${esc(item.videoId)}/mqdefault.jpg" alt="">
                </a>
                <div><div class="batch-yt-title">${esc(item.ytTitle || item.link)}</div><div class="batch-vid">${esc(item.videoId)}${item.catalogId && item.status === 'added' ? ' · ' + esc(item.catalogId) : ''}</div></div>
            </td>
            <td>${best}</td>
            <td>${conf}</td>
            <td>
                ${canReview ? `<button class="btn small" data-review="${idx}">Review</button>` : ''}
                ${canSkip ? `<button class="btn small" data-skip="${idx}">Skip</button>` : ''}
            </td>`;
        body.appendChild(tr);
    });
    body.querySelectorAll('[data-review]').forEach(b =>
        b.addEventListener('click', () => reviewBatchItem(Number(b.dataset.review))));
    body.querySelectorAll('[data-skip]').forEach(b =>
        b.addEventListener('click', () => skipBatchItem(Number(b.dataset.skip))));

    const c = batchCounts();
    const parts = [];
    for (const [k, label] of [['ready', 'ready'], ['added', 'added'], ['already', 'already in catalog'], ['skipped', 'skipped'], ['nomatch', 'no match'], ['error', 'errors'], ['queued', 'queued'], ['matching', 'matching']]) {
        if (c[k]) parts.push(`${c[k]} ${label}`);
    }
    $('batchCounts').textContent = state.batch.length ? `${state.batch.length} links · ${parts.join(' · ')}` : 'empty';
    $('btnReviewNext').disabled = !state.batch.some(i => ['ready', 'queued', 'nomatch', 'error'].includes(i.status));
    $('btnExportSkipped').disabled = !state.batch.some(i => ['skipped', 'nomatch', 'error'].includes(i.status));
    const badge = $('batchBadge');
    const readyCount = c.ready || 0;
    badge.hidden = readyCount === 0;
    badge.textContent = readyCount;
}

async function reviewBatchItem(index) {
    const item = state.batch[index];
    if (!item) return;
    state.batchActiveIndex = index;
    renderBatch();
    switchView('viewAdd');

    const seq = ++state.lookupSeq;
    resetWorkflow(false);
    state.batchActiveIndex = index; // resetWorkflow doesn't clear it, but be explicit
    state.videoId = item.videoId;
    state.ytTitleRaw = item.ytTitle;
    state.ytChannelRaw = item.channel;

    $('ytUrl').value = item.link;
    $('ytInfo').hidden = false;
    $('ytThumb').src = `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
    $('ytThumbLink').href = item.link;
    $('ytOpenLink').href = item.link;
    $('ytVideoId').textContent = item.videoId;
    $('ytChannelRaw').textContent = item.channel || '—';
    $('ytTitle').value = cleanTitle(item.ytTitle);

    if (item.candidates?.length) {
        state.candidates = item.candidates;
        $('matchCard').hidden = false;
        renderCandidates();
        setYtStatus(`Batch ${index + 1}/${state.batch.length}`, '');
        await selectCandidate(0);
    } else if (item.ytTitle) {
        await runSearch(item.ytTitle, seq);
    } else {
        setYtStatus('No title — type one above and press Enter', 'err');
        $('matchCard').hidden = false;
    }
}

function skipBatchItem(index) {
    const item = state.batch[index];
    if (!item) return;
    item.status = 'skipped';
    if (state.batchActiveIndex === index) state.batchActiveIndex = -1;
    saveBatch();
    renderBatch();
    log(`Skipped ${item.videoId}.`);
}

// Ready items first; then anything still needing a human (queued/nomatch/error),
// so the add flow keeps moving instead of bouncing back to the queue.
function nextReviewable() {
    const ready = state.batch.findIndex(i => i.status === 'ready');
    if (ready >= 0) return ready;
    return state.batch.findIndex(i => ['queued', 'nomatch', 'error'].includes(i.status));
}

function reviewNext() {
    const next = nextReviewable();
    if (next >= 0) reviewBatchItem(next);
}

/* ============================== channel import ============================== */

const YT_API = 'https://www.googleapis.com/youtube/v3/';

function ytKey() {
    const key = state.settings.yt.trim();
    if (!key) throw new Error('Add your YouTube Data API key in Settings first.');
    return key;
}

// Accepts: youtube.com/channel/UC…, youtube.com/@handle, youtube.com/user/name,
// a bare @handle, or a bare UC… id — with or without trailing /videos etc.
function parseChannelInput(text) {
    const t = text.trim();
    if (!t) return null;
    let m = /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i.exec(t);
    if (m) return { id: m[1] };
    if (/^UC[A-Za-z0-9_-]{22}$/.test(t)) return { id: t };
    m = /youtube\.com\/user\/([A-Za-z0-9_.-]+)/i.exec(t);
    if (m) return { user: m[1] };
    m = /youtube\.com\/@([A-Za-z0-9_.-]+)/i.exec(t);
    if (m) return { handle: m[1] };
    m = /^@?([A-Za-z0-9_.-]+)$/.exec(t);
    if (m && !t.includes('/')) return { handle: m[1] };
    return null;
}

async function resolveChannel(ref) {
    const params = new URLSearchParams({ part: 'snippet,contentDetails,statistics', key: ytKey() });
    if (ref.id) params.set('id', ref.id);
    else if (ref.user) params.set('forUsername', ref.user);
    else params.set('forHandle', ref.handle);
    const data = await fetchJson(`${YT_API}channels?${params}`);
    const ch = data?.items?.[0];
    if (!ch) throw new Error('Channel not found.');
    return {
        id: ch.id,
        title: ch.snippet?.title || ch.id,
        uploads: ch.contentDetails?.relatedPlaylists?.uploads || ('UU' + ch.id.slice(2)),
        videoCount: Number(ch.statistics?.videoCount || 0)
    };
}

function isoDurationToMinutes(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
    if (!m) return 0;
    return Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0) + Number(m[4] || 0) / 60;
}

async function importChannelVideos() {
    if (state.channelImportBusy) return;
    const ref = parseChannelInput($('chUrl').value);
    if (!ref) { log('Paste a channel link, @handle, or UC… ID first.', true); return; }
    state.channelImportBusy = true;
    $('btnFetchChannel').disabled = true;
    const setStatus = msg => { $('chImportStatus').textContent = msg; };
    try {
        setStatus('Resolving channel…');
        const ch = await resolveChannel(ref);
        log(`Channel: ${ch.title} — ~${ch.videoCount} uploads. Fetching…`);

        // All uploads, 50 per page
        const ids = [];
        let pageToken = '';
        do {
            const params = new URLSearchParams({ part: 'contentDetails', playlistId: ch.uploads, maxResults: '50', key: ytKey() });
            if (pageToken) params.set('pageToken', pageToken);
            const page = await fetchJson(`${YT_API}playlistItems?${params}`);
            for (const it of page.items || []) {
                const vid = it.contentDetails?.videoId;
                if (vid) ids.push(vid);
            }
            pageToken = page.nextPageToken || '';
            setStatus(`Fetched ${ids.length}${ch.videoCount ? '/' + ch.videoCount : ''}…`);
        } while (pageToken);

        // Movies only: keep >= 40 min
        let kept = ids, tooShort = 0;
        if ($('chMoviesOnly').checked) {
            kept = [];
            for (let i = 0; i < ids.length; i += 50) {
                const chunk = ids.slice(i, i + 50);
                const params = new URLSearchParams({ part: 'contentDetails', id: chunk.join(','), key: ytKey() });
                const data = await fetchJson(`${YT_API}videos?${params}`);
                for (const v of data.items || []) {
                    if (isoDurationToMinutes(v.contentDetails?.duration) >= 40) kept.push(v.id);
                    else tooShort++;
                }
                setStatus(`Checking durations ${Math.min(i + 50, ids.length)}/${ids.length}…`);
            }
        }

        // Drop videos already in the catalog
        let already = 0;
        try {
            const cat = await loadCatalog();
            const have = new Set(cat.movies.map(m => m.video_id));
            const before = kept.length;
            kept = kept.filter(id => !have.has(id));
            already = before - kept.length;
        } catch (e) {
            log('Catalog check skipped: ' + e.message, true);
        }

        // Dedupe against whatever is already in the links box, then append
        const existing = new Set();
        for (const tok of $('batchLinks').value.split(/\s+/)) {
            const id = extractYouTubeId(tok.trim());
            if (id.length === 11) existing.add(id);
        }
        const fresh = kept.filter(id => !existing.has(id));
        if (fresh.length) {
            const lines = fresh.map(id => `https://www.youtube.com/watch?v=${id}`);
            $('batchLinks').value = ($('batchLinks').value.trim() ? $('batchLinks').value.trim() + '\n' : '') + lines.join('\n');
            saveBatch();
        }

        const bits = [`${ids.length} uploads`];
        if (tooShort) bits.push(`${tooShort} under 40 min`);
        if (already) bits.push(`${already} already in catalog`);
        bits.push(`${fresh.length} new link(s) added`);
        setStatus(bits.join(' · '));
        log(`Channel import (${ch.title}): ${bits.join(' · ')}.`);
    } catch (e) {
        setStatus('');
        log('Channel import failed: ' + e.message, true);
    } finally {
        state.channelImportBusy = false;
        $('btnFetchChannel').disabled = false;
    }
}

function exportSkipped() {
    const links = state.batch
        .filter(i => ['skipped', 'nomatch', 'error'].includes(i.status))
        .map(i => i.link).join('\n');
    navigator.clipboard.writeText(links).then(
        () => log('Copied skipped/unmatched links to clipboard.'),
        () => log('Clipboard copy failed.', true));
}

/* ============================== settings ============================== */

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) Object.assign(state.settings, JSON.parse(raw));
    } catch { /* fresh start */ }
    $('setRepo').value = state.settings.repo;
    $('setPath').value = state.settings.path;
    $('setBranch').value = state.settings.branch;
    $('setToken').value = state.settings.token;
    $('setRemember').checked = state.settings.remember;
    $('setTmdb').value = state.settings.tmdb;
    $('setOmdb').value = state.settings.omdb;
    $('setYt').value = state.settings.yt;
    $('targetGithub').checked = state.settings.target !== 'download';
    $('targetDownload').checked = state.settings.target === 'download';
}

function readSettingsForm() {
    state.settings.repo = $('setRepo').value.trim();
    state.settings.path = $('setPath').value.trim() || 'movies.json';
    state.settings.branch = $('setBranch').value.trim() || 'main';
    state.settings.token = $('setToken').value.trim();
    state.settings.remember = $('setRemember').checked;
    state.settings.tmdb = $('setTmdb').value.trim();
    state.settings.omdb = $('setOmdb').value.trim();
    state.settings.yt = $('setYt').value.trim();
    state.settings.target = $('targetDownload').checked ? 'download' : 'github';
}

function saveSettings() {
    readSettingsForm();
    const toStore = { ...state.settings };
    if (!toStore.remember) toStore.token = '';
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(toStore));
    $('saveMsg').textContent = 'Saved ✓';
    $('saveMsg').className = 'test-msg ok';
    setTimeout(() => { $('saveMsg').textContent = ''; }, 2500);
    log('Settings saved.');
    state.catalog = null;
    bootData();
}

function setTestMsg(id, msg, cls) {
    const el = $(id);
    el.textContent = msg;
    el.className = 'test-msg ' + cls;
}

async function testTmdb() {
    readSettingsForm();
    setTestMsg('tmdbTestMsg', 'testing…', 'busy');
    try {
        await tmdbGet('configuration');
        setTestMsg('tmdbTestMsg', 'Connected ✓', 'ok');
    } catch (e) {
        setDot('dotTmdb', 'bad');
        setTestMsg('tmdbTestMsg', e.message, 'err');
    }
}

async function testOmdb() {
    readSettingsForm();
    setTestMsg('omdbTestMsg', 'testing…', 'busy');
    try {
        if (!state.settings.omdb) throw new Error('Add your OMDb key first.');
        const data = await fetchJson(`https://www.omdbapi.com/?apikey=${encodeURIComponent(state.settings.omdb)}&i=tt0111161&r=json`);
        if (data?.Response !== 'True') throw new Error(data?.Error || 'OMDb test failed.');
        setDot('dotOmdb', 'ok');
        setTestMsg('omdbTestMsg', 'Connected ✓', 'ok');
    } catch (e) {
        setDot('dotOmdb', 'bad');
        setTestMsg('omdbTestMsg', e.message, 'err');
    }
}

async function testGithub() {
    readSettingsForm();
    setTestMsg('ghTestMsg', 'testing write access…', 'busy');
    try {
        if (!state.settings.token) throw new Error('Add your GitHub token first.');
        const branch = state.settings.branch || 'main';
        const repo = state.settings.repo.trim();
        if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error('Repo must look like owner/repo.');
        const testPath = '.flixmine-cataloger-access-test.txt';
        const url = `https://api.github.com/repos/${repo}/contents/${testPath}`;
        const created = await fetchJson(url, {
            method: 'PUT',
            headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'FlixMine Cataloger access test',
                content: utf8ToB64(`FlixMine Cataloger write test ${new Date().toISOString()}\n`),
                branch
            })
        });
        await fetchJson(url, {
            method: 'DELETE',
            headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Remove FlixMine Cataloger access test',
                sha: created?.content?.sha || '',
                branch
            })
        });
        setDot('dotGithub', 'ok');
        setTestMsg('ghTestMsg', 'Write access confirmed ✓', 'ok');
        log('GitHub write test passed.');
    } catch (e) {
        setDot('dotGithub', 'bad');
        setTestMsg('ghTestMsg', e.message, 'err');
        log('GitHub test failed: ' + e.message, true);
    }
}

/* ============================== views & wiring ============================== */

function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === viewId));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === viewId));
}

async function bootData() {
    try {
        await loadCatalog(true);
        log(`Catalog loaded: ${state.catalog.movies.length} movies.`);
        refreshRecent();
    } catch (e) {
        setDot('dotCatalog', 'bad');
        $('chipCatalogText').textContent = 'Catalog · ?';
        log('Could not load catalog: ' + e.message, true);
    }
    loadApprovedChannels();
}

function wire() {
    // tabs
    document.querySelectorAll('.tab').forEach(tab =>
        tab.addEventListener('click', () => switchView(tab.dataset.view)));

    // single movie
    $('ytUrl').addEventListener('input', e => handleLink(e.target.value));
    $('ytUrl').addEventListener('paste', e => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        setTimeout(() => handleLink(text), 0);
    });
    $('ytTitle').addEventListener('keydown', e => {
        if (e.key === 'Enter') runSearch($('ytTitle').value);
    });
    $('btnLoadTmdb').addEventListener('click', async () => {
        const id = $('manTmdbId').value.trim();
        if (!id) return;
        try {
            const details = await tmdbDetails(id);
            state.candidates = [{ result: details, score: 1, confidence: 'high' }];
            $('matchCard').hidden = false;
            renderCandidates();
            await selectCandidate(0);
        } catch (e) { log('TMDb ID load failed: ' + e.message, true); }
    });
    $('btnFindImdb').addEventListener('click', async () => {
        const m = /tt\d{7,10}/.exec($('manImdb').value.trim());
        if (!m) { log('Paste an IMDb ID (tt1234567) or IMDb URL first.', true); return; }
        try {
            const found = await tmdbGet(`find/${m[0]}`, { external_source: 'imdb_id' });
            const results = found?.movie_results || [];
            if (!results.length) { log(`TMDb found no movie for IMDb ${m[0]}.`, true); return; }
            state.candidates = results.map(r => ({ result: r, score: 1, confidence: 'high' }));
            $('matchCard').hidden = false;
            renderCandidates();
            await selectCandidate(0);
        } catch (e) { log('IMDb lookup failed: ' + e.message, true); }
    });
    $('btnImdbWeb').addEventListener('click', () => {
        const title = $('ytTitle').value.trim();
        if (!title) { log('Type a title first.', true); return; }
        window.open(`https://www.imdb.com/find/?q=${encodeURIComponent(title)}&s=tt&ttype=ft`, '_blank', 'noopener');
    });
    $('btnOmdb').addEventListener('click', async () => {
        const title = $('ytTitle').value.trim();
        if (!title) { log('Type a title first.', true); return; }
        try {
            const imdbId = await omdbSearchImdbId(title);
            if (!imdbId) { log('OMDb found no usable IMDb ID.', true); return; }
            $('manImdb').value = imdbId;
            $('btnFindImdb').click();
        } catch (e) { log('OMDb search failed: ' + e.message, true); }
    });
    $('channelSelect').addEventListener('change', () => {
        const custom = $('channelSelect').value === '__custom__';
        $('channelCustom').hidden = !custom;
        $('channelWarn').hidden = !custom || !$('channelCustom').value;
    });
    $('channelCustom').addEventListener('input', () => {
        $('channelCustom').value = normalizeChannel($('channelCustom').value);
        $('channelWarn').hidden = !$('channelCustom').value;
    });
    $('btnAppend').addEventListener('click', appendToCatalog);
    $('btnCopyJson').addEventListener('click', () => {
        navigator.clipboard.writeText($('jsonPreview').textContent).then(
            () => log('JSON copied.'), () => log('Clipboard copy failed.', true));
    });
    $('btnRefreshRecent').addEventListener('click', refreshRecent);

    // batch
    $('btnBuildQueue').addEventListener('click', buildQueue);
    $('btnReviewNext').addEventListener('click', reviewNext);
    $('btnExportSkipped').addEventListener('click', exportSkipped);
    $('btnClearQueue').addEventListener('click', () => {
        state.batch = [];
        state.batchActiveIndex = -1;
        saveBatch();
        renderBatch();
        log('Batch queue cleared.');
    });

    // settings
    $('btnSaveSettings').addEventListener('click', saveSettings);
    $('btnTestTmdb').addEventListener('click', testTmdb);
    $('btnTestOmdb').addEventListener('click', testOmdb);
    $('btnTestGithub').addEventListener('click', testGithub);
    $('targetGithub').addEventListener('change', () => $('githubSettings').style.display = '');
    $('targetDownload').addEventListener('change', () => $('githubSettings').style.display = 'none');

    // log
    $('btnClearLog').addEventListener('click', e => {
        e.preventDefault();
        $('logList').innerHTML = '';
        $('logLatest').textContent = '';
    });
}

function boot() {
    loadSettings();
    loadBatch();
    wire();
    renderBatch();
    if (state.settings.target === 'download') $('githubSettings').style.display = 'none';

    const firstRun = !state.settings.tmdb;
    if (firstRun) {
        $('firstRunBanner').hidden = false;
        switchView('viewSettings');
        log('Welcome! Add your TMDb key (and GitHub token) in Settings to get started.');
    }
    // channel import
    $('btnFetchChannel').addEventListener('click', importChannelVideos);
    $('chUrl').addEventListener('keydown', e => { if (e.key === 'Enter') importChannelVideos(); });
    $('btnTestYt').addEventListener('click', async () => {
        readSettingsForm();
        const msg = $('ytTestMsg');
        try {
            const data = await fetchJson(`${YT_API}channels?part=id&forHandle=youtube&key=${encodeURIComponent(ytKey())}`);
            if (!data?.items?.length) throw new Error('Unexpected response — check the key.');
            msg.textContent = 'Works ✓'; msg.className = 'test-msg ok';
        } catch (e) { msg.textContent = e.message; msg.className = 'test-msg err'; }
    });

    log('FlixMine Cataloger ready (build v6).');
    bootData();
    // Resume matching for a restored queue (a reload interrupts the run)
    if (state.batch.some(i => i.status === 'queued') && state.settings.tmdb.trim()) {
        log('Resuming batch matching for queued items…');
        runBatchMatching();
    }
}

boot();
