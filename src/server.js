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
// Exchanges publics (pas besoin de clé API pour les prix)
const EXCHANGE_IDS = ['binance', 'bybit', 'okx', 'kraken', 'kucoin', 'gate'];

// Paires à surveiller
const SPOT_PAIRS = [
  'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT',
  'XRP/USDT', 'ADA/USDT', 'DOGE/USDT', 'AVAX/USDT',
  'MATIC/USDT', 'LINK/USDT', 'DOT/USDT', 'LTC/USDT',
];

// Cache des instances exchange (réutilisées)
const exchangeInstances = {};

function getExchange(id) {
  if (!exchangeInstances[id]) {
    exchangeInstances[id] = new ccxt[id]({
      timeout: 8000,
      enableRateLimit: true,
    });
  }
  return exchangeInstances[id];
}

// ── FETCH TICKER AVEC TIMEOUT ────────────────────────────────────────────────
async function fetchTickerSafe(exchangeId, symbol) {
  try {
    const ex     = getExchange(exchangeId);
    const ticker = await ex.fetchTicker(symbol);
    if (!ticker || !ticker.last) return null;
    return {
      exchange: exchangeId,
      symbol,
      bid:    ticker.bid,
      ask:    ticker.ask,
      last:   ticker.last,
      volume: ticker.baseVolume,
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
function findArbitrageOpportunities(tickers, minSpreadPct = 0.5, capital = 1000) {
  const opportunities = [];

  for (let i = 0; i < tickers.length; i++) {
    for (let j = 0; j < tickers.length; j++) {
      if (i === j) continue;
      const buyer  = tickers[i]; // acheter ici (ask bas)
      const seller = tickers[j]; // vendre ici  (bid haut)

      if (!buyer.ask || !seller.bid) continue;

      const spreadPct = ((seller.bid - buyer.ask) / buyer.ask) * 100;
     if (spreadPct < minSpreadPct) continue;

     // Estimation frais de trading (0.1% par leg = 0.2% aller-retour)
const feePct    = 0.2;
const netSpread = spreadPct - feePct;
// On garde même les signaux légèrement négatifs pour info
      const units      = capital / buyer.ask;
      const grossProfit = units * (seller.bid - buyer.ask);
      const fees        = capital * (feePct / 100);
      const netProfit   = grossProfit - fees;

      // Score de confiance basé sur volume et spread
      const minVolume   = Math.min(buyer.volume || 0, seller.volume || 0);
      const confidence  = Math.min(95, Math.round(
        50 + Math.min(30, spreadPct * 10) + Math.min(15, minVolume / 1000)
      ));

      // Fenêtre d'exécution estimée (plus le spread est petit, plus c'est rapide)
      const windowSec = Math.max(10, Math.round(90 - spreadPct * 20));

      const risk = spreadPct > 3 ? 'high' : spreadPct > 1.5 ? 'medium' : 'low';

      opportunities.push({
        symbol:        buyer.symbol,
        buyExchange:   buyer.exchange,
        sellExchange:  seller.exchange,
        buyPrice:      buyer.ask,
        sellPrice:     seller.bid,
        spreadPct:     parseFloat(spreadPct.toFixed(3)),
        netSpreadPct:  parseFloat(netSpread.toFixed(3)),
        grossProfit:   parseFloat(grossProfit.toFixed(2)),
        feesUSDT:      parseFloat(fees.toFixed(2)),
        netProfit:     parseFloat(netProfit.toFixed(2)),
        confidence,
        windowSec,
        risk,
        capital,
        timestamp: Date.now(),
      });
    }
  }

  // Trier par profit net décroissant
  return opportunities.sort((a, b) => b.netProfit - a.netProfit);
}

// ── CACHE DES PRIX (TTL 15s) ─────────────────────────────────────────────────
const priceCache = new Map(); // symbol -> { data, ts }
const CACHE_TTL  = 15_000;

async function getPrices(symbol, exchangeIds) {
  const key = `${symbol}:${exchangeIds.join(',')}`;
  const hit  = priceCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  const data = await fetchAllExchanges(symbol, exchangeIds);
  priceCache.set(key, { data, ts: Date.now() });
  return data;
}

// ── ROUTES API ───────────────────────────────────────────────────────────────

// GET /api/exchanges — liste des exchanges supportés + status
app.get('/api/exchanges', (req, res) => {
  res.json({
    exchanges: EXCHANGE_IDS,
    pairs:     SPOT_PAIRS,
  });
});

// GET /api/ticker?symbol=BTC/USDT
app.get('/api/ticker', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol requis' });

  const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
  res.json({ symbol, tickers });
});

// POST /api/scan — scan d'arbitrage principal
// Body: { minSpread, capital, pairs, exchanges }
app.post('/api/scan', async (req, res) => {
  const {
    minSpread = 0.5,
    capital   = 1000,
    pairs     = SPOT_PAIRS.slice(0, 6),
    exchanges = EXCHANGE_IDS,
  } = req.body;

  try {
    // Fetch tous les prix en parallèle (par paires)
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

    // Trier global par profit net
    allOpportunities.sort((a, b) => b.netProfit - a.netProfit);

    // Stats résumé
    const stats = {
      scannedPairs:    pairs.length,
      scannedExchanges: exchanges.length,
      totalSignals:    allOpportunities.length,
      bestSpread:      allOpportunities[0]?.spreadPct ?? 0,
      totalNetProfit:  allOpportunities.reduce((s, o) => s + o.netProfit, 0).toFixed(2),
      scanDurationMs:  0, // rempli ci-dessous
    };

    res.json({ opportunities: allOpportunities.slice(0, 20), stats });
  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prices — prix live de toutes les paires sur tous les exchanges
app.get('/api/prices', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;
  const tickers = await fetchAllExchanges(symbol, EXCHANGE_IDS);
  res.json({ symbol, tickers, ts: Date.now() });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟢 ArbiScan running → http://localhost:${PORT}`);
  console.log(`   Exchanges : ${EXCHANGE_IDS.join(', ')}`);
  console.log(`   Paires    : ${SPOT_PAIRS.length} paires surveillées\n`);
});
