require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const ccxt       = require('ccxt');
const { ALL_PAIRS, TIER1, getPrioritizedPairs, boostPair } = require('./pairs');
const { processAlerts, sendStartupMessage }                 = require('./telegram');
const autoScanner                                           = require('./autoScanner');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── CONFIG ───────────────────────────────────────────────────────────────────
const EXCHANGE_IDS  = [
  'binance', 'bybit', 'okx', 'kraken', 'kucoin',
  'gate', 'mexc', 'bitget', 'htx', 'coinbaseadvanced'
];
const WAVE_SIZE     = 40;
const WAVE_DELAY_MS = 200;

// ── EXCHANGE INSTANCES ────────────────────────────────────────────────────────
const exchangeInstances = {};

function getExchange(id) {
  if (!exchangeInstances[id]) {
    try {
      exchangeInstances[id] = new ccxt[id]({ timeout: 10000, enableRateLimit: true });
    } catch { return null; }
  }
  return exchangeInstances[id];
}

// ── FETCH TICKER ──────────────────────────────────────────────────────────────
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

// ── CACHE PRIX ────────────────────────────────────────────────────────────────
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

// ── HISTORIQUE PRIX ───────────────────────────────────────────────────────────
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

// ── CALCUL ARBITRAGE ──────────────────────────────────────────────────────────
function findArbitrageOpportunities(tickers, minSpreadPct = 0.05, capital = 1000) {
  const opportunities = [];
  for (let i = 0; i < tickers.length; i++) {
    for (let j = 0; j < tickers.length; j++) {
      if (i === j) continue;
      const buyer    = tickers[i];
      const seller   = tickers[j];
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

      boostPair(buyer.symbol, spreadPct);

      opportunities.push({
        symbol: buyer.symbol, buyExchange: buyer.exchange, sellExchange: seller.exchange,
        buyPrice, sellPrice,
        spreadPct:    parseFloat(spreadPct.toFixed(3)),
        netSpreadPct: parseFloat(netSpread.toFixed(3)),
        grossProfit:  parseFloat(grossProfit.toFixed(2)),
        feesUSDT:     parseFloat(fees.toFixed(2)),
        netProfit:    parseFloat(netProfit.toFixed(2)),
        confidence, windowSec, risk, capital, timestamp: Date.now(),
      });
    }
  }
  return opportunities.sort((a, b) => b.netProfit - a.netProfit);
}

// ── SCAN EN VAGUES ────────────────────────────────────────────────────────────
async function scanInWaves(pairs, exchanges, minSpread, capital) {
  const allOpportunities = [];
  for (let i = 0; i < pairs.length; i += WAVE_SIZE) {
    const wave = pairs.slice(i, i + WAVE_SIZE);
    const results = await Promise.allSettled(
      wave.map(async (symbol) => {
        const tickers = await getPrices(symbol, exchanges);
        if (tickers.length) recordPrices(symbol, tickers);
        return findArbitrageOpportunities(tickers, minSpread, capital);
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') allOpportunities.push(...r.value);
    }
    if (i + WAVE_SIZE < pairs.length) await new Promise(r => setTimeout(r, WAVE_DELAY_MS));
  }
  return allOpportunities;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/api/exchanges', (req, res) => {
  res.json({ exchanges: EXCHANGE_IDS, totalPairs: ALL_PAIRS.length, tier1Pairs: TIER1 });
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

app.get('/api/pairs', (req, res) => {
  const { tier } = req.query;
  res.json({ total: ALL_PAIRS.length, pairs: tier === '1' ? TIER1 : getPrioritizedPairs() });
});

// GET /api/status — état du scanner automatique
app.get('/api/status', (req, res) => {
  const last = autoScanner.getLastResults();
  res.json({
    autoScanActive:      true,
    scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL || '60000') / 1000,
    alertThreshold:      parseFloat(process.env.ALERT_SPREAD || '2.0'),
    telegramConfigured:  !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    lastScanTime:        last.lastScanTime,
    lastStats:           last.stats,
    lastTopSignals:      (last.opportunities || []).slice(0, 5),
  });
});

// POST /api/scan — scan rapide
app.post('/api/scan', async (req, res) => {
  const { minSpread = 0.05, capital = 1000, pairLimit = 30, exchanges = EXCHANGE_IDS, usePriority = true } = req.body;
  const t0    = Date.now();
  const pairs = usePriority ? getPrioritizedPairs(parseInt(pairLimit)) : TIER1.slice(0, parseInt(pairLimit));

  try {
    const allOpps = await scanInWaves(pairs, exchanges, parseFloat(minSpread), parseFloat(capital));
    allOpps.sort((a, b) => b.netProfit - a.netProfit);

    // Déclencher alertes Telegram si signal > seuil
    await processAlerts(allOpps, parseFloat(process.env.ALERT_SPREAD || '2.0'));

    res.json({
      opportunities: allOpps.slice(0, 30),
      stats: {
        scannedPairs: pairs.length, totalPairsAvailable: ALL_PAIRS.length,
        scannedExchanges: exchanges.length, totalSignals: allOpps.length,
        bestSpread: allOpps[0]?.spreadPct ?? 0, bestPair: allOpps[0]?.symbol ?? '—',
        bestRoute: allOpps[0] ? `${allOpps[0].buyExchange} → ${allOpps[0].sellExchange}` : '—',
        totalNetProfit: allOpps.reduce((s, o) => s + o.netProfit, 0).toFixed(2),
        scanDurationMs: Date.now() - t0,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scan/full — scan étendu
app.post('/api/scan/full', async (req, res) => {
  const { minSpread = 0.05, capital = 1000, exchanges = EXCHANGE_IDS, maxPairs = 200 } = req.body;
  const t0    = Date.now();
  const pairs = getPrioritizedPairs(parseInt(maxPairs));

  try {
    const allOpps = await scanInWaves(pairs, exchanges, parseFloat(minSpread), parseFloat(capital));
    allOpps.sort((a, b) => b.netProfit - a.netProfit);
    await processAlerts(allOpps, parseFloat(process.env.ALERT_SPREAD || '2.0'));

    res.json({
      opportunities: allOpps.slice(0, 50),
      stats: {
        scannedPairs: pairs.length, totalPairsAvailable: ALL_PAIRS.length,
        scannedExchanges: exchanges.length, totalSignals: allOpps.length,
        bestSpread: allOpps[0]?.spreadPct ?? 0, bestPair: allOpps[0]?.symbol ?? '—',
        totalNetProfit: allOpps.reduce((s, o) => s + o.netProfit, 0).toFixed(2),
        scanDurationMs: Date.now() - t0,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/alert/test — tester l'alerte Telegram
app.post('/api/alert/test', async (req, res) => {
  const { sendTelegram } = require('./telegram');
  const ok = await sendTelegram(
    `✅ *Test ArbiScan*\n\nVotre bot Telegram est correctement configuré !\n_${new Date().toLocaleString('fr-FR')}_`
  );
  res.json({ success: ok, message: ok ? 'Message envoyé !' : 'Échec — vérifiez TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID' });
});

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🟢 ArbiScan running → http://localhost:${PORT}`);
  console.log(`   Exchanges    : ${EXCHANGE_IDS.length} exchanges`);
  console.log(`   Paires total : ${ALL_PAIRS.length} paires`);

  // Initialiser et démarrer le scanner automatique
  autoScanner.init(getPrices, findArbitrageOpportunities, EXCHANGE_IDS);
  autoScanner.start();

  // Message de démarrage Telegram
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await sendStartupMessage();
  }
});

