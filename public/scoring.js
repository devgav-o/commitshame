// Commit Shame — scoring engine v3
// Pure functions. No DOM, no fetch.
// Pipeline: ALWAYS_EXCLUDE / AUTO_GENERATED / CONVENTIONAL_COMMIT / VERSION_TAG / DESCRIPTIVE_REVERT
// → SHAME_SIGNALS (highest score wins)
// → qualityBonus (subtracts up to 50)
// → threshold (drop anything < 55)
// → postProcess (late-night, streak, repeat-offender)
// → dedupForDisplay (collapse adjacent identical msgs into one row)

const ALWAYS_EXCLUDE = [
  /^(merge pull request|merge branch|merge remote)/i,
  /^revert ".*"$/i,
  /^bump version/i,
  /^release\s+v?\d/i,
  /^chore\(release\)/i,
  /^\[skip ci\]/i,
  /^(co-authored-by:|signed-off-by:)/i,
  /^initial commit$/i,
  /^first commit$/i,
];

const AUTO_GENERATED = [
  /^merge (branch|tag|pull request|remote-tracking)/i,
  /^merged? in .+ \(pull request/i,
  /^auto[\s-]?(merge|commit|format|fix|generated)/i,
  /^(dependabot|renovate|greenkeeper|snyk)\[bot\]/i,
  /^\[automated\]/i,
  /^update (lockfile|yarn\.lock|package-lock)/i,
];

const CONVENTIONAL_COMMIT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?: .{5,}/i;
const VERSION_TAG = /^v?\d+\.\d+(\.\d+)?(-\w+)?(\s|$)/;
const DESCRIPTIVE_REVERT = /^revert .{10,}/i;

const EMOJI_RUN = /(\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*)+/gu;

function isAllEmoji(str) {
  return str.replace(EMOJI_RUN, '').replace(/\s/g, '').length === 0;
}
function emojiCount(str) {
  return (str.match(EMOJI_RUN) || []).length;
}

const SHAME_SIGNALS = [
  { id: 'keyboard_smash', label: 'the keyboard smasher', score: 97,
    test: m => /^(a+s+d+f*|q+w+e+r*|z+x+c+v*|h+j+k+l*|f+g+h*|a{2,}|b{2,}|c{3,}|x{2,}|z{2,}|j{2,})[!.]*$/i.test(m)
      || /^(.)\1{3,}$/.test(m) },
  { id: 'punctuation_only', label: 'the cryptic punctuator', score: 95,
    test: m => /^[^a-z0-9\s]{1,6}$/i.test(m) && m.trim().length > 0 && !isAllEmoji(m) },
  { id: 'single_char', label: 'the minimalist', score: 93,
    test: m => m.trim().length === 1 && !/\p{Extended_Pictographic}/u.test(m) },

  { id: 'existential', label: 'the existential developer', score: 96,
    test: m => /\b(i hate (this|everything|my life|programming|js|css|react|python|php|java|this job))\b/i.test(m)
      || /\b(why does (this|it|nothing|everything) (exist|work|happen|break))\b/i.test(m)
      || /\b(i (want|need) to (die|quit|cry|scream)\b)/i.test(m) },
  { id: 'please_work', label: 'the desperate', score: 94,
    test: m => /\b(please\s+work|pls\s+work|just\s+work(ing)?|why won'?t (it|this|you) work|make it work)\b/i.test(m)
      || /\bplease\b.*\bgod\b/i.test(m)
      || /\bgod\s*(please|why|damn|help|no)\b/i.test(m) },
  { id: 'profanity_pure', label: 'the honest one', score: 91,
    test: m => {
      const clean = m.replace(/[^a-z\s]/gi, '').trim();
      return /^(fuck+|shit+|damn+|crap+|hell+|ass+|bitch+|wtf+|ffs+|omfg+|fml)\s*[\w\s]{0,12}$/i.test(clean)
        && clean.split(/\s+/).length <= 4;
    } },
  { id: 'keyboard_emotion', label: 'the emotionally unavailable', score: 88,
    test: m => /^(ugh+|argh+|uggh+|augh+|fuuu+|nooo+|whyy+|aaah+)[!.?]*$/i.test(m.trim()) },

  { id: 'conflict_panic', label: 'the conflict survivor', score: 78,
    test: m => /^(merge conflict[s]?|resolve conflict[s]?|fix(ed)?\s+conflict[s]?)[!.\s]*$/i.test(m.trim()) },

  { id: 'bare_fix', label: 'the one-word fix', score: 87,
    test: m => /^(fix|fixes|fixed|bugfix|hotfix|patch|patches|patched)[!.]*$/i.test(m.trim()) },
  { id: 'bare_wip', label: 'the quitter', score: 85,
    test: m => /^(wip|wip\.?|w\.i\.p\.?|work[\s-]in[\s-]progress)[!.]*$/i.test(m.trim()) },
  { id: 'bare_update', label: 'the vague updater', score: 80,
    test: m => /^(update[ds]?|updates?|updating)[!.]*$/i.test(m.trim()) },
  { id: 'bare_change', label: 'the vague changer', score: 76,
    test: m => /^(change[ds]?|changes?|changing)[!.]*$/i.test(m.trim()) },
  { id: 'bare_add', label: 'the adder', score: 74,
    test: m => /^(add(s|ed|ing)?)[!.]*$/i.test(m.trim()) },
  { id: 'bare_test', label: 'the tester', score: 72,
    test: m => /^(tests?|testing|test\.)[!.]*$/i.test(m.trim()) },
  { id: 'bare_misc', label: 'the philosopher', score: 76,
    test: m => /^(misc|miscellaneous|stuff|things|etc|random|various|other)[!.]*$/i.test(m.trim()) },
  { id: 'bare_temp', label: 'the procrastinator', score: 82,
    test: m => /^(temp(orary)?|tmp|hack|hacky|quick hack|dirty hack)[!.]*$/i.test(m.trim()) },
  { id: 'bare_refactor', label: 'the half-baker', score: 70,
    test: m => /^(refactor(ed|ing|s)?|cleanup|clean[\s-]up|tidy(ing)?|polish(ing)?)[!.]*$/i.test(m.trim()) },

  { id: 'ultra_short', label: 'the brevity champion', score: 85,
    test: m => {
      const t = m.trim();
      if (t.length > 4) return false;
      if (VERSION_TAG.test(t)) return false;
      if (/^v?\d/i.test(t)) return false;
      if (/\p{Extended_Pictographic}/u.test(t)) return false;
      return true;
    } },
  { id: 'very_short', label: 'the mumbler', score: 68,
    test: m => {
      const t = m.trim();
      return t.length >= 5 && t.length <= 8
        && !VERSION_TAG.test(t)
        && !/^v?\d/i.test(t)
        && !/^(fix|feat|docs|test|chore|refactor|style|perf|build|ci):/i.test(t)
        && !/\p{Extended_Pictographic}/u.test(t);
    } },

  { id: 'final_liar', label: 'the liar', score: 88,
    test: m => {
      const t = m.trim();
      return t.length <= 40
        && /\b(final|last|ultimate|definitive|really)\b/i.test(t)
        && /\b(fix|version|attempt|try|update|change|v\d)\b/i.test(t);
    } },
  { id: 'numbered_attempt', label: 'the persistent', score: 90,
    test: m => /\b(\d{1,2}(st|nd|rd|th)\s+attempt|\battempt\s+#?\d+|try\s+#?\d+|\bv\d+\s+fix|\bfix\s+\d+)\b/i.test(m) },
  { id: 'fix_fix', label: 'the fix-fixer', score: 82,
    test: m => {
      const fixes = (m.match(/\bfix(es|ed)?\b/gi) || []).length;
      return fixes >= 2 && m.trim().length <= 60;
    } },

  { id: 'copy_paste', label: 'the copy-paster', score: 86,
    test: m => /\b(copy|paste|copy[\s-]paste|ctrl[\s-]c|ctrl[\s-]v|duplicate|copied from|same as before)\b/i.test(m) },
  { id: 'oops', label: 'the apologizer', score: 83,
    test: m => /^(oops+|ooops+|oopsie|whoops+|my bad|mb|sorry|sry)[!.?]*(\s|$)/i.test(m.trim()) },

  { id: 'question_commit', label: 'the confused', score: 79,
    test: m => {
      const t = m.trim();
      return t.endsWith('?') && t.length <= 25;
    } },
  { id: 'todo_commit', label: 'the deferrer', score: 77,
    test: m => /^(todo|to[\s-]do|fix[\s-]?later|fix this later|come back|revisit|cleanup later|refactor later|hack|fixme)[!.]*$/i.test(m.trim()) },
  { id: 'bare_done', label: 'the finisher', score: 73,
    test: m => /^(done[!.]*|finished[!.]*|complete[!.]*|working[!.]*|it works[!.]*|works[!.]*)$/i.test(m.trim()) },
  { id: 'idk', label: 'the lost', score: 81,
    test: m => /^(idk|no idea|not sure|who knows|¯\\?\(ツ\)\/¯?)[!.?]*$/i.test(m.trim()) },

  { id: 'empty_ish', label: 'the void', score: 99,
    test: m => m.trim().length === 0 || /^[\s\.\-_,;:!?]+$/.test(m) },
  { id: 'all_caps_short', label: 'the screamer', score: 78,
    test: m => {
      const t = m.trim();
      return t === t.toUpperCase() && /[A-Z]{3,}/.test(t) && t.length <= 20
        && !/^(wip|fix|feat|docs|test|chore|refactor|ci|build)$/i.test(t);
    } },
  { id: 'ellipsis_only', label: 'the unfinished', score: 84,
    test: m => /^\.{2,}$/.test(m.trim()) },

  { id: 'emoji_soup', label: 'the emoji enthusiast', score: 62,
    test: m => emojiCount(m) >= 4 && m.replace(EMOJI_RUN, '').replace(/[^a-z0-9]/gi, '').length <= 4 },
];

function qualityBonus(fullMsg, firstLine) {
  let bonus = 0;
  const msg = firstLine;
  if (/\w+:\s+\w/.test(msg)) bonus += 15;
  if (/#\d+|gh-\d+|jira-\d+|closes\s+#/i.test(fullMsg)) bonus += 20;
  const words = msg.trim().split(/\s+/);
  if (words.length >= 5) bonus += 10;
  if (words.length >= 8) bonus += 10;
  if (/[.)]$/.test(msg.trim())) bonus += 5;
  if (/\(.+\)/.test(msg)) bonus += 8;
  if (/Co-authored-by:|Signed-off-by:/i.test(fullMsg)) bonus += 5;
  if (emojiCount(msg) >= 1 && emojiCount(msg) <= 2 && !isAllEmoji(msg) && msg.trim().length >= 8) bonus += 12;
  return Math.min(bonus, 50);
}

export function scoreMessage(fullMsg) {
  if (!fullMsg) return null;
  const firstLine = fullMsg.split('\n')[0];
  const trimmed = firstLine.trim();
  if (!trimmed) return null;

  for (const p of ALWAYS_EXCLUDE) if (p.test(trimmed)) return null;
  for (const p of AUTO_GENERATED) if (p.test(trimmed)) return null;
  if (CONVENTIONAL_COMMIT.test(trimmed)) return null;
  if (VERSION_TAG.test(trimmed) && trimmed.length <= 15) return null;
  if (DESCRIPTIVE_REVERT.test(trimmed)) return null;

  if (emojiCount(trimmed) >= 1
      && trimmed.replace(EMOJI_RUN, '').replace(/[^a-z0-9]/gi, '').length <= 1
      && trimmed.length <= 6) return null;

  let best = null;
  for (const sig of SHAME_SIGNALS) {
    if (sig.test(trimmed)) {
      if (!best || sig.score > best.score) best = { score: sig.score, label: sig.label, id: sig.id };
    }
  }
  if (!best) return null;

  const bonus = qualityBonus(fullMsg, trimmed);
  const finalScore = Math.max(10, best.score - bonus);
  if (finalScore < 55) return null;

  return { score: finalScore, label: best.label, id: best.id };
}

const norm = (s) => s.trim().toLowerCase().replace(/[!.\s]+$/, '');

export function postProcess(scored) {
  // late-night by timestamp (rough — UTC 1-5am)
  for (const item of scored) {
    if (!item._date) continue;
    const d = new Date(item._date);
    const h = d.getUTCHours();
    if (h >= 1 && h < 5 && item.msg.trim().length <= 50 && item.score < 80) {
      item.score = Math.min(95, item.score + 8);
      if (!item.label.includes('night owl')) item.label = item.label + ' · night owl';
    }
  }

  // streak — same normalized msg N+ in a row from same author
  let i = 0;
  while (i < scored.length) {
    let j = i;
    while (j < scored.length
      && norm(scored[j].msg) === norm(scored[i].msg)
      && scored[j].author === scored[i].author) j++;
    const streak = j - i;
    if (streak >= 3) {
      for (let k = i; k < j; k++) {
        scored[k].score = Math.min(99, scored[k].score + 12);
        scored[k].label = 'the spam committer';
      }
    }
    i = j;
  }

  // repeat-offender — same normalized msg N+ anywhere in window
  const counts = {};
  for (const c of scored) {
    const k = norm(c.msg);
    counts[k] = (counts[k] || 0) + 1;
  }
  for (const c of scored) {
    const k = norm(c.msg);
    if (counts[k] >= 4) c.score = Math.min(99, c.score + 8);
    c.repeat = counts[k];
  }

  return scored;
}

export function dedupForDisplay(scored) {
  const out = [];
  let i = 0;
  while (i < scored.length) {
    let j = i;
    while (j < scored.length
      && norm(scored[j].msg) === norm(scored[i].msg)
      && scored[j].author === scored[i].author) j++;
    out.push({ ...scored[i], occurrences: j - i, _shas: scored.slice(i, j).map(c => c.sha) });
    i = j;
  }
  return out;
}

export function getVerdict(avgScore, shameRate, totalShame) {
  if (totalShame === 0) return {
    title: 'CASE DISMISSED', sub: 'INSUFFICIENT EVIDENCE',
    text: `No shameful commits detected. Either this developer is meticulous, or they know how to rewrite history. We're watching you.`,
  };
  if (avgScore >= 88 || shameRate >= 40) return {
    title: 'GUILTY', sub: 'LEGENDARY SHAME',
    text: `A masterpiece of chaos. Future archaeologists will study these commits as a warning to the children.`,
  };
  if (avgScore >= 78 || shameRate >= 25) return {
    title: 'GUILTY', sub: 'DEEPLY SHAMEFUL',
    text: `Someone needs a talking-to about commit hygiene. Or therapy. Possibly both. Definitely both.`,
  };
  if (avgScore >= 68 || shameRate >= 12) return {
    title: 'GUILTY', sub: 'QUESTIONABLE CHOICES',
    text: `We've seen worse. But not much worse. The red flags are there if you look. And we looked.`,
  };
  if (avgScore >= 58 || shameRate >= 5) return {
    title: 'GUILTY', sub: 'A FEW SKELETONS',
    text: `Mostly fine, but there are some choices buried in that history that the author would prefer you didn't see.`,
  };
  return {
    title: 'GUILTY', sub: 'MOSTLY DECENT',
    text: `Surprisingly responsible commit history. Are you even a real developer?`,
  };
}
