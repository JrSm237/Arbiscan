-- ── SCHÉMA SUPABASE ARBISCAN ──────────────────────────────────────────────────
-- Coller dans Supabase → SQL Editor → Run

-- Table utilisateurs
CREATE TABLE IF NOT EXISTS users (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  name         TEXT,
  phone        TEXT,
  telegram_id  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Table abonnements
CREATE TABLE IF NOT EXISTS subscriptions (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  status         TEXT NOT NULL DEFAULT 'inactive', -- active | inactive | expired
  plan           TEXT NOT NULL DEFAULT 'premium',  -- standard | premium | diamond
  payment_method TEXT,  -- cinetpay | usdt_trc20 | usdt_manual
  payment_ref    TEXT,
  started_at     TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Table logs paiements
CREATE TABLE IF NOT EXISTS payment_logs (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID REFERENCES users(id),
  plan           TEXT,
  amount_usd     NUMERIC,
  amount_fcfa    NUMERIC,
  payment_method TEXT,
  payment_ref    TEXT,
  status         TEXT, -- pending | success | failed
  raw_data       JSONB,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_subs_user    ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_status  ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subs_expires ON subscriptions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);

-- RLS (Row Level Security)
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_logs   ENABLE ROW LEVEL SECURITY;

-- Policies : accès service key uniquement (backend)
CREATE POLICY "service_only_users" ON users
  USING (auth.role() = 'service_role');
CREATE POLICY "service_only_subs" ON subscriptions
  USING (auth.role() = 'service_role');
CREATE POLICY "service_only_logs" ON payment_logs
  USING (auth.role() = 'service_role');
