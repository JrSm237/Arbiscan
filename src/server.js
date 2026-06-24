require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const ccxt    = require('ccxt');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── CONFIG ──────────────────────────────────────────────────────────────────
// 10 exchanges publics — pas de clé API requise
const EXCHANGE_IDS = [
  'binance', 'bybit', 'okx', 'kraken', 'kucoin',
  'gate', 'mexc', 'bitget', 'htx', 'coinbaseadvanced'
];

// Paires à surveiller — 30 paires (USDT + BTC + ETH)
const SPOT_PAIRS = [
  // Top caps USDT
  'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT',
  'XRP/USDT', 'ADA/USDT', 'DOGE/USDT', 'AVAX/USDT',
  'MATIC/USDT', 'LINK/USDT', 'DOT/USDT', 'LTC/USDT',
  'TRX/USDT', 'SHIB/USDT', 'TON/USDT', 'UNI/USDT',
  'ATOM/USDT', 'XLM/USDT', 'BCH/USDT', 'NEAR/USDT',
  'APT/USDT', 'ARB/USDT', 'OP/USDT', 'FIL/USDT',
  'HBAR/USDT', 'VET/USDT', 'ALGO/USDT', 'ICP/USDT',
  // Paires BTC
  'ETH/BTC', 'SOL/BTC',
];

// Cache instances exchange
const exchangeInstances = {};

function getExchange(id) {
  if (!exchangeInstances[id]) {
    try {
      exchangeInstances[id] = new ccxt[id]({
        timeout: 10000,
        enableRateLimit: true,
      });
    } catch {
      return null;
    }
  }
  return exchangeInstances[id];
}

// ── FETCH TICKER AVEC TIMEOUT ────────────────────────────────────────────────
async function fetchTickerSafe(exchangeId, symbol) {
  try {
    const ex = getExchange(exchangeId);
    if (!ex) return null;

    // Vérifier que la paire est supportée
    await ex.loadMarkets().catch(() => {});
    if (ex.markets && !ex.markets[symbol]) return null;

    const ticker = await ex.fetchTicker(symbol);
    if (!ticker || (!ticker.last && !ticker.bid && !ticker.ask)) return null;

    return {
      exchange: exchangeId,
      symbol,
      bid:    ticker.bid    || ticker.last,
      ask:    ticker.ask    || ticker.last,
      last:   ticker.last,
      volume: ticker.baseVolume || 0,
      ts:     ticker.timestamp || Date.now(),
    };
  } catch {
    return null;
  }
}

// ── FETCH TOUS LES EXCHANGES POUR UNE PAIRE ──────────────────────────────────
async function fetchAllExchanges(symbol, exchangeIds) {
  const results = await Promise.allSettled(
    exchangeIds.map(id => fetchTickerSafe(id, symbol))
  );
  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
}

// ── CALCUL DES OPPORTUNITÉS D'ARBITRAGE ──────────────────────────────────────
function findArbitrageOpportunities(tickers, minSpreadPct = 0.05, capital = 1000) {
  const opportunities = [];

  for (let i = 0; i < tickers.length; i++) {
    for (let j = 0; j < tickers.length; j++) {
      if (i === j) continue;
      const buyer  = tickers[i];
      const seller = tickers[j];

      const buyPrice  = buyer.ask  || buyer.last;
      const sellPrice = seller.bid || seller.last;

      if (!buyPrice || !sellPrice) continue;

      const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
      if (spreadPct < 0.05) continue;

      // Frais réalistes : 0.1% par leg sur la plupart des exchanges
      const feePct      = 0.2;
      const netSpread   = spreadPct - feePct;
      const units       = capital / buyPrice;
      const grossProfit = units * (sellPrice - buyPrice);
      const fees        = capital * (feePct / 100);
      const netProfit   = grossProfit - fees;

      // Fiabilité : on pénalise si le volume est faible
      const minVolume  = Math.min(buyer.volume || 0, seller.volume || 0);
      const volScore   = Math.min(20, minVolume > 0 ? Math.log10(minVolume) * 5 : 0);
      const confidence = Math.min(95, Math.round(45 + Math.min(30, spreadPct * 8) + volScore));

      const windowSec = Math.max(10, Math.round(90 - spreadPct * 15));
      const risk = spreadPct > 3 ? 'high' : spreadPct > 1.5 ? 'medium' : 'low';

      opportunities.push({
        symbol:       buyer.symbol,
        buyExchange:  buyer.exchange,
        sellExchange: seller.exchange,
        buyPrice,
        sellPrice,
        spreadPct:    parseFloat(spreadPct.toFixed(3)),
        netSpreadPct: parseFloat(netSpread.toFixed(3)),
        grossProfit:  parseFloat(grossProfit.toFixed(2)),
        feesUSDT:     parseFloat(fees.toFixed(2)),
        netProfit:    parseFloat(netProfit.toFixed(2)),
        confidence,
        windowSec,
        risk,
        capital,
        timestamp: Date.now(),
      });
    }
  }

  return opportunities.sort((a, b) => b.netProfit - a.netProfit);
}

// ── HISTORIQUE PRIX (pour graphiques) ────────────────────────────────────────
// Stocke les derniers prix en mémoire (ring buffer de 60 points)
const priceHistory = new Map(); // symbol -> [{ ts, prices: {exchange: price} }]
const HISTORY_MAX  = 60;

function recordPrices(symbol, tickers) {
  if (!priceHistory.has(symbol)) priceHistory.set(symbol, []);
  const hist = priceHistory.get(symbol);
  const point = {
    ts: Date.now(),
    prices: {},
  };
  for (const t of tickers) {
    point.prices[t.exchange] = t.last || t.bid || t.ask;
  }
  hist.push(point);
  if (hist.length > HISTORY_MAX) hist.shift();
}

// ── CACHE DES PRIX (TTL 10s) ─────────────────────────────────────────────────
const priceCache = new Map();
const CACHE_TTL  = 10_000;

async function getPrices(symbol, exchangeIds) {
  const key = `${symbol}:${exchangeIds.sort().join(',')}`;
  const hit  = priceCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  const data = await fetchAllExchanges(symbol, exchangeIds);
  priceCache.set(key, { data, ts: Date.now() });
  recordPrices(symbol, data); // enregistre pour le graphique
  return data;
}

// ── ROUTES API ───────────────────────────────────────────────────────────────

// GET /api/exchanges
app.get('/api/exchanges', (req, res) => {
  res.json({ exchanges: EXCHANGE_IDS, pairs: SPOT_PAIRS });
});

// GET /api/ticker?symbol=BTC/USDT
app.get('/api/ticker', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol requis' });
  const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
  res.json({ symbol, tickers });
});

// GET /api/prices?symbol=BTC/USDT — prix live par exchange
app.get('/api/prices', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;
  const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
  res.json({ symbol, tickers, ts: Date.now() });
});

// GET /api/history?symbol=BTC/USDT — historique pour graphique
app.get('/api/history', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;

  // Si pas encore d'historique, on fetch maintenant
  if (!priceHistory.has(symbol) || priceHistory.get(symbol).length < 2) {
    const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
    recordPrices(symbol, tickers);
  }

  const hist = priceHistory.get(symbol) || [];
  res.json({ symbol, history: hist });
});

// POST /api/scan
app.post('/api/scan', async (req, res) => {
  const {
    minSpread = 0.05,
    capital   = 1000,
    pairs     = SPOT_PAIRS.slice(0, 6),
    exchanges = EXCHANGE_IDS,
  } = req.body;

  const t0 = Date.now();
  try {
    const allOpportunities = [];

    const pairResults = await Promise.allSettled(
      pairs.map(async (symbol) => {
        const tickers = await getPrices(symbol, exchanges);
        return findArbitrageOpportunities(tickers, parseFloat(minSpread), parseFloat(capital));
      })
    );

    for (const r of pairResults) {
      if (r.status === 'fulfilled') allOpportunities.push(...r.value);
    }

    allOpportunities.sort((a, b) => b.netProfit - a.netProfit);

    const stats = {
      scannedPairs:     pairs.length,
      scannedExchanges: exchanges.length,
      totalSignals:     allOpportunities.length,
      bestSpread:       allOpportunities[0]?.spreadPct ?? 0,
      bestPair:         allOpportunities[0]?.symbol ?? '—',
      bestRoute:        allOpportunities[0]
        ? `${allOpportunities[0].buyExchange} → ${allOpportunities[0].sellExchange}` : '—',
      totalNetProfit:   allOpportunities.reduce((s, o) => s + o.netProfit, 0).toFixed(2),
      scanDurationMs:   Date.now() - t0,
    };

    res.json({ opportunities: allOpportunities.slice(0, 25), stats });
  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟢 ArbiScan running → http://localhost:${PORT}`);
  console.log(`   Exchanges : ${EXCHANGE_IDS.join(', ')}`);
  console.log(`   Paires    : ${SPOT_PAIRS.length} paires surveillées\n`);
});
