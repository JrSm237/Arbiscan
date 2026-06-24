// ── SCANNER AUTOMATIQUE (tourne en arrière-plan) ─────────────────────────────
// Lance un scan des paires TIER1 toutes les 60s
// Si spread > 2% détecté → alerte Telegram

const { getPrioritizedPairs, TIER1 } = require('./pairs');
const { processAlerts } = require('./telegram');

const ALERT_SPREAD_THRESHOLD = parseFloat(process.env.ALERT_SPREAD || '2.0');
const SCAN_INTERVAL_MS       = parseInt(process.env.SCAN_INTERVAL  || '60000'); // 60s
const AUTO_SCAN_PAIRS        = parseInt(process.env.AUTO_SCAN_PAIRS || '50');   // top 50 paires

let isRunning    = false;
let scanCount    = 0;
let lastScanTime = null;
let lastResults  = { opportunities: [], stats: {} };

// Référence vers les fonctions du serveur principal (injectées au démarrage)
let _getPrices  = null;
let _findOpps   = null;
let _exchangeIds = null;

function init(getPrices, findArbitrageOpportunities, exchangeIds) {
  _getPrices   = getPrices;
  _findOpps    = findArbitrageOpportunities;
  _exchangeIds = exchangeIds;
  console.log(`🤖 Auto-scanner initialisé — scan toutes les ${SCAN_INTERVAL_MS/1000}s`);
  console.log(`   Seuil alerte : spread > ${ALERT_SPREAD_THRESHOLD}%`);
  console.log(`   Paires auto  : top ${AUTO_SCAN_PAIRS}`);
}

async function runAutoScan() {
  if (!_getPrices || isRunning) return;
  isRunning = true;

  try {
    const pairs   = getPrioritizedPairs(AUTO_SCAN_PAIRS);
    const capital = 1000;
    const allOpps = [];

    // Scan en parallèle par groupes de 10
    for (let i = 0; i < pairs.length; i += 10) {
      const wave = pairs.slice(i, i + 10);
      const waveResults = await Promise.allSettled(
        wave.map(async (symbol) => {
          const tickers = await _getPrices(symbol, _exchangeIds);
          return _findOpps(tickers, 0.05, capital);
        })
      );
      for (const r of waveResults) {
        if (r.status === 'fulfilled') allOpps.push(...r.value);
      }
      // Pause anti rate-limit
      await new Promise(r => setTimeout(r, 150));
    }

    allOpps.sort((a, b) => b.netProfit - a.netProfit);

    // Stocker les derniers résultats (accessibles via /api/status)
    lastResults = {
      opportunities: allOpps.slice(0, 20),
      stats: {
        scannedPairs:   pairs.length,
        totalSignals:   allOpps.length,
        bestSpread:     allOpps[0]?.spreadPct ?? 0,
        bestPair:       allOpps[0]?.symbol ?? '—',
        scanDurationMs: 0,
        scanCount:      ++scanCount,
        lastScanTime:   new Date().toISOString(),
      }
    };
    lastScanTime = new Date();

    // Déclencher alertes Telegram si seuil atteint
    const alertsTriggered = await processAlerts(allOpps, ALERT_SPREAD_THRESHOLD);

    if (allOpps.length > 0) {
      console.log(`🔍 Auto-scan #${scanCount} : ${allOpps.length} signaux | meilleur: ${allOpps[0]?.spreadPct?.toFixed(2)}% ${allOpps[0]?.symbol} | alertes: ${alertsTriggered}`);
    }

  } catch (err) {
    console.error('Auto-scan error:', err.message);
  } finally {
    isRunning = false;
  }
}

function start() {
  // Premier scan après 10s (laisser le serveur démarrer)
  setTimeout(runAutoScan, 10_000);
  // Puis toutes les SCAN_INTERVAL_MS
  setInterval(runAutoScan, SCAN_INTERVAL_MS);
  console.log(`🚀 Auto-scanner démarré — premier scan dans 10s`);
}

function getLastResults() {
  return { ...lastResults, lastScanTime };
}

module.exports = { init, start, getLastResults };
