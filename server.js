import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.GITHUB_TOKEN || '';
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR) || 60;

if (!TOKEN) {
  console.warn('⚠  GITHUB_TOKEN not set — proxy will use unauthenticated GitHub API (60 req/hr total).');
} else {
  console.log('✓  GitHub token loaded — pool of 5000 req/hr.');
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'TOO MANY REQUESTS · YOU ARE THROTTLED · COOL DOWN' },
});

const NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const isValidName = (s) => typeof s === 'string' && NAME_RE.test(s) && s.length <= 100;

async function proxyGitHub(url, res) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'commit-shame/0.3',
  };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  let upstream;
  try {
    upstream = await fetch(url, { headers });
  } catch (e) {
    return res.status(502).json({ error: 'UPSTREAM UNREACHABLE · TRY AGAIN' });
  }
  const remaining = upstream.headers.get('x-ratelimit-remaining');
  const reset = upstream.headers.get('x-ratelimit-reset');
  if (remaining !== null) res.setHeader('x-pool-remaining', remaining);
  if (reset !== null) res.setHeader('x-pool-reset', reset);
  const text = await upstream.text();
  res.status(upstream.status)
    .type('application/json')
    .send(text);
}

app.get('/api/repo/:owner/:repo', apiLimiter, async (req, res) => {
  const { owner, repo } = req.params;
  if (!isValidName(owner) || !isValidName(repo)) {
    return res.status(400).json({ error: 'INVALID INPUT' });
  }
  await proxyGitHub(`https://api.github.com/repos/${owner}/${repo}`, res);
});

app.get('/api/commits/:owner/:repo', apiLimiter, async (req, res) => {
  const { owner, repo } = req.params;
  if (!isValidName(owner) || !isValidName(repo)) {
    return res.status(400).json({ error: 'INVALID INPUT' });
  }
  const page = Math.max(1, Math.min(10, parseInt(req.query.page, 10) || 1));
  const params = new URLSearchParams();
  params.set('per_page', '100');
  params.set('page', String(page));
  if (req.query.branch && typeof req.query.branch === 'string') {
    params.set('sha', req.query.branch.slice(0, 200));
  }
  await proxyGitHub(
    `https://api.github.com/repos/${owner}/${repo}/commits?${params.toString()}`,
    res
  );
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasToken: Boolean(TOKEN), rateLimitPerHour: RATE_LIMIT });
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  etag: true,
  index: 'index.html',
}));

app.use((req, res) => res.status(404).type('text').send('not found'));

const server = app.listen(PORT, () => {
  console.log(`commit-shame listening on http://localhost:${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received — closing.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
