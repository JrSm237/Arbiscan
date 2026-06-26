// ── MODULE PAIEMENTS ─────────────────────────────────────────────────────────
// CinetPay (Mobile Money) + USDT manuel
// Prix : 50 USD/mois

const crypto = require('crypto');

const CINETPAY_APIKEY  = process.env.CINETPAY_APIKEY;
const CINETPAY_SITEID  = process.env.CINETPAY_SITEID;
const USDT_WALLET      = process.env.USDT_WALLET_ADDRESS; // ton adresse TRC20
const APP_URL          = process.env.APP_URL || 'https://arbiscan-f4fk.onrender.com';

// Prix en différentes devises
const PLANS = {
  standard: {
    usd:   10,
    fcfa:  6000,   // ~10 USD en FCFA
    usdt:  10,
    label: 'Standard — 10 USD / semaine',
    days:  7,
    features: [
      '50 signaux par scan',
      '3 exchanges',
      'Alertes Telegram (spread > 2%)',
      'Scan toutes les 5 minutes',
    ],
  },
  premium: {
    usd:   35,
    fcfa:  21000,  // ~35 USD en FCFA
    usdt:  35,
    label: 'Premium — 35 USD / mois',
    days:  30,
    features: [
      'Signaux illimités',
      '10 exchanges',
      'Alertes Telegram temps réel',
      'Scan complet 6101 paires',
      'Auto-scan 60 secondes',
      'Graphiques avancés',
    ],
  },
  diamond: {
    usd:   350,
    fcfa:  210000, // ~350 USD en FCFA
    usdt:  350,
    label: 'Diamond — 350 USD / an',
    days:  365,
    features: [
      'Tout Premium inclus',
      'Accès prioritaire aux nouveaux signaux',
      'Support direct Telegram',
      'Économisez 70 USD vs Premium mensuel',
    ],
  },
};

// ── CINETPAY — Initier un paiement Mobile Money ───────────────────────────────
async function initCinetPay({ plan = 'monthly', userId, email, phone, name }) {
  if (!CINETPAY_APIKEY || !CINETPAY_SITEID) {
    return { error: 'CinetPay non configuré' };
  }

  const p          = PLANS[plan];
  const transId    = `ARB-${userId}-${Date.now()}`;
  const notifyUrl  = `${APP_URL}/api/payments/cinetpay/notify`;
  const returnUrl  = `${APP_URL}/payment-success?ref=${transId}`;
  const cancelUrl  = `${APP_URL}/payment-cancel`;

  try {
    const resp = await fetch('https://api-checkout.cinetpay.com/v2/payment', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey:           CINETPAY_APIKEY,
        site_id:          CINETPAY_SITEID,
        transaction_id:   transId,
        amount:           p.fcfa,
        currency:         'XAF',
        description:      p.label,
        return_url:       returnUrl,
        notify_url:       notifyUrl,
        cancel_url:       cancelUrl,
        customer_email:   email,
        customer_phone_number: phone,
        customer_name:    name,
        channels:         'ALL', // MTN MoMo + Orange Money + Wave
      }),
    });

    const data = await resp.json();
    if (data.code === '201') {
      return {
        success:       true,
        paymentUrl:    data.data.payment_url,
        transactionId: transId,
        amount:        p.fcfa,
        currency:      'XAF',
      };
    }
    return { error: data.message || 'Erreur CinetPay' };
  } catch (err) {
    return { error: err.message };
  }
}

// ── CINETPAY — Vérifier un paiement ──────────────────────────────────────────
async function verifyCinetPay(transactionId) {
  try {
    const resp = await fetch('https://api-checkout.cinetpay.com/v2/payment/check', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey:         CINETPAY_APIKEY,
        site_id:        CINETPAY_SITEID,
        transaction_id: transactionId,
      }),
    });
    const data = await resp.json();
    return {
      success: data.code === '00',
      status:  data.data?.status,
      data:    data.data,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── USDT — Générer les instructions de paiement ───────────────────────────────
function getUSDTInstructions(plan = 'monthly', userId) {
  const p   = PLANS[plan];
  const ref = `ARB-${userId}-${Date.now()}`;
  return {
    wallet:  USDT_WALLET || 'Configurez USDT_WALLET_ADDRESS dans Render',
    network: 'TRC20 (TRON)',
    amount:  p.usdt,
    ref,
    instructions: [
      `1. Envoie exactement ${p.usdt} USDT sur le réseau TRC20`,
      `2. Adresse : ${USDT_WALLET || '— non configurée —'}`,
      `3. Dans le memo/note, mets ta référence : ${ref}`,
      `4. Envoie le hash de transaction à notre Telegram @ArbiScanBot`,
      `5. Ton accès sera activé sous 30 minutes`,
    ],
    ref,
  };
}

// ── VÉRIFICATION HASH USDT (TronScan API) ─────────────────────────────────────
async function verifyUSDTPayment(txHash, expectedAmount) {
  try {
    const resp = await fetch(
      `https://api.trongrid.io/v1/transactions/${txHash}/events`,
      { headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_KEY || '' } }
    );
    const data = await resp.json();
    if (!data.data || !data.data.length) return { success: false, error: 'Transaction non trouvée' };

    const event = data.data.find(e => e.event_name === 'Transfer');
    if (!event) return { success: false, error: 'Pas de transfert USDT' };

    const amount = parseInt(event.result?.value || '0') / 1e6; // USDT a 6 décimales
    const toAddr = event.result?.to;

    if (toAddr?.toLowerCase() !== USDT_WALLET?.toLowerCase()) {
      return { success: false, error: 'Mauvaise adresse de destination' };
    }
    if (amount < expectedAmount) {
      return { success: false, error: `Montant insuffisant: ${amount} USDT reçus, ${expectedAmount} attendus` };
    }

    return { success: true, amount, txHash };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  PLANS,
  initCinetPay,
  verifyCinetPay,
  getUSDTInstructions,
  verifyUSDTPayment,
};
