# PropScout — Real Estate Analytics Platform

A real estate analytics tool that aggregates data from multiple APIs to give agents and investors instant property valuations, deal scoring, neighborhood momentum analysis, and shareable client reports.

**Production**: https://realestate-production-7762.up.railway.app

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Express.js 4.21 on Node.js |
| Database | SQLite (better-sqlite3) for historical data + ZHVI cache |
| Frontend | Vanilla JavaScript (no framework) |
| Maps | Leaflet.js 1.9.4 + MarkerCluster + Leaflet.heat |
| Charts | Canvas 2D (custom rendering) |
| Geocoding | OpenStreetMap Nominatim (free) |
| Styling | Custom CSS with dark theme |
| Data APIs | RapidAPI (Zillow + Realtor.com), RentCast, Census ACS, Walk Score, FBI Crime, Zillow ZHVI CSV, GreatSchools |

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
| `GREATSCHOOLS_API_KEY` | [GreatSchools](https://www.greatschools.org/api/) | Free (non-commercial) | School ratings for Momentum tab |

Census ACS, FBI Crime, Zillow ZHVI CSV, and FCC geocoding are free with no key required.

## Features

### 1. Property Search
Enter any US address to get property details, automated valuation (AVM), comparable properties, and an interactive map. Data cascades through Zillow → Realtor.com → RentCast.

### 2. Property Scanner
Set criteria (location, price, beds, baths, type) and scan available listings. Each listing gets a **Deal Score** (0-100) based on price efficiency, days on market, and construction age. Enhanced with **Deal Pulse** — price reduction predictions and offer timing.

### 3. Interactive Map + Neighborhood Heatmap
Search any address, draw a radius, and find similar homes nearby. Leaflet maps with marker clustering and dark-themed tiles. Toggle the **Heatmap** overlay to visualize census tract-level data across the visible area:
- **Home Value** — median home value by tract
- **Affordability** — income-to-home-price ratio
- **Momentum Score** — composite neighborhood score
- **Population Density** — tract population

Uses Census ACS tract data (free, no key) + FCC geocoding API for tract identification. Auto-refreshes as you pan/zoom. Blue→Green→Yellow→Red gradient with live stats legend.

### 4. Market Analytics
Zip-code-level market statistics: median sale price, rental data, inventory, days on market, and a 12-month price trend chart.

### 5. Neighborhood Momentum Score v2
Composite 0-100 score with **real year-over-year trend analysis** across 6 dimensions. All trends are computed from actual historical data, not heuristic estimates.

| Factor | Weight | Data Source | Trend Type |
|--------|--------|-------------|------------|
| **Price Velocity** | 25% | Zillow ZHVI CSV (26,300 zips), Census ACS fallback | Real Y-o-Y % change |
| **Affordability** | 20% | Census ACS (income/home-value ratio) | Point-in-time |
| **Safety** | 15% | FBI Crime Data (2019-2022) | Multi-year direction |
| **Demand Signals** | 15% | Census ACS Y-o-Y (vacancy change + population growth) | Real Y-o-Y |
| **Income Growth** | 15% | Census ACS Y-o-Y (median income change) | Real Y-o-Y |
| **Walkability** | 10% | Walk Score API (or Schools if GreatSchools configured) | Point-in-time |

Key capabilities:
- **Trend drivers**: Auto-generates "driven by +4.2% price growth and declining crime" narratives
- **ZHVI price history**: Shows current value, 1/3/5-year comparisons from Zillow data
- **Historical snapshots**: SQLite stores every query — future lookups show "up 5 points since last check"
- **Agent-ready output**: "This neighborhood scores 55/100, trending up, driven by 3.5% price velocity and 11.3% income growth"

### 6. Deal Pulse
Intelligent deal analysis on every scanned listing:
- **Hot / Warm / Cold** deal classification
- Price reduction probability (%)
- Offer timing recommendation (Now / Wait / Watch)
- Market position indicator (Underpriced / Fair / Overpriced)

### 7. Client Command Center
Save properties, track value changes over time, and share curated lists with clients via shareable links.

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
│  │  SQLite DB (historical data)     │        │
│  └──────────────┬───────────────────┘        │
│                 │                             │
│  ┌──────────────▼───────────────────┐        │
│  │  Data Sources:                   │        │
│  │  1. Zillow (RapidAPI)            │        │
│  │  2. Realtor.com (RapidAPI)       │        │
│  │  3. RentCast                     │        │
│  │  4. Census ACS (free, Y-o-Y)    │        │
│  │  5. Walk Score                   │        │
│  │  6. FBI Crime (free, multi-yr)   │        │
│  │  7. Zillow ZHVI CSV (free)       │        │
│  │  8. GreatSchools (optional)      │        │
│  │  9. FCC Census Area (free)       │        │
│  │ 10. Demo Data Fallback           │        │
│  └──────────────────────────────────┘        │
└──────────────────────────────────────────────┘
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/property-lookup?address=` | Property details + valuation (cascade) |
| GET | `/api/listings-lookup?location=&...` | For-sale listings with Deal Pulse (cascade) |
| GET | `/api/rentcast/market?zipCode=` | Market analytics (RentCast only) |
| GET | `/api/momentum?zipCode=&lat=&lon=&state=` | Momentum score v2 (6 factors, Y-o-Y trends) |
| GET | `/api/heatmap?lat=&lon=&radius=&metric=` | Tract-level heatmap data |
| GET | `/api/geocode?q=` | Forward geocoding (Nominatim) |
| GET | `/api/reverse-geocode?lat=&lon=` | Reverse geocoding (Nominatim) |
| GET | `/api/health` | Server status + data sources + ZHVI count |
| GET | `/api/cache/stats` | Cache entry count |

## Project Structure

```
realtor-tool/
├── server.js           Express API + cache + multi-source cascade + SQLite
├── data/
│   └── propscout.db    SQLite (momentum snapshots + ZHVI cache, gitignored)
├── public/
│   ├── index.html      Single-page app shell (6 tabs)
│   ├── app.js          Frontend logic, state, rendering, demo data
│   └── style.css       Dark theme, responsive layout
├── .env                API keys (gitignored)
├── .env.example        Key descriptions + signup URLs
├── package.json        Express + cors + dotenv + better-sqlite3
└── PROJECT.md          This file
```

## Deployment (Railway)

**Production URL**: https://realestate-production-7762.up.railway.app

### Railway Volume (Required)
The app uses SQLite for historical momentum snapshots and ZHVI cache data. **You must attach a Railway volume** so this data persists across deploys:

1. In Railway dashboard → your service → **Volumes** tab
2. Click **New Volume**
3. Mount path: `/data`
4. Set env var: `DATA_DIR=/data`

Without a volume, the ZHVI cache (~26K zip codes) re-downloads on every deploy (~120MB) and historical snapshots are lost.

### Environment Variables (Railway)
```
PORT=4000                          # Railway sets this automatically
DATA_DIR=/data                     # Must match volume mount path
RAPIDAPI_KEY=...                   # Optional
RENTCAST_API_KEY=...               # Optional
WALKSCORE_API_KEY=...              # Optional
GREATSCHOOLS_API_KEY=...           # Optional
```

### Startup Behavior
1. Server starts, initializes SQLite at `$DATA_DIR/propscout.db`
2. Background: downloads Zillow ZHVI CSV (~120MB, ~26K zips)
3. ZHVI data cached in SQLite for 7 days (skips download if fresh)
4. Server is fully functional immediately (ZHVI lookup gracefully degrades to Census data while downloading)

## Momentum Score Data Pipeline

On startup, the server downloads the Zillow ZHVI CSV (~120MB) and loads 26,300 zip codes into SQLite. This provides real price velocity data (Y-o-Y % change) for every zip in the US. The data is cached for 7 days.

When a user queries a zip code, the server:
1. Fetches Census ACS 2022 + 2021 data in parallel (Y-o-Y comparison)
2. Looks up ZHVI data from SQLite (instant)
3. Fetches FBI Crime data (multi-year rates for trend direction)
4. Fetches Walk Score + GreatSchools if configured
5. Computes weighted composite score with real trend analysis
6. Saves snapshot to SQLite for historical comparison
7. Returns score, drivers, ZHVI history, and prior snapshot diff

## Roadmap

### Phase 2: Make Deal Pulse Credible
- [ ] Collect listing snapshots — store prices at scan time, detect actual reductions
- [ ] Days-to-sell estimate from RentCast median DOM data
- [ ] Auto-generated comp narrative ("3 of 5 comps sold above asking in <14 DOM")
- [ ] Calibrate heuristic thresholds against historical Zillow/Redfin CSV data
- [ ] Bidding war probability signal

### Phase 3: Client Command Center
- [ ] SQLite backend for saved properties (persistent, synced across devices)
- [ ] Persistent shareable links (UUID-based, server-side resolution)
- [ ] Investment calculator (mortgage, cap rate, cash-on-cash, gross yield)
- [ ] PDF report generation (branded, print-friendly)
- [ ] User accounts with login
- [ ] Live price-drop alerts

### Phase 4: Polish + Differentiation
- [ ] Side-by-side neighborhood momentum comparison
- [ ] Historical momentum trend charts (using stored snapshots)
- [ ] White-labeled client portals
- [ ] Value tracker — document agent contributions (showings, negotiations)
- [ ] Email delivery for market reports
- [ ] Mobile-optimized touch interactions
