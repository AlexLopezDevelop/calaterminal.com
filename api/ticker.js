// Vercel Serverless Function — Real-time market ticker
// Fetches quotes from Yahoo Finance, caches for 60s, returns display-friendly format.

const SYMBOLS = [
  { display: 'SPX',     yahoo: '^GSPC' },
  { display: 'BTC',     yahoo: 'BTC-USD' },
  { display: 'ETH',     yahoo: 'ETH-USD' },
  { display: 'SOL',     yahoo: 'SOL-USD' },
  { display: 'EUR/USD', yahoo: 'EURUSD=X' },
  { display: 'GOLD',    yahoo: 'GC=F' },
  { display: 'VIX',     yahoo: '^VIX' },
  { display: 'AAPL',    yahoo: 'AAPL' },
  { display: 'NVDA',    yahoo: 'NVDA' },
  { display: 'TSLA',    yahoo: 'TSLA' },
];

// Hardcoded fallback — returned when Yahoo is unreachable and cache is empty
const FALLBACK_DATA = [
  { symbol: 'SPX',     price: 5842.31,  change: 0, up: true },
  { symbol: 'BTC',     price: 87412.50, change: 0, up: true },
  { symbol: 'ETH',     price: 3245.80,  change: 0, up: true },
  { symbol: 'SOL',     price: 142.30,   change: 0, up: true },
  { symbol: 'EUR/USD', price: 1.0842,   change: 0, up: true },
  { symbol: 'GOLD',    price: 2935.40,  change: 0, up: true },
  { symbol: 'VIX',     price: 14.52,    change: 0, up: false },
  { symbol: 'AAPL',    price: 227.50,   change: 0, up: true },
  { symbol: 'NVDA',    price: 117.80,   change: 0, up: true },
  { symbol: 'TSLA',    price: 272.10,   change: 0, up: true },
];

// Module-level cache (persists across warm invocations within a Vercel region)
let cache = null;       // { data: [...], timestamp: number }
let lastFetchTime = 0;  // epoch ms — prevents concurrent fetches (dedup)

const CACHE_TTL_MS = 60_000;
const FETCH_DEDUP_MS = 5_000;

const ALLOWED_ORIGINS = [
  'https://calaterminal.com',
  'https://www.calaterminal.com',
  'http://localhost:8889',
  'http://localhost:3000',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
  };
}

function round(num, decimals) {
  if (num == null || isNaN(num)) return 0;
  return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function smartRound(price) {
  if (price == null || isNaN(price)) return 0;
  if (price >= 1) return round(price, 2);
  return round(price, 4);
}

async function fetchFromYahoo() {
  const yahooSymbols = SYMBOLS.map((s) => s.yahoo).join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooSymbols)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CalaTerminal/1.0)',
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Yahoo API responded ${res.status}`);
    }

    const json = await res.json();
    const quotes = json?.quoteResponse?.result;

    if (!Array.isArray(quotes) || quotes.length === 0) {
      throw new Error('Yahoo returned empty quotes');
    }

    const quoteMap = {};
    for (const q of quotes) {
      quoteMap[q.symbol] = q;
    }

    return SYMBOLS.map((sym) => {
      const q = quoteMap[sym.yahoo];
      if (!q) {
        const fb = FALLBACK_DATA.find((f) => f.symbol === sym.display);
        return fb || { symbol: sym.display, price: 0, change: 0, up: true };
      }

      const price = q.regularMarketPrice ?? q.postMarketPrice ?? 0;
      const changePct = q.regularMarketChangePercent ?? 0;

      return {
        symbol: sym.display,
        price: smartRound(price),
        change: round(changePct, 2),
        up: changePct >= 0,
      };
    });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  const headers = corsHeaders(origin);

  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const now = Date.now();
  const cacheValid = cache && (now - cache.timestamp < CACHE_TTL_MS);

  if (cacheValid) {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    res.status(200).json({ data: cache.data, cached: true, timestamp: cache.timestamp });
    return;
  }

  const recentlyFetched = (now - lastFetchTime) < FETCH_DEDUP_MS;
  if (recentlyFetched && cache) {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    res.status(200).json({ data: cache.data, cached: true, stale: true, timestamp: cache.timestamp });
    return;
  }

  lastFetchTime = now;

  try {
    const data = await fetchFromYahoo();
    cache = { data, timestamp: now };

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    res.status(200).json({ data, cached: false, timestamp: now });
  } catch (err) {
    console.error('[ticker] Yahoo Finance fetch failed:', err.message);

    if (cache) {
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
      res.status(200).json({ data: cache.data, cached: true, stale: true, timestamp: cache.timestamp });
      return;
    }

    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ data: FALLBACK_DATA, cached: false, stale: true, timestamp: now });
  }
};
