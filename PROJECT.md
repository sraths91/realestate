# PropScout — Real Estate Analytics Platform

A real estate analytics tool that aggregates data from multiple APIs to give agents and investors instant property valuations, deal scoring, neighborhood momentum analysis, and shareable client reports.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Express.js 4.21 on Node.js |
| Frontend | Vanilla JavaScript (no framework) |
| Maps | Leaflet.js 1.9.4 + MarkerCluster |
| Charts | Canvas 2D (custom rendering) |
| Geocoding | OpenStreetMap Nominatim (free) |
| Styling | Custom CSS with dark theme |
| Data APIs | RapidAPI (Zillow + Realtor.com), RentCast, Census ACS, Walk Score, FBI Crime |

## Quick Start

```bash
git clone https://github.com/sraths91/realestate.git
cd realestate
npm install
cp .env.example .env    # fill in API keys (all optional)
npm start               # http://localhost:4000
```

All API keys are optional — the app runs in **Demo Mode** with realistic synthetic data when no keys are configured.

## API Keys

| Key | Source | Free Tier | Used For |
|-----|--------|-----------|----------|
| `RAPIDAPI_KEY` | [RapidAPI](https://rapidapi.com) | ~200 calls/mo | Zillow + Realtor.com property data |
| `RENTCAST_API_KEY` | [RentCast](https://developers.rentcast.io) | 50 calls/mo | Valuations, rent estimates, market analytics |
| `WALKSCORE_API_KEY` | [Walk Score](https://www.walkscore.com/professional/api.php) | 5,000/day | Walkability scores for Momentum tab |

Census ACS and FBI Crime APIs are free with no key required.

## Features

### 1. Property Search
Enter any US address to get property details, automated valuation (AVM), comparable properties, and an interactive map. Data cascades through Zillow → Realtor.com → RentCast.

### 2. Property Scanner
Set criteria (location, price, beds, baths, type) and scan available listings. Each listing gets a **Deal Score** (0-100) based on price efficiency, days on market, and construction age. Enhanced with **Deal Pulse** — price reduction predictions and offer timing.

### 3. Interactive Map
Search any address, draw a radius, and find similar homes nearby. Leaflet maps with marker clustering and dark-themed tiles.

### 4. Market Analytics
Zip-code-level market statistics: median sale price, rental data, inventory, days on market, and a 12-month price trend chart.

### 5. Neighborhood Momentum Score
Composite 0-100 score showing which neighborhoods are trending up or down. Aggregates free public data:
- **Price Trend** (25%) — market appreciation trajectory
- **Walkability** (15%) — Walk Score API
- **Safety** (20%) — FBI crime data (inverse-scaled)
- **Income** (15%) — Census median household income
- **Affordability** (25%) — income-to-home-price ratio

### 6. Deal Pulse
Intelligent deal analysis on every scanned listing:
- **Hot / Warm / Cold** deal classification
- Price reduction probability (%)
- Offer timing recommendation (Now / Wait / Watch)
- Market position indicator (Underpriced / Fair / Overpriced)

### 7. Client Command Center
Save properties, track value changes over time, and share curated lists with clients via shareable links. Print-friendly report generation.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (Vanilla JS SPA)                    │
│  ┌─────┬─────────┬─────┬──────────┬───────┐ │
│  │Search│ Scanner │ Map │Analytics │Momentum│ │
│  └──┬──┴────┬────┴──┬──┴────┬─────┴───┬───┘ │
│     └───────┴───────┴───────┴─────────┘      │
│              fetch('/api/...')                │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  Express.js (server.js)                      │
│  ┌──────────────────────────────────┐        │
│  │  24-hour In-Memory Cache (Map)   │        │
│  └──────────────┬───────────────────┘        │
│                 │                             │
│  ┌──────────────▼───────────────────┐        │
│  │  API Cascade (per endpoint):     │        │
│  │  1. Zillow (RapidAPI)            │        │
│  │  2. Realtor.com (RapidAPI)       │        │
│  │  3. RentCast                     │        │
│  │  4. Census ACS (free)            │        │
│  │  5. Walk Score                   │        │
│  │  6. FBI Crime API (free)         │        │
│  │  7. Demo Data Fallback           │        │
│  └──────────────────────────────────┘        │
└──────────────────────────────────────────────┘
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/property-lookup?address=` | Property details + valuation (cascade) |
| GET | `/api/listings-lookup?location=&...` | For-sale listings with Deal Pulse (cascade) |
| GET | `/api/rentcast/market?zipCode=` | Market analytics (RentCast only) |
| GET | `/api/momentum?zipCode=&lat=&lon=` | Neighborhood momentum score |
| GET | `/api/geocode?q=` | Forward geocoding (Nominatim) |
| GET | `/api/reverse-geocode?lat=&lon=` | Reverse geocoding (Nominatim) |
| GET | `/api/health` | Server status + active data sources |
| GET | `/api/cache/stats` | Cache entry count |

## Project Structure

```
realtor-tool/
├── server.js           Express API + cache + multi-source cascade
├── public/
│   ├── index.html      Single-page app shell (6 tabs)
│   ├── app.js          Frontend logic, state, rendering, demo data
│   └── style.css       Dark theme, responsive layout
├── .env                API keys (gitignored)
├── .env.example        Key descriptions + signup URLs
├── package.json        Express + cors + dotenv
└── PROJECT.md          This file
```

## Roadmap

- [ ] Persistent saved properties (backend storage)
- [ ] User accounts with personalized dashboards
- [ ] Email alerts for price drops on saved properties
- [ ] Neighborhood comparison (side-by-side momentum scores)
- [ ] Historical momentum trend charts
- [ ] PDF report generation for client presentations
- [ ] Mobile-optimized touch interactions
