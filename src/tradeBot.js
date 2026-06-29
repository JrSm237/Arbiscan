// ── BOT D'EXÉCUTION AUTOMATIQUE D'ARBITRAGE ──────────────────────────────────
// OKX + HTX — Spot uniquement — Spread > 2%
// Sécurité : pas de retrait autorisé sur les clés API

require('dotenv').config();
const ccxt = require('ccxt');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  MIN_SPREAD_PCT:   parseFloat(process.env.MIN_SPREAD_PCT  || '2.0'),
  CAPITAL_PER_LEG: parseFloat(process.env.CAPITAL_PER_LEG || '10'),
  OKX_CAPITAL:     parseFloat(process.env.CAPITAL_PER_LEG || '10'),
  HTX_CAPITAL:     parseFloat(process.env.CAPITAL_PER_LEG || '10'),
  SELECTED_PAIR:   null,
  EXCHANGE_1:      'okx',  // exchange principal (modifiable dynamiquement)
  EXCHANGE_2:      'htx',  // exchange secondaire
  FEE_PCT:         0.1,
  SCAN_INTERVAL:   15000,
  ORDER_TIMEOUT:   10000,
  MAX_SLIPPAGE:    0.3,
  DRY_RUN: process.env.DRY_RUN === 'true',
};

// ── EXCHANGES ─────────────────────────────────────────────────────────────────
// Instances PUBLIQUES pour fetch des prix (pas besoin de clés)
const publicExchanges = {
  okx: new ccxt.okx({ timeout: 10000, enableRateLimit: true, options: { defaultType: 'spot' } }),
  htx: new ccxt.htx({ timeout: 10000, enableRateLimit: true, options: { defaultType: 'spot' } }),
};

// Instances PRIVÉES pour passer les ordres (nécessitent clés API)
const privateExchanges = {
  okx: new ccxt.okx({
    apiKey:     process.env.OKX_API_KEY,
    secret:     process.env.OKX_SECRET,
    password:   process.env.OKX_PASSPHRASE,
    timeout:    10000,
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  }),
  htx: new ccxt.htx({
    apiKey:  process.env.HTX_API_KEY,
    secret:  process.env.HTX_SECRET,
    timeout: 10000,
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  }),
};

// Alias pour compatibilité
const exchanges = privateExchanges;

// ── PAIRES PRIORITAIRES (celles qui ont montré des spreads) ───────────────────
const PRIORITY_PAIRS = [
  'BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','BNB/USDT',
  'DOGE/USDT','ADA/USDT','AVAX/USDT','LINK/USDT','DOT/USDT',
  'MATIC/USDT','LTC/USDT','UNI/USDT','ATOM/USDT','BCH/USDT',
  'GMX/USDT','RUNE/USDT','INJ/USDT','WIF/USDT','PEPE/USDT',
  'BONK/USDT','ARB/USDT','OP/USDT','TIA/USDT','SUI/USDT',
  'SEI/USDT','FTM/USDT','NEAR/USDT','APT/USDT','TON/USDT',
];

// ── ÉTAT DU BOT ───────────────────────────────────────────────────────────────
const state = {
  running:       false,
  totalTrades:   0,
  successTrades: 0,
  failedTrades:  0,
  totalPnL:      0,
  balances:      { okx: {}, htx: {} },
  lastScan:      null,
  activeTrade:   null,
  tradeHistory:  [],
};

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
async function tg(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TG]', msg.replace(/\*/g, ''));
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       msg,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error('TG error:', e.message);
  }
}

// ── FETCH TICKER ──────────────────────────────────────────────────────────────
async function fetchTicker(exchangeId, symbol) {
  try {
    // Toujours utiliser l'instance publique pour les prix (pas besoin de clés API)
    const ex = publicExchanges[exchangeId];
    const t  = await ex.fetchTicker(symbol);
    if (!t || (!t.bid && !t.ask && !t.last)) return null;
    return {
      exchange: exchangeId,
      symbol,
      bid:    t.bid    || t.last,
      ask:    t.ask    || t.last,
      last:   t.last,
      volume: t.baseVolume || 0,
    };
  } catch(e) {
    console.log(`[fetchTicker] ${exchangeId} ${symbol}: ${e.message}`);
    return null;
  }
}

// ── FETCH BALANCES ────────────────────────────────────────────────────────────
async function fetchBalances() {
  for (const [id, ex] of Object.entries(privateExchanges)) {
    try {
      // Ne fetch les balances que si les clés API sont configurées
      const hasKey = id === 'okx'
        ? process.env.OKX_API_KEY
        : process.env.HTX_API_KEY;

      if (!hasKey) {
        // Mode DRY_RUN sans clés : balances simulées
        state.balances[id] = {
          USDT:  CONFIG.DRY_RUN ? (id === 'okx' ? CONFIG.OKX_CAPITAL : CONFIG.HTX_CAPITAL) : 0,
          total: {},
          free:  {},
          simulated: true,
        };
        continue;
      }

      const bal = await ex.fetchBalance();
      state.balances[id] = {
        USDT:  bal.USDT?.free  || 0,
        total: bal.total || {},
        free:  bal.free  || {},
      };
    } catch (e) {
      console.error(`Balance ${id}:`, e.message);
      // En cas d'erreur, ne pas bloquer — balances à 0
      state.balances[id] = { USDT: 0, total: {}, free: {}, error: e.message };
    }
  }
  return state.balances;
}

// ── VÉRIFIER QU'ON A ASSEZ DE FONDS ──────────────────────────────────────────
function hasEnoughFunds(buyExchange, sellExchange, symbol, buyPrice) {
  // En simulation : toujours autoriser le trade
  if (CONFIG.DRY_RUN) {
    return { ok: true, simulated: true };
  }

  const base = symbol.split('/')[0];
  // Capital selon quel exchange achète
  const buyerCapital = buyExchange === CONFIG.EXCHANGE_1 ? CONFIG.OKX_CAPITAL : CONFIG.HTX_CAPITAL;
  const buyerUSDT    = state.balances[buyExchange]?.USDT || 0;
  const sellerToken  = state.balances[sellExchange]?.free?.[base] || 0;
  const neededToken  = buyerCapital / buyPrice;

  if (buyerUSDT < buyerCapital) {
    return { ok: false, reason: `${buyExchange}: USDT insuffisant (${buyerUSDT.toFixed(2)} < ${buyerCapital})` };
  }
  if (sellerToken < neededToken) {
    return { ok: false, reason: `${sellExchange}: ${base} insuffisant (${sellerToken.toFixed(6)} < ${neededToken.toFixed(6)})` };
  }
  return { ok: true };
}

// ── PLACER UN ORDRE MARKET ────────────────────────────────────────────────────
async function placeMarketOrder(exchangeId, symbol, side, amount) {
  const ex = exchanges[exchangeId];

  if (CONFIG.DRY_RUN) {
    // Simuler un ordre avec un léger slippage réaliste (0.05%)
    const slippage = side === 'buy' ? 1.0005 : 0.9995;
    console.log(`[SIM] ${side.toUpperCase()} ${amount.toFixed(6)} ${symbol} on ${exchangeId}`);
    return {
      id:      'sim-' + Date.now(),
      status:  'closed',
      filled:  amount,
      average: 0, // sera remplacé par buyPrice/sellPrice dans executeTrade
      simulated: true,
    };
  }

  try {
    const order = await ex.createMarketOrder(symbol, side, amount);
    return order;
  } catch (e) {
    throw new Error(`Ordre ${side} ${symbol} sur ${exchangeId}: ${e.message}`);
  }
}

// ── EXÉCUTER UN TRADE D'ARBITRAGE ────────────────────────────────────────────
async function executeTrade(opp) {
  if (state.activeTrade) {
    console.log('Trade déjà en cours, on attend...');
    return;
  }

  state.activeTrade = opp;
  state.totalTrades++;

  const { symbol, buyExchange, sellExchange, buyPrice, sellPrice, spreadPct } = opp;
  const base     = symbol.split('/')[0];
  const capital  = buyExchange === 'okx' ? CONFIG.OKX_CAPITAL : CONFIG.HTX_CAPITAL;
  const amount   = capital / buyPrice;
  const feeCost  = capital * (CONFIG.FEE_PCT / 100) * 2; // 2 legs
  const grossPnL = amount * (sellPrice - buyPrice);
  const netPnL   = grossPnL - feeCost;

  const tradeId = `T${Date.now()}`;
  const startTime = Date.now();

  await tg(`🔄 *TRADE EN COURS* \`${tradeId}\`

💎 *Paire :* \`${symbol}\`
📈 *Spread :* \`+${spreadPct.toFixed(2)}%\`
💰 *PnL estimé :* \`+${netPnL.toFixed(3)} USDT\`

🔽 *Achat :* \`${buyExchange}\` @ $${buyPrice.toFixed(4)}
🔼 *Vente :* \`${sellExchange}\` @ $${sellPrice.toFixed(4)}
📦 *Quantité :* \`${amount.toFixed(6)} ${base}\`
${CONFIG.DRY_RUN ? '\n⚠️ _MODE SIMULATION — pas de vrai trade_' : ''}`);

  try {
    // ── EXÉCUTION SIMULTANÉE (achat + vente en parallèle) ────────────────────
    const [buyOrder, sellOrder] = await Promise.all([
      placeMarketOrder(buyExchange,  symbol, 'buy',  amount),
      placeMarketOrder(sellExchange, symbol, 'sell', amount),
    ]);

    const elapsed = Date.now() - startTime;

    // Calcul PnL réel
    // En simulation, average=0 donc on utilise les prix réels détectés
    const realBuyPrice  = buyOrder.average  || buyPrice;
    const realSellPrice = sellOrder.average || sellPrice;
    const realPnL = (realSellPrice - realBuyPrice) * amount - feeCost;

    // En simulation : mettre à jour les balances simulées
    if (CONFIG.DRY_RUN) {
      const b = symbol.split('/')[0];
      if (!state.balances[buyExchange])  state.balances[buyExchange]  = { USDT: capital, free: {} };
      if (!state.balances[sellExchange]) state.balances[sellExchange] = { USDT: capital, free: {} };
      // Acheteur perd des USDT, gagne des tokens
      state.balances[buyExchange].USDT -= capital;
      state.balances[buyExchange].free[b] = (state.balances[buyExchange].free[b] || 0) + amount;
      // Vendeur perd des tokens, gagne des USDT
      state.balances[sellExchange].free[b] = Math.max(0, (state.balances[sellExchange].free[b] || 0) - amount);
      state.balances[sellExchange].USDT += (amount * realSellPrice) - feeCost / 2;
    }

    state.totalPnL      += realPnL;
    state.successTrades++;

    // Enregistrer dans l'historique
    const trade = {
      id:          tradeId,
      symbol,
      buyExchange,
      sellExchange,
      buyPrice:    realBuyPrice,
      sellPrice:   realSellPrice,
      amount,
      spreadPct,
      pnl:         realPnL,
      feeCost,
      buyOrderId:  buyOrder.id,
      sellOrderId: sellOrder.id,
      duration:    elapsed,
      timestamp:   new Date().toISOString(),
      status:      'success',
    };
    state.tradeHistory.unshift(trade);
    if (state.tradeHistory.length > 100) state.tradeHistory.pop();

    await tg(`✅ *TRADE RÉUSSI* \`${tradeId}\`

💎 *Paire :* \`${symbol}\`
💰 *PnL net :* \`+${realPnL.toFixed(4)} USDT\`
📊 *PnL total :* \`+${state.totalPnL.toFixed(4)} USDT\`
⏱ *Durée :* \`${elapsed}ms\`

🔽 *Acheté :* ${amount.toFixed(6)} @ $${realBuyPrice.toFixed(4)} sur \`${buyExchange}\`
🔼 *Vendu :* ${amount.toFixed(6)} @ $${realSellPrice.toFixed(4)} sur \`${sellExchange}\`
📋 *Trades :* ${state.successTrades}✅ / ${state.failedTrades}❌`);

    // Mettre à jour les balances après le trade
    setTimeout(fetchBalances, 2000);

    return trade;

  } catch (e) {
    state.failedTrades++;

    const trade = {
      id:       tradeId,
      symbol,
      buyExchange,
      sellExchange,
      spreadPct,
      pnl:      0,
      error:    e.message,
      timestamp: new Date().toISOString(),
      status:   'failed',
    };
    state.tradeHistory.unshift(trade);

    await tg(`❌ *TRADE ÉCHOUÉ* \`${tradeId}\`

💎 *Paire :* \`${symbol}\`
⚠️ *Erreur :* \`${e.message}\`
📋 *Trades :* ${state.successTrades}✅ / ${state.failedTrades}❌

_Vérifiez les balances et les permissions API_`);

    console.error('Trade failed:', e.message);
    return trade;

  } finally {
    state.activeTrade = null;
  }
}

// ── SCAN ET DÉTECTION D'OPPORTUNITÉS ─────────────────────────────────────────
async function scanAndTrade() {
  if (state.activeTrade) return; // Trade en cours, on attend
  state.lastScan = new Date();

  // Si une paire spécifique est sélectionnée, on ne scanne que celle-là
  const pairsToScan = CONFIG.SELECTED_PAIR ? [CONFIG.SELECTED_PAIR] : PRIORITY_PAIRS;
  const ex1 = CONFIG.EXCHANGE_1;
  const ex2 = CONFIG.EXCHANGE_2;
  console.log(`🔍 Scan — ${pairsToScan.length} paire(s) sur ${ex1}↔${ex2} — spread min: ${CONFIG.MIN_SPREAD_PCT}% [${CONFIG.DRY_RUN?'SIM':'LIVE'}]`);
  let signalsFound = 0;

  for (const symbol of pairsToScan) {
    if (state.activeTrade) break;

    try {
      const [ex1Ticker, ex2Ticker] = await Promise.all([
        fetchTicker(ex1, symbol),
        fetchTicker(ex2, symbol),
      ]);

      if (!ex1Ticker || !ex2Ticker) continue;

      // Vérifier les deux sens
      const opportunities = [
        {
          buyExchange:  ex1,  buyPrice:  ex1Ticker.ask || ex1Ticker.last,
          sellExchange: ex2,  sellPrice: ex2Ticker.bid || ex2Ticker.last,
        },
        {
          buyExchange:  ex2,  buyPrice:  ex2Ticker.ask || ex2Ticker.last,
          sellExchange: ex1,  sellPrice: ex1Ticker.bid || ex1Ticker.last,
        },
      ];

      for (const opp of opportunities) {
        if (!opp.buyPrice || !opp.sellPrice) continue;

        const spreadPct = ((opp.sellPrice - opp.buyPrice) / opp.buyPrice) * 100;
        const netSpread = spreadPct - CONFIG.FEE_PCT * 2;

        if (netSpread < CONFIG.MIN_SPREAD_PCT) continue;

        // Vérifier les fonds
        const fundsCheck = hasEnoughFunds(opp.buyExchange, opp.sellExchange, symbol, opp.buyPrice);
        if (!fundsCheck.ok) {
          console.log(`💰 Fonds insuffisants: ${fundsCheck.reason}`);
          continue;
        }

        // ✅ Opportunité valide — on trade !
        signalsFound++;
        console.log(`🎯 Signal: ${symbol} +${netSpread.toFixed(2)}% net — ${opp.buyExchange}→${opp.sellExchange} [${CONFIG.DRY_RUN ? 'SIM' : 'LIVE'}]`);
        await executeTrade({ symbol, spreadPct: netSpread, ...opp });
        break;
      }
    } catch (e) {
      console.error(`Scan ${symbol}:`, e.message);
    }
  }

  if (signalsFound === 0) {
    console.log(`📭 Aucun signal trouvé (spread < ${CONFIG.MIN_SPREAD_PCT}% sur ${pairsToScan.join(', ')})`);
  }
}

// ── RAPPORT HEBDOMADAIRE ──────────────────────────────────────────────────────
async function sendWeeklyReport() {
  const bals = await fetchBalances();
  await tg(`📊 *RAPPORT HEBDOMADAIRE ArbiScan*

💰 *PnL total :* \`+${state.totalPnL.toFixed(4)} USDT\`
📋 *Total trades :* ${state.totalTrades}
✅ *Réussis :* ${state.successTrades}
❌ *Échoués :* ${state.failedTrades}
🎯 *Taux réussite :* ${state.totalTrades > 0 ? ((state.successTrades/state.totalTrades)*100).toFixed(1) : 0}%

*Balances actuelles :*
OKX USDT : \`${bals.okx?.USDT?.toFixed(2) || '—'}\`
HTX USDT : \`${bals.htx?.USDT?.toFixed(2) || '—'}\`

_Vous pouvez retirer les bénéfices et maintenir le ratio 50/50_`);
}

// ── DÉMARRER LE BOT ───────────────────────────────────────────────────────────
async function start(dynamicConfig = {}) {
  // Arrêter le bot s'il tourne déjà avant de reconfigurer
  if (state.running) {
    state.running = false;
    await new Promise(r => setTimeout(r, 1000));
  }

  // Appliquer la config dynamique
  if (dynamicConfig.minSpreadPct)       CONFIG.MIN_SPREAD_PCT = dynamicConfig.minSpreadPct;
  if (dynamicConfig.okxCapital != null) CONFIG.OKX_CAPITAL    = dynamicConfig.okxCapital;
  if (dynamicConfig.htxCapital != null) CONFIG.HTX_CAPITAL    = dynamicConfig.htxCapital;
  if (dynamicConfig.dryRun !== undefined) CONFIG.DRY_RUN      = dynamicConfig.dryRun;

  // Exchanges dynamiques fournis depuis l'admin
  if (dynamicConfig.exchange1 && dynamicConfig.exchange2) {
    CONFIG.EXCHANGE_1 = dynamicConfig.exchange1;
    CONFIG.EXCHANGE_2 = dynamicConfig.exchange2;

    // Reconfigurer les instances privées avec les nouvelles clés API
    if (dynamicConfig.apiConfigs) {
      const ccxt = require('ccxt');
      for (const [id, cfg] of Object.entries(dynamicConfig.apiConfigs)) {
        if (!ccxt[id]) continue;
        privateExchanges[id] = new ccxt[id]({
          apiKey:   cfg.apiKey,
          secret:   cfg.secret,
          password: cfg.passphrase || '',
          timeout:  10000,
          enableRateLimit: true,
          options: { defaultType: 'spot' },
        });
        publicExchanges[id] = new ccxt[id]({
          timeout: 10000,
          enableRateLimit: true,
          options: { defaultType: 'spot' },
        });
        console.log(`🔑 ${id} configuré avec clés API fournies`);
      }
    }
  }

  // Paire sélectionnée
  if (dynamicConfig.pair) {
    CONFIG.SELECTED_PAIR   = dynamicConfig.pair;
    CONFIG.CAPITAL_PER_LEG = Math.min(dynamicConfig.okxCapital || 10, dynamicConfig.htxCapital || 10);
  } else {
    CONFIG.SELECTED_PAIR   = null;
    CONFIG.CAPITAL_PER_LEG = parseFloat(process.env.CAPITAL_PER_LEG || '10');
  }

  state.running = true;

  console.log('\n🤖 ArbiScan Trade Bot démarré');
  console.log(`   Exchanges    : OKX + HTX`);
  console.log(`   Paire        : ${CONFIG.SELECTED_PAIR || 'Multi-paires'}`);
  console.log(`   Spread min   : ${CONFIG.MIN_SPREAD_PCT}%`);
  console.log(`   Capital OKX  : ${CONFIG.OKX_CAPITAL || CONFIG.CAPITAL_PER_LEG} USDT`);
  console.log(`   Capital HTX  : ${CONFIG.HTX_CAPITAL || CONFIG.CAPITAL_PER_LEG} USDT`);
  console.log(`   Mode         : ${CONFIG.DRY_RUN ? '🧪 SIMULATION' : '💰 PRODUCTION'}`);
  console.log(`   Scan interval: ${CONFIG.SCAN_INTERVAL / 1000}s\n`);

  // Vérifier les connexions et charger les balances
  try {
    await fetchBalances();
    const ex1Label = CONFIG.EXCHANGE_1.toUpperCase();
    const ex2Label = CONFIG.EXCHANGE_2.toUpperCase();
    const ex1USDT  = state.balances[CONFIG.EXCHANGE_1]?.USDT || 0;
    const ex2USDT  = state.balances[CONFIG.EXCHANGE_2]?.USDT || 0;

    await tg(`🚀 *ArbiScan Bot DÉMARRÉ*

🤖 *Mode :* ${CONFIG.DRY_RUN ? '🧪 Simulation' : '💰 Production'}
💎 *Paire :* ${CONFIG.SELECTED_PAIR || 'Multi-paires (top 30)'}
🏦 *Exchanges :* ${ex1Label} ↔ ${ex2Label}
📈 *Spread min :* ${CONFIG.MIN_SPREAD_PCT}%
💵 *Capital ${ex1Label} :* ${CONFIG.OKX_CAPITAL} USDT
💵 *Capital ${ex2Label} :* ${CONFIG.HTX_CAPITAL} USDT

*Balances :*
${ex1Label} USDT : \`${ex1USDT.toFixed(2)}\`
${ex2Label} USDT : \`${ex2USDT.toFixed(2)}\`

_Scan toutes les ${CONFIG.SCAN_INTERVAL / 1000}s — Trade si spread > ${CONFIG.MIN_SPREAD_PCT}%_`);

  } catch (e) {
    console.error('Erreur démarrage:', e.message);
    await tg(`❌ *Erreur démarrage bot*\n\n\`${e.message}\`\n\nVérifiez les clés API dans les variables d'environnement.`);
  }

  // Rapport hebdomadaire automatique (chaque dimanche à 20h)
  setInterval(() => {
    const now = new Date();
    if (now.getDay() === 0 && now.getHours() === 20 && now.getMinutes() < 1) {
      sendWeeklyReport();
    }
  }, 60000);

  // Boucle de scan
  const loop = async () => {
    if (!state.running) return;
    try { await scanAndTrade(); } catch (e) { console.error('Loop error:', e.message); }
    setTimeout(loop, CONFIG.SCAN_INTERVAL);
  };
  setTimeout(loop, 3000);
}

function stop() {
  state.running = false;
  console.log('Bot arrêté.');
  tg('⏹ *Bot ArbiScan arrêté manuellement*');
}

function getState() {
  return {
    ...state,
    config: {
      ...CONFIG,
      selectedPair:  CONFIG.SELECTED_PAIR  || 'Multi-paires',
      exchange1:     CONFIG.EXCHANGE_1,
      exchange2:     CONFIG.EXCHANGE_2,
    }
  };
}

module.exports = { start, stop, getState, sendWeeklyReport, fetchBalances };
