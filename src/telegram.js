// ── MODULE ALERTES TELEGRAM ──────────────────────────────────────────────────
// Nécessite dans .env :
//   TELEGRAM_BOT_TOKEN=123456:ABC-xxx
//   TELEGRAM_CHAT_ID=-100xxxxxxxxxx  (groupe) ou @username ou votre ID perso

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Anti-spam : clé = "symbol:buyEx:sellEx" → timestamp dernier envoi
const alertCooldowns = new Map();
const COOLDOWN_MS    = 10 * 60 * 1000; // 10 minutes

function canAlert(key) {
  const last = alertCooldowns.get(key);
  if (!last) return true;
  return Date.now() - last > COOLDOWN_MS;
}

function markAlerted(key) {
  alertCooldowns.set(key, Date.now());
}

// Formate un beau message Telegram (Markdown)
function formatSignalMessage(opp) {
  const time = new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });

  return `🚨 *SIGNAL D'ARBITRAGE DÉTECTÉ*

💎 *Paire :* \`${opp.symbol}\`
📈 *Spread :* \`+${opp.spreadPct.toFixed(2)}%\`
💰 *Profit net :* \`+${opp.netProfit.toFixed(2)} USDT\`
🏦 *Capital :* \`${opp.capital} USDT\`

🔽 *Acheter sur :* \`${opp.buyExchange}\` à $${formatPrice(opp.buyPrice)}
🔼 *Vendre sur :* \`${opp.sellExchange}\` à $${formatPrice(opp.sellPrice)}


🕐 _${time} (Paris)_
_ArbiScan — arbiscan-f4fk.onrender.com_`;
}

function formatPrice(n) {
  if (!n) return '—';
  if (n > 1000) return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return parseFloat(n).toFixed(4);
}

// Envoie un message Telegram
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠ Telegram non configuré (TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant)');
    return false;
  }

  try {
    const url  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const data = await resp.json();
    if (!data.ok) {
      console.error('Telegram error:', data.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram fetch error:', err.message);
    return false;
  }
}

// Traite une liste d'opportunités et envoie les alertes si seuil atteint
async function processAlerts(opportunities, minSpreadPct = 2.0) {
  let sent = 0;
  for (const opp of opportunities) {
    if (opp.spreadPct < minSpreadPct) continue;

    const key = `${opp.symbol}:${opp.buyExchange}:${opp.sellExchange}`;
    if (!canAlert(key)) continue;

    const ok = await sendTelegram(formatSignalMessage(opp));
    if (ok) {
      markAlerted(key);
      sent++;
      console.log(`📨 Alerte Telegram envoyée : ${opp.symbol} +${opp.spreadPct.toFixed(2)}%`);
    }

    // Max 3 alertes par vague pour éviter le spam
    if (sent >= 3) break;
  }
  return sent;
}

// Message de démarrage
async function sendStartupMessage() {
  const text = `✅ *ArbiScan démarré*\n\nSurveillance active sur 1041 paires\nAlertes déclenchées à partir de *spread > 2%*\n\n_Les signaux arriveront ici automatiquement._`;
  await sendTelegram(text);
}

module.exports = { processAlerts, sendTelegram, sendStartupMessage };
