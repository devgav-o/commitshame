import { scoreMessage, postProcess, dedupForDisplay, getVerdict, getTier } from './scoring.js';

const STATE = {
  repo: null, branch: null, commits: [], scored: [],
  repoInfo: null, sort: 'score', poolRemaining: null, poolReset: null,
  _page: 1,
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
const escapeAttr = escapeHtml;

/* ─── api ─────────────────────────────────────────────────────── */

function trackQuotaFromResponse(res) {
  const rem = res.headers.get('x-pool-remaining');
  const reset = res.headers.get('x-pool-reset');
  if (rem !== null) STATE.poolRemaining = parseInt(rem, 10);
  if (reset !== null) STATE.poolReset = parseInt(reset, 10) * 1000;
  updateQuotaMeta();
}

function updateQuotaMeta() {
  const el = $('quota-meta');
  if (STATE.poolRemaining === null) return;
  const r = STATE.poolRemaining;
  if (r > 200) el.textContent = `pooled api · ${r} calls left`;
  else if (r > 0) {
    el.textContent = `⚠ pooled api · ${r} calls left`;
    el.style.color = 'var(--red)';
  } else {
    el.textContent = `pool dry · resets ${formatResetTime(STATE.poolReset)}`;
    el.style.color = 'var(--red)';
  }
}

function formatResetTime(ms) {
  if (!ms) return 'soon';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function apiGet(path) {
  const res = await fetch(path);
  trackQuotaFromResponse(res);
  if (!res.ok) {
    let payload = {};
    try { payload = await res.json(); } catch {}
    if (res.status === 429) throw new Error(payload.error || 'YOU ARE THROTTLED · COOL DOWN');
    if (res.status === 404) throw new Error('DEFENDANT NOT FOUND · check spelling, must be public');
    if (res.status === 403) throw new Error(`POOL EXHAUSTED · COURT RECONVENES AT ${formatResetTime(STATE.poolReset)}`);
    if (res.status === 409) throw new Error('EMPTY REPOSITORY · nothing to judge');
    if (res.status === 502) throw new Error('UPSTREAM ERROR · GitHub unreachable, try again');
    throw new Error(payload.error || `ERROR ${res.status}`);
  }
  return res.json();
}

async function fetchRepoInfo(repo) {
  return apiGet(`/api/repo/${repo}`);
}

async function fetchCommits(repo, branch, onProgress) {
  const pages = 5;
  let all = [];
  for (let p = 1; p <= pages; p++) {
    if (onProgress) onProgress(p, pages);
    const params = new URLSearchParams();
    params.set('page', p);
    if (branch) params.set('branch', branch);
    const data = await apiGet(`/api/commits/${repo}?${params}`);
    all = all.concat(data);
    if (data.length < 100) break;
  }
  return all;
}

/* ─── persistence ─────────────────────────────────────────────── */

const RECENT_KEY = 'commitshame_recent';

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}
function pushRecent(repo) {
  const cur = getRecent().filter(r => r !== repo);
  cur.unshift(repo);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 5))); } catch {}
  renderRecent();
}
function removeRecent(repo) {
  const cur = getRecent().filter(r => r !== repo);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(cur)); } catch {}
  renderRecent();
}
function renderRecent() {
  const list = getRecent();
  const row = $('recent-row');
  const chips = $('recent-chips');
  if (!list.length) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  chips.innerHTML = list.map(r =>
    `<button class="chip recent" data-repo="${escapeAttr(r)}">${escapeHtml(r)}<span class="chip-x" data-remove="${escapeAttr(r)}" title="forget">×</span></button>`
  ).join(' ');
}

/* ─── url state ───────────────────────────────────────────────── */

function readURL() {
  const p = new URLSearchParams(location.search);
  return { repo: p.get('repo'), branch: p.get('branch') };
}
function writeURL(repo, branch) {
  const p = new URLSearchParams();
  if (repo) p.set('repo', repo);
  if (branch) p.set('branch', branch);
  const q = p.toString();
  history.pushState({ repo, branch }, '', q ? `?${q}` : location.pathname);
}

function parseRepo(input) {
  input = (input || '').trim();
  if (!input) return null;
  const full = input.match(/github\.com\/([^/]+\/[^/?\s]+)/);
  if (full) return full[1].replace(/\.git$/, '');
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input)) return input;
  return null;
}

/* ─── helpers ─────────────────────────────────────────────────── */

const truncate = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
function shortDate(s) {
  const d = new Date(s);
  if (isNaN(d)) return '';
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) return 'today';
  if (days < 7) return days + 'd ago';
  if (days < 30) return Math.floor(days/7) + 'w ago';
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function sortScored(scored, mode) {
  const copy = [...scored];
  if (mode === 'recent') copy.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  else if (mode === 'repeats') copy.sort((a, b) => (b.repeat - a.repeat) || (b.score - a.score));
  else copy.sort((a, b) => b.score - a.score);
  return copy;
}

function computeOffenders(scored) {
  const map = new Map();
  for (const c of scored) {
    const k = c.author || 'Unknown';
    const cur = map.get(k) || { name: k, total: 0, count: 0 };
    cur.total += c.score * c.occurrences;
    cur.count += c.occurrences;
    map.set(k, cur);
  }
  const list = [...map.values()]
    .filter(o => o.count >= 2)
    .map(o => ({ ...o, avg: Math.round(o.total / o.count) }));
  list.sort((a, b) => b.count - a.count || b.avg - a.avg);
  return list;
}

function computeTimeline(scored, commits) {
  if (!commits.length) return null;
  const allDates = commits.map(c => new Date(c.commit?.author?.date || 0)).filter(d => !isNaN(d));
  if (!allDates.length) return null;
  const min = Math.min(...allDates);
  const max = Math.max(...allDates);
  const span = max - min;
  if (span <= 0) return null;
  const weeks = Math.max(10, Math.min(24, Math.ceil(span / (7 * 86400000))));
  const bucketMs = span / weeks;
  const buckets = new Array(weeks).fill(0);
  for (const c of scored) {
    const t = new Date(c.date).getTime();
    if (isNaN(t)) continue;
    const idx = Math.min(weeks - 1, Math.floor((t - min) / bucketMs));
    buckets[idx] += c.occurrences;
  }
  const peak = Math.max(...buckets, 1);
  const fmt = ms => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const mid = min + span / 2;
  return {
    buckets, peak, weeks, bucketMs, min, max,
    start: fmt(min), middle: fmt(mid), end: fmt(max),
  };
}

function timelineSVG(tl) {
  const W = 560, H = 90, padL = 4, padR = 4, padT = 4, padB = 4;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const gap = 2;
  const barW = (innerW - gap * (tl.weeks - 1)) / tl.weeks;
  const peakIdx = tl.buckets.indexOf(tl.peak);
  const bars = tl.buckets.map((v, i) => {
    const h = v === 0 ? 2 : Math.max(3, (v / tl.peak) * innerH);
    const x = padL + i * (barW + gap);
    const y = padT + (innerH - h);
    const isPeak = i === peakIdx && v > 0;
    const fill = v === 0 ? 'var(--rule)' : (isPeak ? 'var(--red)' : 'var(--ink)');
    const opacity = v === 0 ? 0.35 : (isPeak ? 1 : 0.78);
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" opacity="${opacity}"><title>${v} offense${v===1?'':'s'}</title></rect>`;
  }).join('');
  return `<svg class="tl-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="offenses over time">${bars}</svg>`;
}

/* ─── render ──────────────────────────────────────────────────── */

function render() {
  const { scored, commits, repo, branch, repoInfo } = STATE;
  const totalShame = scored.reduce((a, c) => a + c.occurrences, 0);
  const avgScore = scored.length
    ? Math.round(scored.reduce((s, c) => s + c.score * c.occurrences, 0) / Math.max(1, totalShame))
    : 0;
  const shameRate = commits.length > 0 ? Math.round((totalShame / commits.length) * 100) : 0;
  const verdict = getVerdict(avgScore, shameRate, totalShame);
  const tier = getTier(avgScore, totalShame);
  const top = sortScored(scored, STATE.sort).slice(0, 24);
  const offenders = computeOffenders(scored);
  const timeline = computeTimeline(scored, commits);

  const dateNow = new Date();
  const dateStr = dateNow.toISOString().slice(0, 10);
  const timeStr = dateNow.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const meterFill = Math.max(0, Math.min(100, avgScore));

  const html = `
    <div class="receipt fade-in" id="receipt-el">
      <div class="receipt-inner">
        <div class="r-title">★ ★ ★ Official Shame Receipt ★ ★ ★</div>
        <div class="r-subtitle">commitsha.me</div>
        <div class="r-divider"></div>

        <div class="meta-grid">
          <div class="meta-cell"><span class="k">repo</span><span class="v"><a href="https://github.com/${escapeAttr(repo)}" target="_blank" rel="noopener">${escapeHtml(repo)}</a></span></div>
          <div class="meta-cell"><span class="k">branch</span><span class="v">${escapeHtml(branch || repoInfo?.default_branch || 'default')}</span></div>
          <div class="meta-cell"><span class="k">analyzed</span><span class="v">${commits.length} commits</span></div>
          ${repoInfo?.language ? `<div class="meta-cell"><span class="k">language</span><span class="v">${escapeHtml(repoInfo.language)}</span></div>` : ''}
          ${repoInfo?.stargazers_count != null ? `<div class="meta-cell"><span class="k">stars</span><span class="v">${repoInfo.stargazers_count.toLocaleString()}</span></div>` : ''}
          <div class="meta-cell"><span class="k">date</span><span class="v">${dateStr}</span></div>
        </div>

        <div class="r-divider thick"></div>

        <div class="verdict-block">
          <div class="verdict-line">verdict</div>
          <div class="verdict-stamp">${escapeHtml(verdict.title)}</div>
          <div class="verdict-sub">${escapeHtml(verdict.sub)}</div>
          <div class="verdict-text">${escapeHtml(verdict.text)}</div>
        </div>

        <div class="r-divider thick"></div>

        <div class="score-card">
          <div class="score-card-head">
            <span class="k">shame score</span>
            <span class="score-explain">avg severity of bad commits · 0 clean → 100 cursed</span>
          </div>
          <div class="score-hero">
            <div class="score-big" data-count="${avgScore}">0<span class="of">/100</span></div>
            <div class="tier-badge tier-${tier.rank}">${escapeHtml(tier.name)}</div>
          </div>
          <div class="meter" aria-label="shame meter">
            <div class="meter-track">
              <div class="meter-zone z1"></div>
              <div class="meter-zone z2"></div>
              <div class="meter-zone z3"></div>
              <div class="meter-zone z4"></div>
              <div class="meter-zone z5"></div>
              <div class="meter-fill" style="width:${meterFill}%"></div>
              <div class="meter-marker" style="left:${meterFill}%"></div>
            </div>
            <div class="meter-axis">
              <span>0</span><span>20</span><span>40</span><span>60</span><span>80</span><span>100</span>
            </div>
            <div class="meter-zonelabels">
              <span>trace</span><span>mild</span><span>notable</span><span>heavy</span><span>legendary</span>
            </div>
          </div>
          <div class="mini-stats">
            <div class="mini-stat">
              <span class="mini-num" data-count="${totalShame}">0</span>
              <span class="mini-label">offenses</span>
            </div>
            <div class="mini-stat">
              <span class="mini-num" data-count="${shameRate}">0<span class="of">%</span></span>
              <span class="mini-label">of commits flagged</span>
            </div>
            <div class="mini-stat">
              <span class="mini-num">${commits.length}</span>
              <span class="mini-label">analyzed</span>
            </div>
          </div>
        </div>

        <div class="r-divider thick"></div>

        <div class="section-head">
          <span class="itemized-head">itemized offenses</span>
          <div class="sort-bar" id="sort-bar">
            <span data-sort="score" class="${STATE.sort==='score'?'active':''}">fine</span>
            <span data-sort="recent" class="${STATE.sort==='recent'?'active':''}">recent</span>
            <span data-sort="repeats" class="${STATE.sort==='repeats'?'active':''}">repeated</span>
          </div>
        </div>

        ${top.length === 0 ? `
          <div class="empty-note">
            no shameful commits in this window. either meticulous or covering tracks.
          </div>
        ` : top.map((c, i) => `
          <a class="commit-row" href="${escapeAttr(c.url)}" target="_blank" rel="noopener" data-rank="${i+1}">
            <div class="commit-line1">
              <span class="commit-rank">#${String(i+1).padStart(2,'0')}</span>
              <span class="commit-msg">${escapeHtml(truncate(c.msg, 70))}</span>
              <span class="commit-fine">¤${c.score}</span>
              <span class="commit-multi">${c.occurrences > 1 ? '×'+c.occurrences : ''}</span>
            </div>
            <div class="commit-line2">
              <span class="label">${escapeHtml(c.label)}</span>
              <span>${escapeHtml(c.author)}</span>
              ${c.date ? `<span>${shortDate(c.date)}</span>` : ''}
              <span class="sha">${c.sha.slice(0, 7)}</span>
            </div>
          </a>
        `).join('')}

        ${offenders.length >= 3 ? `
          <div class="r-divider thick" style="margin-top:18px;"></div>
          <div class="section-head">
            <span class="itemized-head">repeat offenders</span>
            <span class="section-sub">authors with most shame</span>
          </div>
          <div class="offenders-block">
            ${offenders.slice(0, 6).map((o, i) => {
              const maxCount = offenders[0].count || 1;
              const pct = Math.max(8, Math.round((o.count / maxCount) * 100));
              return `
              <div class="offender-row">
                <span class="offender-rank">#${i+1}</span>
                <div class="offender-main">
                  <div class="offender-line1">
                    <span class="offender-name">${escapeHtml(o.name)}</span>
                    <span class="offender-count">${o.count}</span>
                  </div>
                  <div class="offender-bar"><div class="offender-bar-fill" style="width:${pct}%"></div></div>
                </div>
                <span class="offender-avg">avg <strong>¤${o.avg}</strong></span>
              </div>
            `;}).join('')}
          </div>
        ` : ''}

        ${timeline ? `
          <div class="r-divider thick" style="margin-top:18px;"></div>
          <div class="section-head">
            <span class="itemized-head">shame over time</span>
            <span class="section-sub">peak in red</span>
          </div>
          <div class="timeline-block">
            ${timelineSVG(timeline)}
            <div class="timeline-axis">
              <span>${timeline.start}</span>
              <span>${timeline.middle}</span>
              <span>${timeline.end}</span>
            </div>
          </div>
        ` : ''}

        <div class="r-divider thick" style="margin-top:18px;"></div>
        <div class="receipt-foot">
          thank you for your cooperation · no refunds<br>
          commitshame · <a href="https://commitsha.me" style="border-bottom:1px dotted var(--ink-3);text-decoration:none;color:inherit;">commitsha.me</a><br>
          <span style="font-size:10px;letter-spacing:0.06em;">${escapeHtml(repo)} · ${dateStr} · ${timeStr}</span>
          <div class="barcode-fake"></div>
        </div>
      </div>
    </div>

    <div class="action-bar">
      <button class="action-btn primary" id="btn-download">↓ download receipt</button>
      <button class="action-btn" id="btn-share">⤴ share</button>
      <button class="action-btn" id="btn-permalink">⊕ permalink</button>
    </div>

    <a href="?" class="judge-another" id="judge-another">‹ judge another repo</a>
  `;

  const r = $('results');
  r.innerHTML = html;
  r.classList.add('show');

  bindResultEvents();
  animateCounters();
}

function animateCounters() {
  document.querySelectorAll('[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count, 10);
    if (isNaN(target)) return;
    const ofSpan = el.querySelector('.of');
    const suffix = ofSpan ? ofSpan.outerHTML : '';
    const start = performance.now();
    const dur = 700;
    const ease = t => 1 - Math.pow(1 - t, 3);
    function tick(now) {
      const t = Math.min(1, (now - start) / dur);
      const v = Math.round(target * ease(t));
      el.innerHTML = v + suffix;
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

function bindResultEvents() {
  document.querySelectorAll('#sort-bar span').forEach(el => {
    el.addEventListener('click', () => {
      STATE.sort = el.dataset.sort;
      render();
    });
  });
  $('btn-download')?.addEventListener('click', downloadReceipt);
  $('btn-share')?.addEventListener('click', shareReceipt);
  $('btn-permalink')?.addEventListener('click', copyPermalink);
  $('judge-another')?.addEventListener('click', e => {
    e.preventDefault();
    history.pushState({}, '', location.pathname);
    $('results').classList.remove('show');
    $('repo-input').value = '';
    $('repo-input').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

/* ─── canvas share card ───────────────────────────────────────── */

async function renderShareCardCanvas() {
  await document.fonts.ready;
  const dpr = 2;
  const W = 1200;
  const H = 630;

  const { scored, commits, repo, branch, repoInfo } = STATE;
  const totalShame = scored.reduce((a, c) => a + c.occurrences, 0);
  const avgScore = scored.length
    ? Math.round(scored.reduce((s, c) => s + c.score * c.occurrences, 0) / Math.max(1, totalShame))
    : 0;
  const shameRate = commits.length > 0 ? Math.round((totalShame / commits.length) * 100) : 0;
  const verdict = getVerdict(avgScore, shameRate, totalShame);
  const tier = getTier(avgScore, totalShame);
  const top = sortScored(scored, 'score').slice(0, 8);

  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Paper background with grain
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#f5f1e8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 12;
    d[i]   = Math.max(0, Math.min(255, d[i]   + n));
    d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
    d[i+2] = Math.max(0, Math.min(255, d[i+2] + n));
  }
  ctx.putImageData(img, 0, 0);
  ctx.restore();

  const FONT = "'IBM Plex Mono', 'Menlo', monospace";
  const STAMP_FONT = "'Special Elite', 'IBM Plex Mono', 'Menlo', monospace";
  const ink  = '#1a1410';
  const ink2 = '#4a3f37';
  const ink3 = '#8a7d70';
  const red  = '#c8302d';
  const rule = '#c9bfaf';
  const paper2 = '#ede7d8';

  const TEAR = 16;
  const PAD  = 52;

  // ── tear strips ──
  drawTearStrip(ctx, 0, 0, W, TEAR, true);
  drawTearStrip(ctx, 0, H - TEAR, W, TEAR, false);

  // ── HEADER (y: TEAR → TEAR+62) ──
  const HEADER_Y = TEAR + 14;
  ctx.fillStyle = ink;
  ctx.font = `700 18px ${STAMP_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('★  ★  ★   OFFICIAL SHAME RECEIPT   ★  ★  ★', W / 2, HEADER_Y + 14);
  ctx.fillStyle = ink3;
  ctx.font = `400 11px ${FONT}`;
  ctx.letterSpacing = '0.2em';
  ctx.fillText('C O M M I T S H A . M E', W / 2, HEADER_Y + 32);
  ctx.letterSpacing = '0em';

  const HDR_DIV = TEAR + 52;
  drawDashedLine(ctx, PAD, HDR_DIV, W - PAD, HDR_DIV, rule, 6);

  // ── TWO-COLUMN MAIN (y: HDR_DIV → HDR_DIV+290) ──
  const COL_DIV_X = 400;    // x where left col ends
  const MAIN_TOP  = HDR_DIV + 22;
  const MAIN_BOT  = HDR_DIV + 298;

  // vertical dashed divider between columns
  ctx.save();
  ctx.strokeStyle = rule;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(COL_DIV_X, MAIN_TOP);
  ctx.lineTo(COL_DIV_X, MAIN_BOT);
  ctx.stroke();
  ctx.restore();

  // ── LEFT COLUMN: repo info ──
  let lY = MAIN_TOP + 4;
  ctx.textAlign = 'left';

  // repo name — owner dimmed, name bold
  ctx.fillStyle = ink3;
  ctx.font = `400 12px ${FONT}`;
  ctx.fillText('REPOSITORY', PAD, lY);
  lY += 18;
  const rParts = repo.split('/');
  if (rParts.length === 2) {
    ctx.fillStyle = ink2;
    ctx.font = `400 19px ${FONT}`;
    const ownerW = ctx.measureText(rParts[0] + '/').width;
    ctx.fillText(rParts[0] + '/', PAD, lY);
    ctx.fillStyle = ink;
    ctx.font = `700 19px ${FONT}`;
    ctx.fillText(rParts[1], PAD + ownerW, lY);
  } else {
    ctx.fillStyle = ink;
    ctx.font = `700 19px ${FONT}`;
    ctx.fillText(repo, PAD, lY);
  }
  lY += 26;

  const metaLeft = [
    ['BRANCH',   branch || repoInfo?.default_branch || 'default'],
    ['ANALYZED', `${commits.length} commits`],
  ];
  if (repoInfo?.language)           metaLeft.push(['LANGUAGE', repoInfo.language]);
  if (repoInfo?.stargazers_count != null) metaLeft.push(['STARS', `★ ${repoInfo.stargazers_count.toLocaleString()}`]);
  metaLeft.push(['DATE', new Date().toISOString().slice(0, 10)]);

  for (const [k, v] of metaLeft) {
    ctx.fillStyle = ink3;
    ctx.font = `400 10px ${FONT}`;
    ctx.fillText(k, PAD, lY);
    ctx.fillStyle = ink2;
    ctx.font = `500 14px ${FONT}`;
    ctx.fillText(String(v), PAD + 88, lY);
    lY += 20;
  }

  // mini stats block at bottom of left col
  lY = MAIN_BOT - 70;
  drawDashedLine(ctx, PAD, lY - 10, COL_DIV_X - 20, lY - 10, rule, 4);
  const miniItems = [
    { num: String(totalShame), label: 'OFFENSES' },
    { num: `${shameRate}%`,    label: 'SHAME RATE' },
    { num: String(commits.length), label: 'ANALYZED' },
  ];
  const miniColW = (COL_DIV_X - PAD) / 3;
  for (let i = 0; i < 3; i++) {
    const cx = PAD + miniColW * i + miniColW / 2;
    ctx.fillStyle = i === 0 ? red : ink;
    ctx.font = `700 22px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(miniItems[i].num, cx, lY + 16);
    ctx.fillStyle = ink3;
    ctx.font = `400 9px ${FONT}`;
    ctx.fillText(miniItems[i].label, cx, lY + 29);
  }

  // ── RIGHT COLUMN: verdict + score ──
  const RX = COL_DIV_X + 36;
  const RW = W - RX - PAD;
  const RCX = RX + RW / 2;  // center x of right column
  let rY = MAIN_TOP + 10;

  // "VERDICT" label
  ctx.fillStyle = ink3;
  ctx.font = `400 11px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('V E R D I C T', RCX, rY + 8);
  rY += 26;

  // Big verdict stamp
  ctx.save();
  ctx.translate(RCX, rY + 44);
  ctx.rotate(-3 * Math.PI / 180);
  ctx.font = `700 62px ${STAMP_FONT}`;
  const stampW = ctx.measureText(verdict.title).width;
  const stampBoxW = stampW + 60;
  const stampBoxH = 82;
  // outer double border
  ctx.strokeStyle = red;
  ctx.lineWidth = 4;
  ctx.strokeRect(-stampBoxW / 2, -stampBoxH / 2, stampBoxW, stampBoxH);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-stampBoxW / 2 + 6, -stampBoxH / 2 + 6, stampBoxW - 12, stampBoxH - 12);
  // stamp text
  ctx.fillStyle = red;
  ctx.fillText(verdict.title, 0, 20);
  ctx.restore();
  rY += 100;

  // verdict sub
  ctx.fillStyle = ink3;
  ctx.font = `400 12px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(verdict.sub, RCX, rY);
  rY += 24;

  // score number + /100
  ctx.font = `700 80px ${FONT}`;
  ctx.fillStyle = ink;
  const scoreStr   = String(avgScore);
  const scoreNumW  = ctx.measureText(scoreStr).width;
  ctx.font = `400 24px ${FONT}`;
  const of100W     = ctx.measureText('/100').width;
  const scoreTotW  = scoreNumW + 8 + of100W;
  const scoreStartX = RCX - scoreTotW / 2;
  ctx.font = `700 80px ${FONT}`;
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.fillText(scoreStr, scoreStartX, rY + 60);
  ctx.font = `400 24px ${FONT}`;
  ctx.fillStyle = ink3;
  ctx.fillText('/100', scoreStartX + scoreNumW + 8, rY + 60);

  // tier badge to the right of score
  const tierColors = ['#2d6a3a', '#4a3f37', '#b07a00', '#c25a1d', '#c8302d', '#c8302d'];
  const tierColor = tierColors[tier.rank];
  ctx.font = `700 16px ${STAMP_FONT}`;
  const tNameW = ctx.measureText(tier.name).width;
  ctx.save();
  ctx.translate(scoreStartX + scoreTotW + 24 + tNameW / 2 + 12, rY + 30);
  ctx.rotate(-2 * Math.PI / 180);
  ctx.fillStyle = '#f5f1e8';
  ctx.strokeStyle = tierColor;
  ctx.lineWidth = tier.rank >= 5 ? 3 : 2;
  ctx.fillRect(-tNameW / 2 - 12, -16, tNameW + 24, 32);
  ctx.strokeRect(-tNameW / 2 - 12, -16, tNameW + 24, 32);
  if (tier.rank >= 5) ctx.strokeRect(-tNameW / 2 - 6, -10, tNameW + 12, 20);
  ctx.fillStyle = tierColor;
  ctx.textAlign = 'center';
  ctx.fillText(tier.name, 0, 5);
  ctx.restore();

  rY += 76;

  // shame meter in right column
  const mX = RX, mW = RW, mY2 = rY, mH = 16;
  const zoneColors = ['#a8c8a8','#d8c878','#dca070','#d88060','#c8302d'];
  const zoneAlpha  = [0.38, 0.42, 0.46, 0.46, 0.58];
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = zoneColors[i];
    ctx.globalAlpha = zoneAlpha[i];
    ctx.fillRect(mX + (mW / 5) * i, mY2, mW / 5, mH);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(mX, mY2, mW, mH);
  const fillPx = (Math.max(0, Math.min(100, avgScore)) / 100) * mW;
  ctx.save();
  ctx.beginPath();
  ctx.rect(mX, mY2, fillPx, mH);
  ctx.clip();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  for (let i = -mH; i < fillPx + mH; i += 5) {
    ctx.beginPath();
    ctx.moveTo(mX + i, mY2 + mH);
    ctx.lineTo(mX + i + mH, mY2);
    ctx.stroke();
  }
  ctx.restore();
  const markerX = mX + fillPx;
  ctx.fillStyle = red;
  ctx.fillRect(markerX - 2, mY2 - 6, 3, mH + 12);

  // zone labels under meter
  const zoneNames = ['TRACE', 'MILD', 'NOTABLE', 'HEAVY', 'LEGENDARY'];
  ctx.fillStyle = ink3;
  ctx.font = `400 9px ${FONT}`;
  ctx.textAlign = 'center';
  for (let i = 0; i < 5; i++) {
    ctx.fillText(zoneNames[i], mX + (mW / 5) * i + mW / 10, mY2 + mH + 14);
  }

  // ── DIVIDER ──
  drawDashedLine(ctx, PAD, MAIN_BOT + 2, W - PAD, MAIN_BOT + 2, rule, 6);
  drawDashedLine(ctx, PAD, MAIN_BOT + 8, W - PAD, MAIN_BOT + 8, rule, 6);

  // ── ITEMIZED OFFENSES (bottom two-column grid) ──
  const OFF_TOP = MAIN_BOT + 26;
  ctx.fillStyle = ink;
  ctx.font = `700 12px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('ITEMIZED OFFENSES', PAD, OFF_TOP);
  ctx.fillStyle = ink3;
  ctx.font = `400 10px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText('TOP BAD COMMITS', W - PAD, OFF_TOP);

  const numCols  = 2;
  const numRows  = 4;
  const offColW  = (W - PAD * 2) / numCols;
  const offRowH  = 24;

  for (let i = 0; i < Math.min(top.length, numCols * numRows); i++) {
    const c   = top[i];
    const col = Math.floor(i / numRows);
    const row = i % numRows;
    const ox  = PAD + col * offColW;
    const oy  = OFF_TOP + 18 + row * offRowH;

    ctx.fillStyle = ink3;
    ctx.font = `400 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(`#${String(i + 1).padStart(2, '0')}`, ox, oy);

    ctx.fillStyle = ink;
    ctx.font = `500 13px ${FONT}`;
    const maxMW = offColW - 100;
    const msgTxt = `"${truncate(c.msg, Math.floor(maxMW / 8.5))}"`;
    ctx.fillText(msgTxt, ox + 36, oy);

    ctx.fillStyle = red;
    ctx.font = `700 13px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(`¤${c.score}`, ox + offColW - 4, oy);
  }

  // ── FOOTER ──
  const FOOT_Y = H - TEAR - 46;
  drawDashedLine(ctx, PAD, FOOT_Y - 12, W - PAD, FOOT_Y - 12, rule, 4);

  // barcode block centred in footer
  const bcW = 200, bcH = 22;
  const bcX = W / 2 - bcW / 2;
  const bcY = FOOT_Y - 2;
  ctx.save();
  const pattern = [1,3,1,2,2,2,1,1,3,1,2,2,1,3,1,1,2,3,1,2];
  let bx = bcX;
  let fill = true;
  for (const seg of pattern) {
    const sw2 = (seg / 18) * bcW;
    if (fill) { ctx.fillStyle = ink; ctx.fillRect(bx, bcY, sw2, bcH); }
    bx += sw2;
    fill = !fill;
  }
  ctx.restore();

  ctx.fillStyle = ink3;
  ctx.font = `400 11px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(`github.com/${repo}`, PAD, FOOT_Y + 22);
  ctx.textAlign = 'right';
  ctx.fillText(`commitsha.me  ·  ${new Date().toISOString().slice(0, 10)}`, W - PAD, FOOT_Y + 22);

  return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/png'));
}

function drawTearStrip(ctx, x, y, w, h, flip) {
  ctx.save();
  const tooth = 16;
  ctx.fillStyle = '#f5f1e8';
  ctx.beginPath();
  if (flip) {
    ctx.moveTo(x, y + h);
    for (let i = 0; i <= w; i += tooth) ctx.lineTo(i, y + (i % (tooth*2) === 0 ? 0 : h));
    ctx.lineTo(x + w, y + h);
  } else {
    ctx.moveTo(x, y);
    for (let i = 0; i <= w; i += tooth) ctx.lineTo(i, y + (i % (tooth*2) === 0 ? h : 0));
    ctx.lineTo(x + w, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawDashedLine(ctx, x1, y1, x2, y2, color, dash = 4) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([dash, dash]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, align = 'left') {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  const prevAlign = ctx.textAlign;
  ctx.textAlign = align;
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  ctx.textAlign = prevAlign;
}

/* ─── share / download / permalink ────────────────────────────── */

async function downloadReceipt() {
  toast('rendering receipt…');
  const blob = await renderShareCardCanvas();
  if (!blob) { toast('render failed'); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `commit-shame-${(STATE.repo || 'receipt').replace('/', '-')}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('receipt saved');
}

async function shareReceipt() {
  const text = buildShareText();
  const url = location.href;
  if (navigator.canShare && navigator.share) {
    try {
      const blob = await renderShareCardCanvas();
      const file = new File([blob], 'commit-shame.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ title: 'Commit Shame', text, url, files: [file] });
        return;
      }
      await navigator.share({ title: 'Commit Shame', text, url });
      return;
    } catch (e) { /* fall through */ }
  }
  await navigator.clipboard.writeText(`${text}\n\n${url}`);
  toast('copied — paste anywhere');
}

function copyPermalink() {
  navigator.clipboard.writeText(location.href);
  toast('permalink copied');
}

function buildShareText() {
  const { scored, commits, repo } = STATE;
  const totalShame = scored.reduce((a, c) => a + c.occurrences, 0);
  const avgScore = scored.length
    ? Math.round(scored.reduce((s, c) => s + c.score * c.occurrences, 0) / Math.max(1, totalShame)) : 0;
  const shameRate = commits.length > 0 ? Math.round((totalShame / commits.length) * 100) : 0;
  return `${repo} got a shame score of ${avgScore}/100 — ${totalShame} offense${totalShame===1?'':'s'} (${shameRate}% shame rate). verdict's in.`;
}

/* ─── typewriter ──────────────────────────────────────────────── */

let typewriterTimer = null;
const LOADING_LINES = [
  '> connecting to api.github.com…',
  '> requesting repo metadata…',
  '> fetching commit page %P/5…',
  '> matching signal "the keyboard smasher"…',
  '> matching signal "the one-word fix"…',
  '> matching signal "the desperate"…',
  '> running quality bonus pass…',
  '> detecting streaks…',
  '> tallying repeat offenders…',
  '> drafting verdict…',
];

function startTypewriter() {
  const el = $('typewriter');
  el.innerHTML = '';
  let i = 0;
  function next() {
    if (i >= LOADING_LINES.length) i = 0;
    el.querySelectorAll('.line').forEach(l => l.classList.remove('live'));
    const div = document.createElement('div');
    div.className = 'line live';
    div.textContent = LOADING_LINES[i].replace('%P', STATE._page || 1);
    el.appendChild(div);
    if (el.children.length > 8) el.removeChild(el.firstChild);
    i++;
    typewriterTimer = setTimeout(next, 380 + Math.random() * 220);
  }
  next();
}
function stopTypewriter() {
  if (typewriterTimer) clearTimeout(typewriterTimer);
  typewriterTimer = null;
}

/* ─── main ────────────────────────────────────────────────────── */

async function judge(repoInput, branchInput, fromURL = false) {
  const repo = parseRepo(repoInput);
  if (!repo) { showError('INVALID INPUT · use owner/repo or a github URL'); return; }
  const branch = (branchInput || '').trim() || null;

  STATE.repo = repo;
  STATE.branch = branch;
  STATE.scored = [];
  STATE.commits = [];
  STATE.sort = 'score';

  const errEl = $('error-msg');
  const loadEl = $('loading');
  const resEl = $('results');
  errEl.classList.remove('show');
  resEl.classList.remove('show');
  loadEl.classList.add('show');
  startTypewriter();
  $('shame-btn').disabled = true;

  if (!fromURL) writeURL(repo, branch);

  try {
    const repoInfoP = fetchRepoInfo(repo).catch(() => null);
    const commits = await fetchCommits(repo, branch, (p) => { STATE._page = p; });
    const repoInfo = await repoInfoP;

    const raw = [];
    for (const c of commits) {
      if (Array.isArray(c.parents) && c.parents.length >= 2) continue;
      const msg = c.commit?.message || '';
      const result = scoreMessage(msg);
      if (result) {
        raw.push({
          msg: msg.split('\n')[0],
          score: result.score,
          label: result.label,
          id: result.id,
          sha: c.sha,
          author: c.commit?.author?.name || c.author?.login || 'Unknown',
          date: c.commit?.author?.date,
          url: c.html_url,
          _date: c.commit?.author?.date,
        });
      }
    }
    const post = postProcess(raw);
    const display = dedupForDisplay(post);

    STATE.commits = commits;
    STATE.scored = display;
    STATE.repoInfo = repoInfo;

    pushRecent(repo);
    stopTypewriter();
    loadEl.classList.remove('show');
    render();
    window.scrollTo({ top: $('results').offsetTop - 24, behavior: 'smooth' });
  } catch (err) {
    stopTypewriter();
    loadEl.classList.remove('show');
    showError(err.message || 'UNKNOWN ERROR');
  } finally {
    $('shame-btn').disabled = false;
  }
}

function showError(msg) {
  const errEl = $('error-msg');
  errEl.textContent = msg;
  errEl.classList.add('show');
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ─── events ──────────────────────────────────────────────────── */

$('judge-form').addEventListener('submit', e => {
  e.preventDefault();
  judge($('repo-input').value, $('branch-input').value);
});

document.querySelectorAll('.examples .chip').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    const repo = el.dataset.repo;
    $('repo-input').value = repo;
    judge(repo, $('branch-input').value);
  });
});

$('recent-chips').addEventListener('click', e => {
  const x = e.target.closest('[data-remove]');
  if (x) {
    e.preventDefault();
    e.stopPropagation();
    removeRecent(x.dataset.remove);
    return;
  }
  const chip = e.target.closest('[data-repo]');
  if (chip) {
    e.preventDefault();
    const repo = chip.dataset.repo;
    $('repo-input').value = repo;
    judge(repo, $('branch-input').value);
  }
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    $('repo-input').focus();
    $('repo-input').select();
  }
  if (e.key === 'Escape') $('repo-input').blur();
});

window.addEventListener('popstate', () => {
  const url = readURL();
  if (url.repo) {
    $('repo-input').value = url.repo;
    $('branch-input').value = url.branch || '';
    judge(url.repo, url.branch, true);
  } else {
    $('results').classList.remove('show');
    $('repo-input').value = '';
  }
});

/* ─── init ────────────────────────────────────────────────────── */

(async function init() {
  renderRecent();

  // probe quota once on load (cheap & shows current pool state)
  fetch('/api/health').then(r => r.json()).then(j => {
    if (j.hasToken === false && STATE.poolRemaining === null) {
      $('quota-meta').textContent = 'no token configured · 60 req/hr total';
      $('quota-meta').style.color = 'var(--red)';
    }
  }).catch(() => {});

  const url = readURL();
  if (url.repo) {
    $('repo-input').value = url.repo;
    if (url.branch) $('branch-input').value = url.branch;
    judge(url.repo, url.branch, true);
  } else {
    setTimeout(() => $('repo-input').focus(), 100);
  }
})();
