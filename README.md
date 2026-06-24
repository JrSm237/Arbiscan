# ArbiScan — Signaux d'Arbitrage Crypto en Temps Réel

Plateforme de détection d'opportunités d'arbitrage utilisant **CCXT** pour agréger les prix de 6 exchanges simultanément.

## Stack
- **Backend** : Node.js + Express + CCXT
- **Frontend** : HTML/CSS/JS vanilla (servi par Express)
- **Data** : APIs publiques (pas de clé API requise)

## Exchanges surveillés
Binance · Bybit · OKX · Kraken · KuCoin · Gate.io

## Installation

```bash
cd arbiscan
npm install
cp .env.example .env
npm start
```

Le site est disponible sur **http://localhost:3000**

## Comment ça marche

1. Le frontend envoie une requête POST `/api/scan` avec tes paramètres
2. Le backend fetch les prix en parallèle sur tous les exchanges via CCXT
3. Il calcule les spreads et filtre les opportunités au-dessus du seuil
4. Les signaux sont triés par profit net et renvoyés au frontend

## Routes API

| Route | Méthode | Description |
|---|---|---|
| `/api/scan` | POST | Scan complet d'arbitrage |
| `/api/ticker?symbol=BTC/USDT` | GET | Prix d'une paire sur tous les exchanges |
| `/api/exchanges` | GET | Liste exchanges et paires supportés |

### Body POST /api/scan
```json
{
  "minSpread": 0.5,
  "capital": 1000,
  "pairs": ["BTC/USDT", "ETH/USDT"],
  "exchanges": ["binance", "bybit", "okx"]
}
```

## Déploiement

### Railway (backend + frontend)
```bash
# Installer Railway CLI
npm install -g @railway/cli
railway login
railway new
railway up
```

### Variables d'environnement Railway
```
PORT=3000
```

## Paramètres
- **Spread minimum** : filtre les petits écarts (recommandé : 0.5–1%)
- **Capital** : utilisé pour calculer le profit estimé en USDT
- **Auto-scan** : rafraîchissement automatique toutes les 30 secondes

## Avertissement
Les données sont réelles mais les signaux sont indicatifs. L'arbitrage réel nécessite des comptes sur chaque exchange, des fonds disponibles, et une exécution quasi-instantanée. Les frais de retrait/transfert peuvent annuler les profits.
