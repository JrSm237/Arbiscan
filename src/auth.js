// ── MODULE AUTH & ABONNEMENTS ────────────────────────────────────────────────
// Gestion des utilisateurs et vérification des accès premium
// Base de données : Supabase (PostgreSQL)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_ANON   = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SECRET = process.env.SUPABASE_SERVICE_KEY;

// Client admin (opérations serveur)
function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SECRET) return null;
  return createClient(SUPABASE_URL, SUPABASE_SECRET);
}

// ── VÉRIFICATION ACCÈS ────────────────────────────────────────────────────────
async function checkPremium(userId) {
  const sb = getSupabase();
  if (!sb) return false;

  const { data } = await sb
    .from('subscriptions')
    .select('expires_at, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .gte('expires_at', new Date().toISOString())
    .single();

  return !!data;
}

// ── CRÉER / METTRE À JOUR UN USER ─────────────────────────────────────────────
async function upsertUser({ email, phone, name, telegram_id }) {
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from('users')
    .upsert({ email, phone, name, telegram_id, updated_at: new Date().toISOString() },
             { onConflict: 'email' })
    .select()
    .single();

  if (error) { console.error('upsertUser:', error); return null; }
  return data;
}

// ── ACTIVER UN ABONNEMENT ─────────────────────────────────────────────────────
async function activateSubscription(userId, { plan = 'monthly', paymentRef, paymentMethod }) {
  const sb = getSupabase();
  if (!sb) return false;

  const now     = new Date();
  const expires = new Date(now);
  if (plan === 'monthly') expires.setMonth(expires.getMonth() + 1);
  if (plan === 'yearly')  expires.setFullYear(expires.getFullYear() + 1);

  const { error } = await sb
    .from('subscriptions')
    .upsert({
      user_id:        userId,
      status:         'active',
      plan,
      payment_ref:    paymentRef,
      payment_method: paymentMethod,
      started_at:     now.toISOString(),
      expires_at:     expires.toISOString(),
      updated_at:     now.toISOString(),
    }, { onConflict: 'user_id' });

  if (error) { console.error('activateSubscription:', error); return false; }
  return true;
}

// ── RÉCUPÉRER UN USER PAR EMAIL ───────────────────────────────────────────────
async function getUserByEmail(email) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.from('users').select('*').eq('email', email).single();
  return data;
}

// ── LISTER LES ABONNÉS ACTIFS (pour Telegram) ────────────────────────────────
async function getActiveSubscribers() {
  const sb = getSupabase();
  if (!sb) return [];
  const { data } = await sb
    .from('subscriptions')
    .select('user_id, users(telegram_id, email, name)')
    .eq('status', 'active')
    .gte('expires_at', new Date().toISOString());
  return data || [];
}

module.exports = {
  checkPremium,
  upsertUser,
  activateSubscription,
  getUserByEmail,
  getActiveSubscribers,
  getSupabase,
};
