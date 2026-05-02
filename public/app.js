import { scoreMessage, postProcess, dedupForDisplay, getVerdict } from './scoring.js';

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
  const weeks = Math.max(8, Math.min(20, Math.ceil((max - min) / (7 * 86400000))));
  const bucketMs = (max - min) / weeks;
  if (bucketMs <= 0) return null;
  const buckets = new Array(weeks).fill(0);
  for (const c of scored) {
    const t = new Date(c.date).getTime();
    if (isNaN(t)) continue;
    const idx = Math.min(weeks - 1, Math.floor((t - min) / bucketMs));
    buckets[idx] += c.occurrences;
  }
  const peak = Math.max(...buckets, 1);
  const blocks = '▁▂▃▄▅▆▇█';
  const bars = buckets.map(v => v === 0 ? ' ' : blocks[Math.min(blocks.length - 1, Math.floor((v / peak) * (blocks.length - 1)))]).join('');
  const fmt = ms => new Date(ms).toLocaleDateString([], { year: '2-digit', month: 'short' });
  return { bars, start: fmt(min), end: fmt(max) };
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
  const top = sortScored(scored, STATE.sort).slice(0, 18);
  const offenders = computeOffenders(scored);
  const timeline = computeTimeline(scored, commits);

  const dateNow = new Date();
  const dateStr = dateNow.toISOString().slice(0, 10);
  const timeStr = dateNow.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const html = `
    <div class="receipt fade-in" id="receipt-el">
      <div class="receipt-inner">
        <div class="r-title">★ ★ ★ Official Shame Receipt ★ ★ ★</div>
        <div class="r-subtitle">commit-shame · est. 2024</div>
        <div class="r-divider"></div>

        <div class="meta-rows">
          <div class="meta-row"><span class="k">repo</span><span class="v"><a href="https://github.com/${escapeAttr(repo)}" target="_blank" rel="noopener">${escapeHtml(repo)}</a></span></div>
          <div class="meta-row"><span class="k">branch</span><span class="v">${escapeHtml(branch || repoInfo?.default_branch || 'default')}</span></div>
          <div class="meta-row"><span class="k">analyzed</span><span class="v">${commits.length} commits</span></div>
          ${repoInfo?.language ? `<div class="meta-row"><span class="k">language</span><span class="v">${escapeHtml(repoInfo.language)}</span></div>` : ''}
          ${repoInfo?.stargazers_count != null ? `<div class="meta-row"><span class="k">stars</span><span class="v">${repoInfo.stargazers_count.toLocaleString()}</span></div>` : ''}
          <div class="meta-row"><span class="k">date</span><span class="v">${dateStr} · ${timeStr}</span></div>
        </div>

        <div class="r-divider thick"></div>

        <div class="verdict-block">
          <div class="verdict-stars">★ ★ ★</div>
          <div class="verdict-line">verdict</div>
          <div class="verdict-stamp">${escapeHtml(verdict.title)}</div>
          <div class="verdict-line" style="margin-top:14px;">${escapeHtml(verdict.sub)}</div>
          <div class="verdict-text">${escapeHtml(verdict.text)}</div>

          <div class="scores-row">
            <div class="score-item">
              <div class="score-num" data-count="${avgScore}">0<span class="of"> / 100</span></div>
              <div class="score-label">shame score</div>
            </div>
            <div class="score-item">
              <div class="score-num" data-count="${totalShame}">0</div>
              <div class="score-label">offenses</div>
            </div>
            <div class="score-item">
              <div class="score-num" data-count="${shameRate}">0<span class="of">%</span></div>
              <div class="score-label">shame rate</div>
            </div>
          </div>
        </div>

        <div class="r-divider thick"></div>

        <div class="itemized-head">itemized offenses</div>
        <div class="sort-bar" id="sort-bar">
          <span data-sort="score" class="${STATE.sort==='score'?'active':''}">▾ highest fine</span>
          <span data-sort="recent" class="${STATE.sort==='recent'?'active':''}">most recent</span>
          <span data-sort="repeats" class="${STATE.sort==='repeats'?'active':''}">most repeated</span>
        </div>

        ${top.length === 0 ? `
          <div style="text-align:center; padding:30px 0; color:var(--ink-3); font-size:13px;">
            no shameful commits found in this window. either meticulous or covering tracks.
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
              <span>${c.sha.slice(0, 7)}</span>
            </div>
          </a>
        `).join('')}

        ${offenders.length >= 3 ? `
          <div class="r-divider thick" style="margin-top:18px;"></div>
          <div class="itemized-head">repeat offenders</div>
          <div class="r-subtitle" style="margin: 4px 0 12px;">authors with most shame</div>
          <div class="offenders-block">
            ${offenders.slice(0, 6).map((o, i) => `
              <div class="offender-row">
                <span class="offender-rank">#${i+1}</span>
                <span class="offender-name">${escapeHtml(o.name)}</span>
                <span class="offender-stat">${o.count} offense${o.count===1?'':'s'} · avg <strong>¤${o.avg}</strong></span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${timeline ? `
          <div class="r-divider thick" style="margin-top:18px;"></div>
          <div class="itemized-head">shame timeline</div>
          <div class="r-subtitle" style="margin: 4px 0 8px;">offenses per week · oldest → newest</div>
          <div class="timeline-block">
            <div class="timeline-bars">${timeline.bars}</div>
            <div class="timeline-axis">
              <span>${timeline.start}</span>
              <span>${timeline.end}</span>
            </div>
          </div>
        ` : ''}

        <div class="r-divider thick" style="margin-top:18px;"></div>
        <div class="receipt-foot">
          thank you for your cooperation<br>
          commitshame · ${escapeHtml(repo)}<br>
          generated ${dateStr} · ${timeStr}
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
  const W = 1080;
  const PAD = 64;

  const { scored, commits, repo, branch, repoInfo } = STATE;
  const totalShame = scored.reduce((a, c) => a + c.occurrences, 0);
  const avgScore = scored.length
    ? Math.round(scored.reduce((s, c) => s + c.score * c.occurrences, 0) / Math.max(1, totalShame))
    : 0;
  const shameRate = commits.length > 0 ? Math.round((totalShame / commits.length) * 100) : 0;
  const verdict = getVerdict(avgScore, shameRate, totalShame);
  const top = sortScored(scored, 'score').slice(0, 8);

  const H = 220 + 280 + 140 + (top.length * 92) + 200;

  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // paint cream paper at the device-pixel surface, then add subtle grain
  // by reading existing pixels and nudging RGB (alpha stays 255).
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#f5f1e8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    d[i]   = Math.max(0, Math.min(255, d[i]   + n));
    d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
    d[i+2] = Math.max(0, Math.min(255, d[i+2] + n));
  }
  ctx.putImageData(img, 0, 0);
  ctx.restore();

  const FONT = "'IBM Plex Mono', 'Menlo', monospace";
  const STAMP_FONT = "'Special Elite', 'IBM Plex Mono', 'Menlo', monospace";
  const ink = '#1a1410';
  const ink2 = '#4a3f37';
  const ink3 = '#8a7d70';
  const red = '#c8302d';
  const rule = '#c9bfaf';

  let y = 80;

  drawTearStrip(ctx, 0, 0, W, 14, true);
  drawTearStrip(ctx, 0, H - 14, W, 14, false);

  ctx.fillStyle = ink;
  ctx.font = `700 22px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('★ ★ ★  OFFICIAL SHAME RECEIPT  ★ ★ ★', W/2, y);
  y += 30;
  ctx.font = `400 13px ${FONT}`;
  ctx.fillStyle = ink3;
  ctx.fillText('COMMIT-SHAME · EST. 2024', W/2, y);
  y += 28;
  drawDashedLine(ctx, PAD, y, W - PAD, y, rule);
  y += 26;

  ctx.font = `400 18px ${FONT}`;
  ctx.textAlign = 'left';
  const metaRows = [
    ['REPO', repo],
    ['BRANCH', branch || repoInfo?.default_branch || 'default'],
    ['ANALYZED', `${commits.length} commits`],
  ];
  if (repoInfo?.language) metaRows.push(['LANGUAGE', repoInfo.language]);
  if (repoInfo?.stargazers_count != null) metaRows.push(['STARS', repoInfo.stargazers_count.toLocaleString()]);
  metaRows.push(['DATE', new Date().toISOString().slice(0,10)]);

  for (const [k, v] of metaRows) {
    ctx.font = `400 13px ${FONT}`;
    ctx.fillStyle = ink3;
    ctx.fillText(k, PAD, y);
    ctx.font = `500 17px ${FONT}`;
    ctx.fillStyle = ink;
    ctx.textAlign = 'right';
    ctx.fillText(String(v), W - PAD, y);
    ctx.textAlign = 'left';
    y += 28;
  }

  y += 14;
  drawDashedLine(ctx, PAD, y, W - PAD, y, rule, 8);
  y += 6;
  drawDashedLine(ctx, PAD, y, W - PAD, y, rule, 8);
  y += 28;

  ctx.textAlign = 'center';
  ctx.fillStyle = ink3;
  ctx.font = `400 14px ${FONT}`;
  ctx.fillText('★ ★ ★', W/2, y); y += 18;
  ctx.fillText('VERDICT', W/2, y); y += 56;

  ctx.save();
  ctx.translate(W/2, y);
  ctx.rotate(-3 * Math.PI / 180);
  ctx.font = `700 64px ${STAMP_FONT}`;
  ctx.fillStyle = red;
  const stampText = verdict.title;
  const sw = ctx.measureText(stampText).width;
  const sh = 80;
  ctx.lineWidth = 3;
  ctx.strokeStyle = red;
  ctx.strokeRect(-sw/2 - 28, -sh/2 - 4, sw + 56, sh + 8);
  ctx.lineWidth = 1;
  ctx.strokeRect(-sw/2 - 22, -sh/2 + 2, sw + 44, sh - 4);
  ctx.fillText(stampText, 0, 22);
  ctx.restore();
  y += 56;

  ctx.fillStyle = ink3;
  ctx.font = `400 14px ${FONT}`;
  ctx.fillText(verdict.sub, W/2, y); y += 36;
  ctx.fillStyle = ink2;
  ctx.font = `400 16px ${FONT}`;
  wrapText(ctx, verdict.text, W/2, y, W - PAD*2 - 80, 22, 'center');
  y += 60;

  drawDashedLine(ctx, PAD, y, W - PAD, y, rule);
  y += 30;
  const scoreCols = [
    { num: avgScore + '', sub: '/100', label: 'SHAME SCORE' },
    { num: totalShame + '', sub: '', label: 'OFFENSES' },
    { num: shameRate + '', sub: '%', label: 'SHAME RATE' },
  ];
  const colW = (W - PAD * 2) / 3;
  for (let i = 0; i < scoreCols.length; i++) {
    const cx = PAD + colW * i + colW/2;
    ctx.fillStyle = ink;
    ctx.font = `700 44px ${FONT}`;
    ctx.textAlign = 'center';
    const numW = ctx.measureText(scoreCols[i].num).width;
    ctx.fillText(scoreCols[i].num, cx - (scoreCols[i].sub ? 8 : 0), y);
    if (scoreCols[i].sub) {
      ctx.fillStyle = ink3;
      ctx.font = `400 18px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(scoreCols[i].sub, cx + numW/2 - 4, y);
    }
    ctx.fillStyle = ink3;
    ctx.font = `400 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(scoreCols[i].label, cx, y + 22);
  }
  y += 56;

  drawDashedLine(ctx, PAD, y, W - PAD, y, rule);
  y += 6;
  drawDashedLine(ctx, PAD, y, W - PAD, y, rule);
  y += 30;

  ctx.fillStyle = ink;
  ctx.font = `700 14px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('ITEMIZED OFFENSES', PAD, y);
  y += 28;

  ctx.font = `500 18px ${FONT}`;
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const rank = `#${String(i+1).padStart(2,'0')}`;
    const fine = `¤${c.score}${c.occurrences > 1 ? '  ×' + c.occurrences : ''}`;
    const fineW = ctx.measureText(fine).width;
    ctx.fillStyle = ink;
    ctx.fillText(rank, PAD, y);
    const msgX = PAD + 56;
    const maxMsgW = W - PAD - msgX - fineW - 24;
    const msg = `"${truncate(c.msg, Math.floor(maxMsgW / 11))}"`;
    ctx.fillText(msg, msgX, y);
    ctx.fillStyle = red;
    ctx.font = `700 18px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(fine, W - PAD, y);
    ctx.textAlign = 'left';
    ctx.font = `500 18px ${FONT}`;
    y += 22;
    ctx.fillStyle = red;
    ctx.font = `600 12px ${FONT}`;
    ctx.fillText(c.label.toUpperCase(), msgX, y);
    ctx.fillStyle = ink3;
    ctx.font = `400 12px ${FONT}`;
    const labW = ctx.measureText(c.label.toUpperCase()).width;
    ctx.fillText(`· ${c.author}${c.date ? ' · ' + shortDate(c.date) : ''}`, msgX + labW + 6, y);
    y += 32;
    ctx.font = `500 18px ${FONT}`;
  }

  y += 8;
  drawDashedLine(ctx, PAD, y, W - PAD, y, rule);
  y += 30;

  ctx.fillStyle = ink3;
  ctx.font = `400 13px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('THANK YOU FOR YOUR COOPERATION', W/2, y); y += 22;
  ctx.fillStyle = ink;
  ctx.font = `700 14px ${FONT}`;
  ctx.fillText('COMMITSHAME', W/2, y); y += 24;
  ctx.fillStyle = ink3;
  ctx.font = `400 12px ${FONT}`;
  ctx.fillText(`https://github.com/${repo}`, W/2, y);

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
