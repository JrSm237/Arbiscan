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

// ── ROUTES MONÉTISATION ───────────────────────────────────────────────────────
const { PLANS, initCinetPay, verifyCinetPay, getUSDTInstructions, verifyUSDTPayment } = require('./payments');
const { upsertUser, activateSubscription, getUserByEmail, getActiveSubscribers } = require('./auth');
const { generateToken, verifyToken, requireAuth, requirePremium, scanLimit } = require('./middleware');
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// GET /api/plans — liste des plans
app.get('/api/plans', (req, res) => {
  res.json({ plans: PLANS, currency: { primary: 'USDT', secondary: 'XAF (FCFA)' } });
});

// POST /api/auth/register — inscription
app.post('/api/auth/register', async (req, res) => {
  const { email, phone, name, telegram_id } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  const user = await upsertUser({ email, phone, name, telegram_id });
  if (!user) return res.status(500).json({ error: 'Erreur création compte' });

  const token = generateToken(user);
  res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ success: true, token, user: { id: user.id, email, name } });
});

// POST /api/auth/login — connexion simple par email
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  const user = await getUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'Compte non trouvé. Inscrivez-vous d\'abord.' });

  const token = generateToken(user);
  res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name } });
});

// GET /api/auth/me — profil utilisateur + statut premium
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { checkPremium } = require('./auth');
  const isPremium = await checkPremium(req.user.id);
  res.json({ user: req.user, premium: isPremium });
});

// POST /api/payments/cinetpay/init — initier paiement Mobile Money
app.post('/api/payments/cinetpay/init', requireAuth, async (req, res) => {
  const { plan = 'monthly' } = req.body;
  const result = await initCinetPay({
    plan,
    userId: req.user.id,
    email:  req.user.email,
    phone:  req.body.phone || '',
    name:   req.user.name || 'Client ArbiScan',
  });
  res.json(result);
});

// POST /api/payments/cinetpay/notify — webhook CinetPay (appelé automatiquement)
app.post('/api/payments/cinetpay/notify', async (req, res) => {
  const { transaction_id, status } = req.body;
  if (status !== 'ACCEPTED') return res.json({ ok: false });

  // Extraire userId depuis transactionId (ARB-userId-timestamp)
  const parts  = (transaction_id || '').split('-');
  const userId = parts[1];
  if (!userId) return res.json({ ok: false });

  const verify = await verifyCinetPay(transaction_id);
  if (!verify.success) return res.json({ ok: false });

  const ok = await activateSubscription(userId, {
    plan:          'monthly',
    paymentRef:    transaction_id,
    paymentMethod: 'cinetpay',
  });

  if (ok) {
    console.log(`✅ Abonnement activé — user ${userId} via CinetPay`);
    // Envoyer message Telegram de confirmation
    const { sendTelegram } = require('./telegram');
    const sb = require('./auth').getSupabase();
    if (sb) {
      const { data } = await sb.from('users').select('telegram_id, name').eq('id', userId).single();
      if (data?.telegram_id) {
        await sendTelegram(`✅ *Paiement confirmé !*\n\nBonjour ${data.name || 'abonné'}, votre accès ArbiScan Premium est activé pour 30 jours.\n\n🚨 Vous recevrez désormais toutes les alertes d'arbitrage en temps réel.`);
      }
    }
  }
  res.json({ ok });
});

// GET /api/payments/usdt/instructions — instructions paiement USDT
app.get('/api/payments/usdt/instructions', requireAuth, async (req, res) => {
  const { plan = 'monthly' } = req.query;
  const instructions = getUSDTInstructions(plan, req.user.id);
  res.json(instructions);
});

// POST /api/payments/usdt/verify — vérifier hash de transaction USDT
app.post('/api/payments/usdt/verify', requireAuth, async (req, res) => {
  const { txHash, plan = 'monthly' } = req.body;
  if (!txHash) return res.status(400).json({ error: 'Hash de transaction requis' });

  const p      = PLANS[plan];
  const result = await verifyUSDTPayment(txHash, p.usdt);

  if (result.success) {
    const ok = await activateSubscription(req.user.id, {
      plan,
      paymentRef:    txHash,
      paymentMethod: 'usdt_trc20',
    });
    if (ok) {
      console.log(`✅ Abonnement USDT activé — user ${req.user.id}`);
      res.json({ success: true, message: 'Abonnement activé !' });
    } else {
      res.status(500).json({ error: 'Erreur activation abonnement' });
    }
  } else {
    res.status(400).json({ error: result.error });
  }
});

// POST /api/payments/usdt/manual — activation manuelle par admin
app.post('/api/payments/usdt/manual', async (req, res) => {
  const { adminKey, email, plan = 'monthly', txHash } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Clé admin invalide' });

  const user = await getUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

  const ok = await activateSubscription(user.id, {
    plan,
    paymentRef:    txHash || 'manual-' + Date.now(),
    paymentMethod: 'usdt_manual',
  });

  res.json({ success: ok, message: ok ? `Abonnement ${plan} activé pour ${email}` : 'Erreur' });
});

// GET /api/admin/subscribers — liste des abonnés actifs (admin)
app.get('/api/admin/subscribers', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  const subs = await getActiveSubscribers();
  res.json({ count: subs.length, subscribers: subs });
});

// ── ROUTES BOT D'EXÉCUTION ────────────────────────────────────────────────────
const tradeBot = require('./tradeBot');

// Démarrer le bot automatiquement si les clés API sont configurées
if (process.env.OKX_API_KEY && process.env.HTX_API_KEY) {
  console.log('🤖 Démarrage du bot d\'exécution...');
  tradeBot.start().catch(console.error);
} else {
  console.log('⚠ Bot d\'exécution désactivé (clés API manquantes)');
}

// GET /api/bot/status — état du bot
app.get('/api/bot/status', (req, res) => {
  res.json(tradeBot.getState());
});

// POST /api/bot/start — démarrer le bot avec config dynamique
app.post('/api/bot/start', async (req, res) => {
  const { adminKey, okxCapital, htxCapital, minSpreadPct, dryRun } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });

  // Passer la config dynamique au bot
  const config = {
    okxCapital:    parseFloat(okxCapital)  || 10,
    htxCapital:    parseFloat(htxCapital)  || 10,
    minSpreadPct:  parseFloat(minSpreadPct)|| 2.0,
    dryRun:        dryRun === true || dryRun === 'true',
  };

  await tradeBot.start(config);
  const modeLabel = config.dryRun ? '🧪 Simulation' : '💰 Production';
  res.json({
    success: true,
    message: `✅ Bot démarré — ${modeLabel} | OKX: ${config.okxCapital} USDT | HTX: ${config.htxCapital} USDT | Spread min: ${config.minSpreadPct}%`
  });
});

// POST /api/bot/stop — arrêter le bot
app.post('/api/bot/stop', (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  tradeBot.stop();
  res.json({ success: true, message: 'Bot arrêté' });
});

// GET /api/bot/trades — historique des trades
app.get('/api/bot/trades', (req, res) => {
  const state = tradeBot.getState();
  res.json({
    trades:        state.tradeHistory,
    totalTrades:   state.totalTrades,
    successTrades: state.successTrades,
    failedTrades:  state.failedTrades,
    totalPnL:      state.totalPnL,
  });
});

// GET /api/bot/balances — balances des exchanges
app.get('/api/bot/balances', async (req, res) => {
  try {
    const balances = await tradeBot.fetchBalances();
    res.json(balances);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bot/report — envoyer rapport hebdomadaire manuellement
app.post('/api/bot/report', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  await tradeBot.sendWeeklyReport();
  res.json({ success: true });
});
