/* ============================================================
   Slip Builder — front end
   ------------------------------------------------------------
   Everything you need to wire up lives in CONFIG + the three
   request functions (fetchLeagues / requestSlips / fetchFeed).
   With CONFIG.useMock = true the whole UI runs on sample data
   so you can style and click through it without a backend.
   ============================================================ */

// Bump on every deploy. Shown top-right and appended to every agent prompt.
const APP_VERSION = 'v0.5.1';

const CONFIG = {
  // Flip to false once your endpoints are live.
  useMock: false,

  endpoints: {
    leagues:  '/api/leagues',          // GET  -> { leagues: ["MLB","NFL"] }  (or a bare array)
    generate: '/api/generate-slips',   // POST -> { slips: [...] }            (see SLIP SHAPE below)
    history:  '/api/history',          // GET  -> { slips: [...] }
    review:   '/api/review',           // GET  -> { notes:  [...] }
    stats:    '/api/player-stats',     // GET  -> { players:[...] }           (see PLAYER SHAPE below)
  },

  // ESPN headshots: <base><espnId>.png. Used when a leg has espnId + league.
  headshotBase: {
    MLB: 'https://a.espncdn.com/i/headshots/mlb/players/full/',
    NFL: 'https://a.espncdn.com/i/headshots/nfl/players/full/',
    NBA: 'https://a.espncdn.com/i/headshots/nba/players/full/',
    NHL: 'https://a.espncdn.com/i/headshots/nhl/players/full/',
    WNBA: 'https://a.espncdn.com/i/headshots/wnba/players/full/',
  },
};

/* ------------------------------------------------------------
   SLIP SHAPE the UI expects back from /api/generate-slips.
   Unknown fields are ignored; missing ones just render empty.

   {
     "slips": [{
       "id": "slip-1",
       "entryType": "flex",            // "flex" | "power"
       "entry": 25,                    // dollars staked on THIS slip
       "multiplier": 2.25,
       "payout": 56.25,
       "note": "Why the agent built it this way.",
       "legs": [{
         "player": "Ja'Marr Chase",
         "league": "NFL",
         "team": "CIN",
         "opponent": "vs BAL",
         "stat": "Receiving Yards",
         "line": 79.5,
         "pick": "more",              // "more" | "less"
         "espnId": "4362628",         // optional -> headshot
         "headshot": null             // or a direct image URL, wins over espnId
       }]
     }]
   }
   If your agent answers with plain text instead, send
   { "text": "..." } and it renders in a plain card.

   PLAYER SHAPE for the Stats tab (/api/player-stats):
   {
     "players": [{
       "player": "Ja'Marr Chase", "league": "NFL", "team": "CIN",
       "position": "WR", "opponent": "vs BAL", "espnId": "4362628",
       "stat": "Receiving Yards", "line": 79.5,
       "season": 84.2, "last5": 91.0, "hitRate": 60,
       "log": [64, 93, 71, 118, 82, 56, 104, 88, 76, 131]   // oldest -> newest
     }]
   }
------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  leagues: [],
  selectedLeagues: new Set(),
  generating: false,
  historyFilter: 'all',
  historyCache: null,
  statsFilter: 'all',
  statsCache: null,
};

/* ============================================================
   1. Requests — swap these for your real calls
   ============================================================ */

async function fetchLeagues() {
  if (CONFIG.useMock) {
    await wait(700);
    return ['MLB', 'NFL', 'NBA', 'NCAAF'];
  }
  const res = await fetch(CONFIG.endpoints.leagues);
  if (!res.ok) throw new Error(`Leagues failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.leagues || []);
}

// Sent with every request so the app gets cards, not a wall of text, whether or
// not the agent's Console prompt already says so. Mirrors SLIP SHAPE above.
const REPLY_FORMAT =
  'REPLY FORMAT: one short sentence of summary, then END with a single ```json fenced block, nothing after it, no markdown tables. ' +
  'Shape: {"slips":[{"id":"slip-1","entryType":"flex"|"power","entry":<stake in dollars for this slip>,"multiplier":<payout multiplier>,"payout":<projected payout in dollars>,' +
  '"note":"<1-2 sentences on why>","legs":[{"player":"","league":"MLB","team":"CHC","opponent":"vs CIN","stat":"Hits","line":0.5,"pick":"more"|"less"}]}]}.';

function buildAgentMessage(payload) {
  const parts = [
    `Build ${payload.slipCount} slip(s).`,
    `Leagues: ${payload.leagues.length ? payload.leagues.join(', ') : 'any active league'}.`,
    `${payload.legs}-pick ${payload.entryType === 'power' ? 'Power Play' : 'Flex'}.`,
    payload.bankroll > 0
      ? `Bankroll: $${payload.bankroll} — size the stake off this.`
      : `No bankroll given for this request — use whatever's already on file, or a small default.`,
    payload.notes ? `Additional instructions: ${payload.notes}` : '',
    REPLY_FORMAT,
    `[${APP_VERSION}]`,
  ];
  return parts.filter(Boolean).join(' ');
}

// Real agent runs can take 30s-2min (odds lookups, subagent handoffs), well
// past a normal serverless function's timeout — so this doesn't wait on one
// request. It starts a session, then polls from the browser (no timeout
// here) until the agent goes idle, then pulls the JSON block out of its
// final message.
async function requestSlips(payload) {
  if (CONFIG.useMock) {
    await wait(1800);
    return mockSlips(payload);
  }

  const message = buildAgentMessage(payload);

  const startRes = await fetch('/api/start-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, leagues: payload.leagues }),
  });
  const startData = await startRes.json();
  if (!startRes.ok || startData.error) throw new Error(startData.error || `Start failed (${startRes.status})`);
  const sessionId = startData.session_id;

  return pollForSlips(sessionId);
}

function pollForSlips(sessionId, { timeoutMs = 180000, intervalMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let since = null;            // processed_at of newest event seen (API has no "after id")
    const seen = new Set();
    const texts = [];            // every primary-agent message, in order
    const startedAt = Date.now();
    let busy = false;

    const finish = (fn, arg) => { clearInterval(timer); fn(arg); };

    const timer = setInterval(async () => {
      if (busy) return;          // don't overlap slow polls
      busy = true;
      try {
        if (Date.now() - startedAt > timeoutMs) {
          return finish(reject, new Error('Timed out waiting for the agent to respond.'));
        }

        const qs = new URLSearchParams({ session_id: sessionId });
        if (since) qs.set('since', since);
        const res = await fetch(`/api/get-events?${qs}`);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Events failed (${res.status})`);

        for (const ev of data.data || []) {
          if (seen.has(ev.id)) continue;
          seen.add(ev.id);
          if (ev.processed_at && (!since || ev.processed_at > since)) since = ev.processed_at;

          if (ev.type === 'agent.message') {
            const text = (ev.content || []).map((c) => c.text || '').join('');
            if (text) texts.push(text);
          } else if (ev.type === 'session.status_idle') {
            const reason = ev.stop_reason && ev.stop_reason.type;
            if (reason === 'end_turn') {
              // Prefer the latest message carrying the JSON block, in case the
              // agent closed with a short sign-off after it.
              const withJson = [...texts].reverse().find((t) => t.includes('```json'));
              return finish(resolve, parseAgentReply(withJson || texts[texts.length - 1] || ''));
            }
            return finish(reject, new Error(`Agent stopped early (${reason || 'unknown'}).`));
          } else if (ev.type === 'session.status_terminated') {
            return finish(reject, new Error('Agent session terminated.'));
          } else if (ev.type === 'session.error' && ev.error && ev.error.retry_status &&
                     ev.error.retry_status.type !== 'retrying') {
            return finish(reject, new Error(ev.error.message || 'Agent session error.'));
          }
        }
      } catch (err) {
        finish(reject, err);
      } finally {
        busy = false;
      }
    }, intervalMs);
  });
}

function parseAgentReply(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && Array.isArray(parsed.slips)) return parsed;
    } catch {
      // fall through to plain-text fallback below
    }
  }
  // Agent didn't return the structured block (or it didn't parse) —
  // fall back to showing its raw explanation rather than breaking the UI.
  return { text: text || 'The agent responded with no readable content.' };
}

async function fetchFeed(kind) {
  if (CONFIG.useMock) {
    await wait(600);
    if (kind === 'history') return { slips: mockHistory() };
    if (kind === 'stats') return { players: mockPlayerStats() };
    return { notes: mockNotes() };
  }
  const res = await fetch(CONFIG.endpoints[kind]);
  if (!res.ok) throw new Error(`${kind} failed (${res.status})`);
  return res.json();
}

/* ============================================================
   2. The payload your agent receives
   ============================================================ */

function buildPayload() {
  const bankroll = Number($('#bankroll').value) || 0;
  return {
    leagues: Array.from(state.selectedLeagues),
    legs: Number($('#legs').value),
    entryType: $('input[name="entryType"]:checked').value,
    bankroll,                       // 0 means "not specified — don't size off it"
    notes: $('#notes').value.trim(),
    slipCount: Number($('#slip-count').value) || 1,
  };
}

/* ============================================================
   3. Leagues — dynamic chips, skeleton, empty state
   ============================================================ */

async function loadLeagues() {
  const wrap = $('#league-chips');
  const empty = $('#leagues-empty');
  wrap.dataset.state = 'loading';
  empty.hidden = true;
  wrap.innerHTML = '<span class="chip chip--skeleton"></span><span class="chip chip--skeleton"></span><span class="chip chip--skeleton"></span>';

  try {
    const leagues = await fetchLeagues();
    state.leagues = leagues;
    state.selectedLeagues.forEach((l) => { if (!leagues.includes(l)) state.selectedLeagues.delete(l); });

    if (!leagues.length) {
      wrap.innerHTML = '';
      wrap.dataset.state = 'empty';
      empty.hidden = false;
      return;
    }

    wrap.dataset.state = 'ready';
    wrap.innerHTML = leagues.map((league, i) => {
      const id = `league-${i}`;
      const checked = state.selectedLeagues.has(league) ? ' checked' : '';
      return `<label class="chip" for="${id}">
        <input class="sr-only" type="checkbox" id="${id}" name="leagues" value="${escapeAttr(league)}"${checked}>
        ${escapeHtml(league)}
      </label>`;
    }).join('');

    wrap.querySelectorAll('input[name="leagues"]').forEach((box) => {
      box.addEventListener('change', () => {
        if (box.checked) state.selectedLeagues.add(box.value);
        else state.selectedLeagues.delete(box.value);
      });
    });
  } catch (err) {
    wrap.innerHTML = '';
    wrap.dataset.state = 'error';
    empty.hidden = false;
    empty.textContent = `Couldn't load leagues — ${err.message}`;
  }
}

/* ============================================================
   4. Generate + render
   ============================================================ */

async function onSubmit(event) {
  event.preventDefault();
  if (state.generating) return;

  const error = $('#form-error');
  error.hidden = true;

  if (!state.selectedLeagues.size) {
    error.textContent = 'Pick at least one league first.';
    error.hidden = false;
    return;
  }

  const payload = buildPayload();
  setGenerating(true);
  showThinking(payload);

  try {
    const data = await requestSlips(payload);
    renderResults(data, payload);
  } catch (err) {
    $('#results').innerHTML = `<p class="form-error">Couldn't build the slips — ${escapeHtml(err.message)}</p>`;
  } finally {
    setGenerating(false);
  }
}

// Renders sample slips through the normal card path. No agent, Anthropic or
// PrizePicks call, so it costs nothing (headshots still resolve via free ESPN).
function onDemo() {
  if (state.generating) return;
  $('#form-error').hidden = true;
  const payload = buildPayload();
  renderResults(mockSlips(payload), payload);
}

function setGenerating(on) {
  state.generating = on;
  const btn = $('#generate-btn');
  btn.classList.toggle('is-loading', on);
  btn.disabled = on;
  btn.querySelector('.cta__label').textContent = on ? 'Building…' : 'Generate Slips';
  $('#results').setAttribute('aria-busy', String(on));
  const agent = $('#agent-state');
  agent.textContent = on ? 'Agent working' : 'Agent ready';
  agent.classList.toggle('is-working', on);
}

function showThinking(payload) {
  const count = payload.slipCount > 1 ? `${payload.slipCount} slips` : 'your slip';
  $('#results').innerHTML = `
    <div class="thinking">
      <span class="thinking__dots"><i></i><i></i><i></i></span>
      <span class="thinking__text">Scanning ${escapeHtml(payload.leagues.join(', '))} for a ${payload.legs}-leg ${escapeHtml(payload.entryType)} — building ${escapeHtml(count)}…</span>
    </div>
    <div class="skeleton-card"></div>`;
}

function renderResults(data, payload) {
  const box = $('#results');
  const slips = Array.isArray(data) ? data : (data && data.slips) || [];

  if (!slips.length) {
    const text = (data && (data.text || data.message)) || '';
    box.innerHTML = text
      ? `<div class="slip"><p class="slip__note">${escapeHtml(text)}</p></div>`
      : `<div class="results__empty"><p>The agent came back empty. Try loosening the notes or adding a league.</p></div>`;
    return;
  }

  slips.forEach((s) => (s.legs || []).forEach((l) => { delete l.espnId; delete l.headshot; }));

  box.innerHTML =
    `<div class="results__head">
       <h2>${slips.length > 1 ? `${slips.length} slips` : 'Your slip'}</h2>
       <span>${escapeHtml(payload.entryType)} · ${payload.legs} legs</span>
     </div>` + slips.map(slipCard).join('');

  wireAvatarFallbacks(box);
  fillHeadshots(slips, box); // async; silhouettes stay until (and unless) a confident match comes back
}

// Photos come only from /api/headshots (ESPN search + strict name matching).
// Any espnId/headshot the agent supplies is dropped: a guessed id would show the
// wrong player, and no photo is better than a wrong one.
async function fillHeadshots(slips, box) {
  const byLeague = {};
  for (const s of slips) {
    for (const leg of s.legs || []) {
      if (!leg.player || !leg.league) continue;
      (byLeague[leg.league] ||= new Set()).add(leg.player);
    }
  }
  for (const [league, names] of Object.entries(byLeague)) {
    try {
      const res = await fetch('/api/headshots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ league, names: [...names] }),
      });
      const { headshots = {} } = await res.json();
      box.querySelectorAll('.avatar[data-player]').forEach((el) => {
        const url = el.dataset.league === league && headshots[el.dataset.player];
        if (!url) return;
        el.innerHTML = `<img src="${escapeAttr(url)}" alt="" loading="lazy">`;
        wireAvatarFallbacks(el);
      });
    } catch { /* cosmetic: silhouettes stay */ }
  }
}

function slipCard(slip, index) {
  const legs = slip.legs || [];
  const type = (slip.entryType || 'flex').toUpperCase();
  // Bankroll 0 means the user didn't set a stake — don't print "$0" as if it were one.
  const entry = slip.entry ? money(slip.entry) : 'No stake';
  const payout = slip.payout ? money(slip.payout) : '—';
  const mult = slip.multiplier ? `${slip.multiplier}x` : '';

  return `<article class="slip">
    <div class="slip__head">
      <div>
        <div class="slip__title">Slip ${index + 1} · ${escapeHtml(type)}</div>
        <div class="slip__sub">${legs.length} legs${mult ? ` · ${escapeHtml(mult)}` : ''}</div>
      </div>
      <span class="badge badge--accent">${entry}</span>
    </div>

    <div class="legs">${legs.map(legRow).join('')}</div>

    <div class="slip__foot">
      <span class="k">Projected payout</span>
      <span class="v">${payout}</span>
    </div>
    ${slip.note ? `<p class="slip__note">${escapeHtml(slip.note)}</p>` : ''}
  </article>`;
}

function legRow(leg) {
  const isMore = (leg.pick || 'more').toLowerCase() === 'more';
  const arrow = isMore
    ? '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10V2"></path><path d="M2.5 5.5L6 2l3.5 3.5"></path></svg>'
    : '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v8"></path><path d="M2.5 6.5L6 10l3.5-3.5"></path></svg>';

  const meta = [leg.team, leg.opponent, leg.stat].filter(Boolean).join(' · ');

  return `<div class="leg">
    ${avatar(leg)}
    <div class="leg__body">
      <span class="leg__name">${escapeHtml(leg.player || 'Unknown player')}</span>
      <span class="leg__meta">${escapeHtml(meta)}</span>
    </div>
    <div class="leg__pick">
      <span class="leg__line">${leg.line != null ? escapeHtml(String(leg.line)) : '—'}</span>
      <span class="leg__dir ${isMore ? 'is-more' : 'is-less'}">${arrow}${isMore ? 'More' : 'Less'}</span>
    </div>
  </div>`;
}

const SILHOUETTE = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="18" r="8.5" fill="currentColor"></circle><path d="M8 48c0-8.8 7.2-14.5 16-14.5S40 39.2 40 48z" fill="currentColor"></path></svg>';

function avatar(leg) {
  const src = leg.headshot || headshotUrl(leg);
  if (!src) return `<span class="avatar" data-player="${escapeAttr(leg.player || '')}" data-league="${escapeAttr(leg.league || '')}">${SILHOUETTE}</span>`;
  return `<span class="avatar"><img src="${escapeAttr(src)}" alt="" loading="lazy"></span>`;
}

// ESPN ids 404 often enough that every headshot needs a fallback.
function wireAvatarFallbacks(root) {
  root.querySelectorAll('.avatar img').forEach((img) => {
    img.addEventListener('error', () => { img.parentNode.innerHTML = SILHOUETTE; }, { once: true });
    if (img.complete && img.naturalWidth === 0) img.parentNode.innerHTML = SILHOUETTE;
  });
}

function headshotUrl(leg) {
  if (!leg.espnId || !leg.league) return null;
  const base = CONFIG.headshotBase[String(leg.league).toUpperCase()];
  return base ? `${base}${leg.espnId}.png` : null;
}

/* ============================================================
   5. Stats tab — the players the agent has been using
   ============================================================ */

async function loadStats() {
  const list = $('#stats-list');
  list.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
  try {
    const data = await fetchFeed('stats');
    state.statsCache = Array.isArray(data) ? data : (data.players || []);
    renderStatsFilters();
    renderStats();
  } catch (err) {
    list.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

function renderStatsFilters() {
  const leagues = Array.from(new Set((state.statsCache || []).map((p) => p.league).filter(Boolean)));
  if (!leagues.includes(state.statsFilter)) state.statsFilter = 'all';

  $('#stats-filters').innerHTML = ['all', ...leagues].map((key) => {
    const active = key === state.statsFilter ? ' is-active' : '';
    return `<button class="chip${active}" type="button" data-filter="${escapeAttr(key)}">${key === 'all' ? 'All' : escapeHtml(key)}</button>`;
  }).join('');

  $$('#stats-filters .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.statsFilter = chip.dataset.filter;
      renderStatsFilters();
      renderStats();
    });
  });
}

function renderStats() {
  const list = $('#stats-list');
  const all = state.statsCache || [];
  const players = state.statsFilter === 'all' ? all : all.filter((p) => p.league === state.statsFilter);

  if (!players.length) {
    list.innerHTML = '<p class="list-empty">No player stats yet.</p>';
    return;
  }

  list.innerHTML = players.map(playerCard).join('');
  wireAvatarFallbacks(list);
}

function playerCard(p) {
  const meta = [p.team, p.position, p.opponent].filter(Boolean).join(' · ');
  const hit = Number(p.hitRate);
  const hitClass = Number.isFinite(hit) ? (hit >= 60 ? ' is-up' : hit < 50 ? ' is-down' : '') : '';
  return `<article class="pcard">
    <div class="pcard__top">
      ${avatar(p)}
      <div class="pcard__body">
        <span class="pcard__name">${escapeHtml(p.player || '')}</span>
        <span class="pcard__meta">${escapeHtml(meta)}</span>
      </div>
      <div class="pcard__line">
        <span class="k">${escapeHtml(p.stat || 'Line')}</span>
        <span class="v">${p.line != null ? escapeHtml(String(p.line)) : '—'}</span>
      </div>
    </div>

    <div class="micro">
      <div class="micro__cell">
        <span class="micro__k">Season</span>
        <span class="micro__v">${fmtAvg(p.season)}</span>
      </div>
      <div class="micro__cell">
        <span class="micro__k">Last 5</span>
        <span class="micro__v">${fmtAvg(p.last5)}</span>
      </div>
      <div class="micro__cell">
        <span class="micro__k">Hit rate</span>
        <span class="micro__v${hitClass}">${Number.isFinite(hit) ? `${hit}%` : '—'}</span>
      </div>
    </div>

    ${sparkline(p)}
  </article>`;
}

// Last-10 game log: bars over the line take the accent, the dashed rule is the line.
function sparkline(p) {
  const log = Array.isArray(p.log) ? p.log : [];
  if (!log.length) return '';

  const line = Number(p.line);
  const peak = Math.max(...log, Number.isFinite(line) ? line : 0) || 1;
  const bars = log.map((v) => {
    const h = Math.max(3, Math.round((Number(v) / peak) * 40));
    const over = Number.isFinite(line) && Number(v) > line;
    return `<span class="spark__bar${over ? ' is-over' : ''}" style="height:${h}px" title="${escapeAttr(String(v))}"></span>`;
  }).join('');

  const lineBottom = Number.isFinite(line) ? Math.round((line / peak) * 40) : null;
  const overs = Number.isFinite(line) ? log.filter((v) => Number(v) > line).length : 0;

  return `<div class="spark" role="img" aria-label="Last ${log.length} games: ${escapeAttr(log.join(', '))}">
      ${lineBottom != null ? `<span class="spark__line" style="bottom:${lineBottom}px"></span>` : ''}
      ${bars}
    </div>
    <div class="spark__foot">
      <span>Last ${log.length}</span>
      <span class="mono">${overs} over · ${log.length - overs} under</span>
    </div>`;
}

/* ============================================================
   6. History + Review
   ============================================================ */

async function loadHistory() {
  const list = $('#history-list');
  list.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
  try {
    const data = await fetchFeed('history');
    state.historyCache = Array.isArray(data) ? data : (data.slips || []);
    renderHistoryStats(state.historyCache);
    renderHistory();
  } catch (err) {
    list.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

function renderHistoryStats(slips) {
  const settled = slips.filter((s) => s.status !== 'pending');
  const won = settled.filter((s) => s.status === 'won').length;
  const lost = settled.length - won;
  // Pending slips are still in play — they don't count toward net yet.
  const net = settled.reduce((sum, s) => sum + ((s.payout || 0) - (s.entry || 0)), 0);
  const rate = settled.length ? Math.round((won / settled.length) * 100) : 0;

  $('#history-stats').innerHTML = `
    <div class="stat"><span class="stat__k">Record</span><span class="stat__v">${won}-${lost}</span></div>
    <div class="stat"><span class="stat__k">Net</span><span class="stat__v ${net >= 0 ? 'is-up' : 'is-down'}">${net >= 0 ? '+' : '−'}${money(Math.abs(net))}</span></div>
    <div class="stat"><span class="stat__k">Hit rate</span><span class="stat__v">${rate}%</span></div>`;
}

function renderHistory() {
  const list = $('#history-list');
  const all = state.historyCache || [];
  const slips = state.historyFilter === 'all' ? all : all.filter((s) => s.status === state.historyFilter);

  if (!slips.length) {
    list.innerHTML = '<p class="list-empty">Nothing here yet.</p>';
    return;
  }

  list.innerHTML = slips.map((slip) => {
    const badge = { won: 'badge--accent', lost: 'badge--red', pending: 'badge--amber' }[slip.status] || 'badge--amber';
    const label = slip.status === 'pending' ? 'Live' : slip.status;
    const net = (slip.payout || 0) - (slip.entry || 0);

    return `<article class="slip">
      <div class="slip__head">
        <div>
          <div class="slip__title">${escapeHtml((slip.entryType || '').toUpperCase())} · ${(slip.legs || []).length} legs</div>
          <div class="slip__sub">${escapeHtml(slip.date || '')}${slip.league ? ` · ${escapeHtml(slip.league)}` : ''}</div>
        </div>
        <span class="badge ${badge}">${escapeHtml(label)}</span>
      </div>
      <div>${(slip.legs || []).map(resultLine).join('')}</div>
      <div class="slip__foot">
        <span class="k">${money(slip.entry)} entry${slip.multiplier ? ` · ${slip.multiplier}x` : ''}</span>
        <span class="v" style="color:${slip.status === 'pending' ? 'var(--amber)' : net >= 0 ? 'var(--accent)' : 'var(--red)'}">
          ${slip.status === 'pending' ? 'In play' : `${net >= 0 ? '+' : '−'}${money(Math.abs(net))}`}
        </span>
      </div>
    </article>`;
  }).join('');
}

function resultLine(leg) {
  const status = leg.status || 'open';
  const icons = {
    hit: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.3l2.4 2.4L9.5 4"></path></svg>',
    miss: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3.5 3.5l5 5"></path><path d="M8.5 3.5l-5 5"></path></svg>',
    open: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="6" r="3.5"></circle></svg>',
  };
  const cls = { hit: 'is-hit', miss: 'is-miss', open: 'is-open' }[status] || 'is-open';
  const color = { hit: 'var(--accent)', miss: 'var(--red)', open: 'var(--amber)' }[status] || 'var(--muted)';

  return `<div class="result-line">
    <span class="result-line__icon ${cls}">${icons[status] || icons.open}</span>
    <span class="result-line__name">${escapeHtml(leg.player || '')}</span>
    <span class="result-line__pick">${escapeHtml((leg.pick || '').toUpperCase())} ${escapeHtml(String(leg.line ?? ''))}</span>
    <span class="result-line__val" style="color:${color}">${leg.result != null ? escapeHtml(String(leg.result)) : '—'}</span>
  </div>`;
}

async function loadReview() {
  const list = $('#review-list');
  list.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
  try {
    const data = await fetchFeed('review');
    const notes = Array.isArray(data) ? data : (data.notes || []);
    list.innerHTML = notes.length
      ? notes.map((n) => `<article class="note">
          <div class="note__head">
            <span class="note__title">${escapeHtml(n.title || 'Note')}</span>
            <span class="note__date">${escapeHtml(n.date || '')}</span>
          </div>
          <p class="note__body">${escapeHtml(n.body || '')}</p>
        </article>`).join('')
      : '<p class="list-empty">No notes yet.</p>';
  } catch (err) {
    list.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

/* ============================================================
   6. Controls
   ============================================================ */

function initControls() {
  $('#app-version').textContent = APP_VERSION;
  // Slider
  const legs = $('#legs');
  const syncSlider = () => {
    $('#legs-value').textContent = legs.value;
    const pct = ((legs.value - legs.min) / (legs.max - legs.min)) * 100;
    legs.style.setProperty('--pct', `${pct}%`);
  };
  legs.addEventListener('input', syncSlider);
  syncSlider();

  // Bankroll quick-adds
  $$('.quick-add').forEach((btn) => {
    btn.addEventListener('click', () => {
      const field = $('#bankroll');
      const next = (Number(field.value) || 0) + Number(btn.dataset.add);
      field.value = Math.round(next * 100) / 100;
    });
  });
  $('#bankroll-clear').addEventListener('click', () => { $('#bankroll').value = 0; });

  // Slip count stepper
  const count = $('#slip-count');
  const step = (delta) => {
    const next = (Number(count.value) || 1) + delta;
    count.value = Math.min(Number(count.max), Math.max(Number(count.min), next));
  };
  $('#slips-minus').addEventListener('click', () => step(-1));
  $('#slips-plus').addEventListener('click', () => step(1));

  // Form
  $('#slip-form').addEventListener('submit', onSubmit);
  $('#demo-btn').addEventListener('click', onDemo);

  // Tabs
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  // History filters
  $$('#history-filters .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#history-filters .chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      state.historyFilter = chip.dataset.filter;
      renderHistory();
    });
  });

  $('#refresh-stats').addEventListener('click', loadStats);
  $('#refresh-history').addEventListener('click', loadHistory);
  $('#refresh-review').addEventListener('click', loadReview);
}

function switchView(name) {
  $$('.view').forEach((view) => {
    const on = view.id === `view-${name}`;
    view.classList.toggle('is-active', on);
    view.hidden = !on;
  });
  $$('.tab').forEach((tab) => {
    const on = tab.dataset.view === name;
    tab.classList.toggle('is-active', on);
    if (on) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  if (name === 'stats' && !state.statsCache) loadStats();
  if (name === 'history' && !state.historyCache) loadHistory();
  if (name === 'review' && !$('#review-list').children.length) loadReview();
}

/* ============================================================
   7. Helpers
   ============================================================ */

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  return `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
}

// Averages read better when the column lines up: 84.2 / 91.0, not 84.2 / 91.
function fmtAvg(n) {
  return n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toFixed(1);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const escapeAttr = escapeHtml;

/* ============================================================
   8. Mock data (delete once the backend is wired)
   ============================================================ */

function mockSlips(payload) {
  const pool = [
    { player: "Ja'Marr Chase", league: 'NFL', team: 'CIN', opponent: 'vs BAL', stat: 'Receiving Yards', line: 79.5, pick: 'more', espnId: '4362628' },
    { player: 'Bijan Robinson', league: 'NFL', team: 'ATL', opponent: 'at CAR', stat: 'Rushing Yards', line: 71.5, pick: 'more', espnId: '4430807' },
    { player: 'Justin Jefferson', league: 'NFL', team: 'MIN', opponent: 'vs GB', stat: 'Receptions', line: 6.5, pick: 'less', espnId: '4262921' },
    { player: 'Shohei Ohtani', league: 'MLB', team: 'LAD', opponent: 'vs SD', stat: 'Total Bases', line: 1.5, pick: 'more', espnId: '39832' },
    { player: 'Aaron Judge', league: 'MLB', team: 'NYY', opponent: 'at BOS', stat: 'Home Runs', line: 0.5, pick: 'more', espnId: '33192' },
    { player: 'Patrick Mahomes', league: 'NFL', team: 'KC', opponent: 'at DEN', stat: 'Passing Yards', line: 271.5, pick: 'less', espnId: '3139477' },
  ];

  const table = { flex: { 2: 3, 3: 2.25, 4: 5, 5: 10, 6: 25 }, power: { 2: 3, 3: 5, 4: 10, 5: 20, 6: 37.5 } };
  const mult = table[payload.entryType][payload.legs] || 3;
  const stake = payload.bankroll > 0 ? Math.round((payload.bankroll / payload.slipCount) * 100) / 100 : 0;

  return {
    slips: Array.from({ length: payload.slipCount }, (_, i) => ({
      id: `mock-${i}`,
      entryType: payload.entryType,
      entry: stake,
      multiplier: mult,
      payout: Math.round(stake * mult * 100) / 100,
      note: payload.notes
        ? `Built around your note: "${payload.notes}". Sample data — this is the mock response.`
        : 'Sample data — this is the mock response, not a real agent build.',
      legs: pool.slice(i, i + payload.legs).concat(pool.slice(0, Math.max(0, payload.legs - (pool.length - i)))),
    })),
  };
}

function mockHistory() {
  return [
    {
      id: 'h1', date: 'Sun Sep 14', league: 'NFL', entryType: 'flex', entry: 25, multiplier: 1.25, payout: 31.25, status: 'won',
      legs: [
        { player: "Ja'Marr Chase", pick: 'more', line: 79.5, result: 112, status: 'hit' },
        { player: 'Justin Jefferson', pick: 'less', line: 6.5, result: 5, status: 'hit' },
        { player: 'Bijan Robinson', pick: 'more', line: 71.5, result: 64, status: 'miss' },
      ],
    },
    {
      id: 'h2', date: 'Sat Sep 13', league: 'NFL', entryType: 'power', entry: 10, multiplier: 3, payout: 0, status: 'lost',
      legs: [
        { player: 'Patrick Mahomes', pick: 'more', line: 271.5, result: 248, status: 'miss' },
        { player: 'Puka Nacua', pick: 'more', line: 68.5, result: 91, status: 'hit' },
      ],
    },
    {
      id: 'h3', date: 'Today', league: 'MLB', entryType: 'flex', entry: 15, multiplier: 2.25, payout: 0, status: 'pending',
      legs: [
        { player: 'Shohei Ohtani', pick: 'more', line: 1.5, result: null, status: 'open' },
        { player: 'Aaron Judge', pick: 'more', line: 0.5, result: null, status: 'open' },
        { player: 'Gunnar Henderson', pick: 'less', line: 1.5, result: null, status: 'open' },
      ],
    },
  ];
}

function mockPlayerStats() {
  return [
    { player: "Ja'Marr Chase", league: 'NFL', team: 'CIN', position: 'WR', opponent: 'vs BAL', espnId: '4362628',
      stat: 'Receiving Yards', line: 79.5, season: 84.2, last5: 91.0, hitRate: 60, log: [64, 93, 71, 118, 82, 56, 104, 88, 76, 131] },
    { player: 'Bijan Robinson', league: 'NFL', team: 'ATL', position: 'RB', opponent: 'at CAR', espnId: '4430807',
      stat: 'Rushing Yards', line: 71.5, season: 76.8, last5: 69.4, hitRate: 50, log: [58, 84, 66, 73, 92, 47, 70, 61, 88, 54] },
    { player: 'Justin Jefferson', league: 'NFL', team: 'MIN', position: 'WR', opponent: 'vs GB', espnId: '4262921',
      stat: 'Receptions', line: 6.5, season: 7.1, last5: 6.8, hitRate: 70, log: [8, 5, 9, 7, 6, 10, 4, 7, 8, 6] },
    { player: 'Patrick Mahomes', league: 'NFL', team: 'KC', position: 'QB', opponent: 'at DEN', espnId: '3139477',
      stat: 'Passing Yards', line: 271.5, season: 268.4, last5: 284.0, hitRate: 50, log: [248, 312, 266, 289, 231, 305, 254, 278, 296, 262] },
    { player: 'Shohei Ohtani', league: 'MLB', team: 'LAD', position: 'DH', opponent: 'vs SD', espnId: '39832',
      stat: 'Total Bases', line: 1.5, season: 1.9, last5: 2.2, hitRate: 60, log: [1, 4, 0, 2, 3, 1, 2, 0, 5, 2] },
    { player: 'Aaron Judge', league: 'MLB', team: 'NYY', position: 'RF', opponent: 'at BOS', espnId: '33192',
      stat: 'Home Runs', line: 0.5, season: 0.6, last5: 0.8, hitRate: 40, log: [0, 1, 0, 0, 2, 1, 0, 0, 1, 0] },
  ];
}

function mockNotes() {
  return [
    { id: 'n1', title: 'Week 2 review', date: 'Sep 15', body: 'Receiving-yard overs on high-target WRs carried the week. The rushing-yard legs were the weak spot — three of four came in under.\n\nAdjustment: cap slips at one RB rushing leg.' },
    { id: 'n2', title: 'Flex vs Power', date: 'Sep 12', body: 'Flex 3-leg at 2.25x kept the bankroll flat through a 5-slip cold stretch. Power only makes sense when every leg clears 70% hit rate.' },
  ];
}

/* ============================================================
   Boot
   ============================================================ */

initControls();
loadLeagues();
