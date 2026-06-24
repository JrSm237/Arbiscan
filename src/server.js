require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const ccxt    = require('ccxt');
const { ALL_PAIRS, TIER1, getPrioritizedPairs, boostPair } = require('./pairs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── CONFIG ──────────────────────────────────────────────────────────────────
const EXCHANGE_IDS = [
  'binance', 'bybit', 'okx', 'kraken', 'kucoin',
  'gate', 'mexc', 'bitget', 'htx', 'coinbaseadvanced'
];

// Taille d'une vague de scan parallèle
const WAVE_SIZE     = 40;
// Délai entre vagues (ms) pour éviter le rate-limiting
const WAVE_DELAY_MS = 200;

// Cache instances exchange
const exchangeInstances = {};

function getExchange(id) {
  if (!exchangeInstances[id]) {
    try {
      exchangeInstances[id] = new ccxt[id]({ timeout: 10000, enableRateLimit: true });
    } catch { return null; }
  }
  return exchangeInstances[id];
}

// ── FETCH TICKER ─────────────────────────────────────────────────────────────
async function fetchTickerSafe(exchangeId, symbol) {
  try {
    const ex = getExchange(exchangeId);
    if (!ex) return null;
    const ticker = await ex.fetchTicker(symbol);
    if (!ticker || (!ticker.last && !ticker.bid && !ticker.ask)) return null;
    return {
      exchange: exchangeId, symbol,
      bid:    ticker.bid    || ticker.last,
      ask:    ticker.ask    || ticker.last,
      last:   ticker.last,
      volume: ticker.baseVolume || 0,
    };
  } catch { return null; }
}

async function fetchAllExchanges(symbol, exchangeIds) {
  const results = await Promise.allSettled(
    exchangeIds.map(id => fetchTickerSafe(id, symbol))
  );
  return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
}

// ── CALCUL ARBITRAGE ─────────────────────────────────────────────────────────
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
      if (spreadPct < minSpreadPct) continue;

      const feePct      = 0.2;
      const netSpread   = spreadPct - feePct;
      const units       = capital / buyPrice;
      const grossProfit = units * (sellPrice - buyPrice);
      const fees        = capital * (feePct / 100);
      const netProfit   = grossProfit - fees;

      const minVolume  = Math.min(buyer.volume || 0, seller.volume || 0);
      const volScore   = Math.min(20, minVolume > 0 ? Math.log10(minVolume + 1) * 4 : 0);
      const confidence = Math.min(95, Math.round(45 + Math.min(30, spreadPct * 8) + volScore));
      const windowSec  = Math.max(10, Math.round(90 - spreadPct * 15));
      const risk       = spreadPct > 3 ? 'high' : spreadPct > 1.5 ? 'medium' : 'low';

      // Booster la priorité de cette paire pour les prochains scans
      boostPair(buyer.symbol, spreadPct);

      opportunities.push({
        symbol: buyer.symbol, buyExchange: buyer.exchange, sellExchange: seller.exchange,
        buyPrice, sellPrice,
        spreadPct: parseFloat(spreadPct.toFixed(3)),
        netSpreadPct: parseFloat(netSpread.toFixed(3)),
        grossProfit: parseFloat(grossProfit.toFixed(2)),
        feesUSDT: parseFloat(fees.toFixed(2)),
        netProfit: parseFloat(netProfit.toFixed(2)),
        confidence, windowSec, risk, capital, timestamp: Date.now(),
      });
    }
  }
  return opportunities.sort((a, b) => b.netProfit - a.netProfit);
}

// ── CACHE PRIX (TTL 10s) ─────────────────────────────────────────────────────
const priceCache = new Map();
const CACHE_TTL  = 10_000;

async function getPrices(symbol, exchangeIds) {
  const key = `${symbol}:${[...exchangeIds].sort().join(',')}`;
  const hit  = priceCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  const data = await fetchAllExchanges(symbol, exchangeIds);
  if (data.length) priceCache.set(key, { data, ts: Date.now() });
  return data;
}

// ── HISTORIQUE PRIX (pour graphiques) ────────────────────────────────────────
const priceHistory = new Map();
const HISTORY_MAX  = 60;

function recordPrices(symbol, tickers) {
  if (!priceHistory.has(symbol)) priceHistory.set(symbol, []);
  const hist  = priceHistory.get(symbol);
  const point = { ts: Date.now(), prices: {} };
  for (const t of tickers) point.prices[t.exchange] = t.last || t.bid || t.ask;
  hist.push(point);
  if (hist.length > HISTORY_MAX) hist.shift();
}

// ── SCAN EN VAGUES ───────────────────────────────────────────────────────────
async function scanInWaves(pairs, exchanges, minSpread, capital, onWaveResult) {
  const allOpportunities = [];

  for (let i = 0; i < pairs.length; i += WAVE_SIZE) {
    const wave = pairs.slice(i, i + WAVE_SIZE);

    const waveResults = await Promise.allSettled(
      wave.map(async (symbol) => {
        const tickers = await getPrices(symbol, exchanges);
        if (tickers.length) recordPrices(symbol, tickers);
        return findArbitrageOpportunities(tickers, minSpread, capital);
      })
    );

    const waveOpps = [];
    for (const r of waveResults) {
      if (r.status === 'fulfilled') waveOpps.push(...r.value);
    }

    waveOpps.sort((a, b) => b.netProfit - a.netProfit);
    allOpportunities.push(...waveOpps);

    // Callback pour streaming si nécessaire
    if (onWaveResult) onWaveResult(waveOpps, i + WAVE_SIZE);

    // Pause entre vagues
    if (i + WAVE_SIZE < pairs.length) {
      await new Promise(r => setTimeout(r, WAVE_DELAY_MS));
    }
  }

  return allOpportunities;
}

// ── ROUTES API ───────────────────────────────────────────────────────────────

app.get('/api/exchanges', (req, res) => {
  res.json({
    exchanges: EXCHANGE_IDS,
    totalPairs: ALL_PAIRS.length,
    tier1Pairs: TIER1,
  });
});

app.get('/api/ticker', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol requis' });
  const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
  res.json({ symbol, tickers });
});

app.get('/api/prices', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;
  const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
  recordPrices(symbol, tickers);
  res.json({ symbol, tickers, ts: Date.now() });
});

app.get('/api/history', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;
  if (!priceHistory.has(symbol) || priceHistory.get(symbol).length < 2) {
    const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
    recordPrices(symbol, tickers);
  }
  res.json({ symbol, history: priceHistory.get(symbol) || [] });
});

// POST /api/scan — scan rapide (paires prioritaires)
app.post('/api/scan', async (req, res) => {
  const {
    minSpread = 0.05,
    capital   = 1000,
    pairLimit = 30,
    exchanges = EXCHANGE_IDS,
    usePriority = true,
  } = req.body;

  const t0 = Date.now();
  try {
    // Choisir les paires selon priorité ou tier1 par défaut
    const pairs = usePriority
      ? getPrioritizedPairs(parseInt(pairLimit))
      : TIER1.slice(0, parseInt(pairLimit));

    const allOpportunities = await scanInWaves(
      pairs, exchanges, parseFloat(minSpread), parseFloat(capital)
    );

    allOpportunities.sort((a, b) => b.netProfit - a.netProfit);

    const stats = {
      scannedPairs:     pairs.length,
      totalPairsAvailable: ALL_PAIRS.length,
      scannedExchanges: exchanges.length,
      totalSignals:     allOpportunities.length,
      bestSpread:       allOpportunities[0]?.spreadPct ?? 0,
      bestPair:         allOpportunities[0]?.symbol ?? '—',
      bestRoute:        allOpportunities[0]
        ? `${allOpportunities[0].buyExchange} → ${allOpportunities[0].sellExchange}` : '—',
      totalNetProfit:   allOpportunities.reduce((s, o) => s + o.netProfit, 0).toFixed(2),
      scanDurationMs:   Date.now() - t0,
    };

    res.json({ opportunities: allOpportunities.slice(0, 30), stats });
  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scan/full — scan complet de toutes les paires (peut prendre 2-5 min)
app.post('/api/scan/full', async (req, res) => {
  const {
    minSpread = 0.05,
    capital   = 1000,
    exchanges = EXCHANGE_IDS,
    maxPairs  = 200, // limiter pour Render gratuit
  } = req.body;

  const t0 = Date.now();
  try {
    const pairs = getPrioritizedPairs(parseInt(maxPairs));
    const allOpportunities = await scanInWaves(
      pairs, exchanges, parseFloat(minSpread), parseFloat(capital)
    );

    allOpportunities.sort((a, b) => b.netProfit - a.netProfit);

    res.json({
      opportunities: allOpportunities.slice(0, 50),
      stats: {
        scannedPairs:     pairs.length,
        totalPairsAvailable: ALL_PAIRS.length,
        scannedExchanges: exchanges.length,
        totalSignals:     allOpportunities.length,
        bestSpread:       allOpportunities[0]?.spreadPct ?? 0,
        bestPair:         allOpportunities[0]?.symbol ?? '—',
        totalNetProfit:   allOpportunities.reduce((s, o) => s + o.netProfit, 0).toFixed(2),
        scanDurationMs:   Date.now() - t0,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pairs — liste de toutes les paires disponibles
app.get('/api/pairs', (req, res) => {
  const { tier } = req.query;
  res.json({
    total: ALL_PAIRS.length,
    pairs: tier === '1' ? TIER1 : getPrioritizedPairs(),
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟢 ArbiScan running → http://localhost:${PORT}`);
  console.log(`   Exchanges    : ${EXCHANGE_IDS.length} exchanges`);
  console.log(`   Paires total : ${ALL_PAIRS.length} paires disponibles`);
  console.log(`   Scan rapide  : POST /api/scan`);
  console.log(`   Scan complet : POST /api/scan/full\n`);
});

