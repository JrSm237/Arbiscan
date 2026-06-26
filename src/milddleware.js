// ── MIDDLEWARE AUTH ───────────────────────────────────────────────────────────
const jwt    = require('jsonwebtoken');
const { checkPremium } = require('./auth');

const JWT_SECRET = process.env.JWT_SECRET || 'arbiscan-secret-change-in-prod';

// Générer un token JWT
function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Vérifier le token JWT depuis les headers ou cookies
function verifyToken(req) {
  const auth   = req.headers.authorization || '';
  const cookie = req.cookies?.token || '';
  const token  = auth.replace('Bearer ', '') || cookie;
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// Middleware : route accessible uniquement si connecté
function requireAuth(req, res, next) {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Non authentifié' });
  req.user = user;
  next();
}

// Middleware : route accessible uniquement si premium
async function requirePremium(req, res, next) {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Non authentifié' });

  const isPremium = await checkPremium(user.id);
  if (!isPremium) {
    return res.status(403).json({
      error: 'Accès premium requis',
      upgrade_url: '/premium',
    });
  }

  req.user    = user;
  req.premium = true;
  next();
}

// Middleware : limite le scan pour les non-premium
function scanLimit(req, res, next) {
  const user = verifyToken(req);
  req.user   = user;

  if (!user) {
    // Non connecté : scan très limité
    req.body.pairLimit = Math.min(req.body.pairLimit || 10, 10);
    req.body.exchanges = ['binance', 'bybit', 'okx'];
    req.isGuest = true;
  }
  // Premium et connecté : pas de limite
  next();
}

module.exports = { generateToken, verifyToken, requireAuth, requirePremium, scanLimit };
