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

### 6. Deal Pulse v2
Market-aware deal analysis on every scanned listing, powered by historical data and RentCast market context:

**Core Signals:**
- **Hot / Warm / Cold** deal classification (score 0-100)
- **Price reduction probability** — blends historical zip-level drop rates (from listing snapshots) with DOM and price ratio signals
- **Offer timing** — Now / Wait / Watch based on market velocity and price position
- **Market position** — Underpriced / Fair / Overpriced using blended scan + market ratios
- **Days-to-sell estimate** — based on RentCast market median DOM, adjusted for price position
- **Bidding war probability** — composite signal from DOM, inventory, price position, and comp velocity

**Deal Score Algorithm:**
| Factor | Max Points | Source |
|--------|-----------|--------|
| Price efficiency | +/-30 | Blended scan (60%) + market (40%) price/sqft ratio |
| DOM signal | +18 | Listing DOM vs market median DOM |
| Price history | +15 | Actual price drops from stored snapshots |
| Construction age | +5 | Year built (2015+ = +5, 2000+ = +3) |

**Comp Narrative:**
Auto-generated market insight paragraph with supporting bullet points. Analyzes the full listing set to produce agent-ready summaries like: *"12 comparable properties range from $285K-$495K, with the majority moving in under 2 weeks, and 3 sellers have already cut prices."*

**Listing Snapshots:**
Every scan saves listings to SQLite (`listing_snapshots` table). Re-scanning the same area detects actual price reductions across visits. Historical drop rates feed back into probability calculations.

**Market Context:**
RentCast market data (median DOM, price, inventory) cached in SQLite for 7 days. When available, Deal Pulse uses market-relative scoring instead of scan-only heuristics.

### 7. Client Command Center
Server-side property portfolio management with persistent shareable links and a full investment calculator.

**Saved Properties (API-backed):**
- Save any property from Search or Scanner — persisted in SQLite, synced instantly
- One-time migration from localStorage on first load (backward compatible)
- Add notes per property, track current vs saved price
- Bulk refresh — re-fetches current prices from Zillow/Realtor/RentCast cascade
- localStorage kept as offline fallback

**Portfolio Sharing:**
- Create named portfolios from saved properties
- Each portfolio gets a permanent UUID link (`/p/{uuid}`)
- Branded standalone client view — dark theme, property cards with price tracking
- Print/PDF button for clean black-on-white reports
- Legacy `?shared=base64` links still supported

**Investment Calculator:**
- Full mortgage + ROI analysis per saved property
- Inputs: purchase price, monthly rent, down payment %, interest rate, loan term, expense ratio
- Outputs: monthly mortgage, cash flow, cap rate, cash-on-cash return, gross yield, DSCR, break-even occupancy, 1% rule pass/fail
- Real-time client-side calculation + server endpoint for portfolio views
- Print-friendly report layout

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
| GET | `/api/listings-lookup?location=&...` | For-sale listings with Deal Pulse v2 + comp narrative |
| GET | `/api/rentcast/market?zipCode=` | Market analytics (RentCast only) |
| GET | `/api/momentum?zipCode=&lat=&lon=&state=` | Momentum score v2 (6 factors, Y-o-Y trends) |
| GET | `/api/heatmap?lat=&lon=&radius=&metric=` | Tract-level heatmap data |
| GET | `/api/geocode?q=` | Forward geocoding (Nominatim) |
| GET | `/api/reverse-geocode?lat=&lon=` | Reverse geocoding (Nominatim) |
| GET | `/api/saved` | List all saved properties |
| POST | `/api/saved` | Save a property (deduplicates by address) |
| PUT | `/api/saved/:id` | Update notes or current price |
| DELETE | `/api/saved/:id` | Remove a saved property |
| POST | `/api/saved/refresh` | Bulk refresh current prices via property cascade |
| POST | `/api/portfolios` | Create shareable portfolio (returns UUID link) |
| GET | `/api/portfolios/:id` | Fetch portfolio with full property details |
| GET | `/p/:uuid` | Branded client portfolio view (standalone HTML) |
| POST | `/api/investment/calculate` | Investment calculator (mortgage + ROI analysis) |
| GET | `/api/health` | Server status + data sources + DB counts |
| GET | `/api/cache/stats` | Cache entry count |

## Project Structure

```
realtor-tool/
├── server.js           Express API + cache + multi-source cascade + SQLite
├── data/
│   └── propscout.db    SQLite (6 tables: momentum_snapshots, zhvi_data, listing_snapshots, market_context_cache, saved_properties, portfolios)
├── public/
│   ├── index.html      Single-page app shell (6 tabs) + investment calculator modal
│   ├── app.js          Frontend logic, state, rendering, demo data
│   ├── style.css       Dark theme, responsive layout, print styles
│   └── portfolio.html  Standalone branded client portfolio view
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

### Phase 2: Make Deal Pulse Credible ✓
- [x] Listing snapshots in SQLite — store prices at scan time, detect actual reductions
- [x] Days-to-sell estimate from RentCast median DOM data
- [x] Auto-generated comp narrative with confidence levels
- [x] Market-aware scoring — blended scan + RentCast market ratios
- [x] Bidding war probability signal (DOM + inventory + price position)
- [x] Historical zip-level price drop rates from snapshot database
- [ ] Calibrate thresholds against historical Zillow/Redfin CSV data (future)

### Phase 3: Client Command Center ✓
- [x] SQLite backend for saved properties (persistent, server-side CRUD)
- [x] Persistent shareable portfolio links (UUID-based, server-side resolution)
- [x] Investment calculator (mortgage, cap rate, cash-on-cash, DSCR, gross yield, 1% rule)
- [x] Branded client portfolio page (`/p/:uuid`) with print/PDF support
- [x] Bulk price refresh from property lookup cascade
- [x] One-time localStorage → server migration (backward compatible)
- [ ] User accounts with login (future)
- [ ] Live price-drop alerts (future)

### Phase 4: Smart Alerts + Saved Search Engine
*Make PropScout a daily-check tool instead of an occasional lookup.*

**Saved Searches:**
- [ ] `saved_searches` SQLite table — persist Scanner filter configurations (location, price range, beds, baths, type)
- [ ] Save/load/delete search presets from Scanner tab
- [ ] Re-run saved searches on demand with one click

**Automated Detection (Background Jobs):**
- [ ] `alerts` SQLite table — (id, type, search_id, property_id, data JSON, read, created_at)
- [ ] Background scan loop (`setInterval` every 6 hours) — re-runs saved searches, diffs against `listing_snapshots`
- [ ] Price drop detection — flag listings whose price decreased since last snapshot
- [ ] New listing detection — flag listings not present in previous scan for a saved search
- [ ] Momentum score change alerts — weekly re-compute for saved zips, flag +/-5 point moves

**Alert UI:**
- [ ] Notification bell icon in header with unread badge count
- [ ] Alert drawer/panel — grouped by type (price drops, new listings, momentum changes)
- [ ] Mark read/dismiss individual alerts
- [ ] `GET /api/alerts` — returns alerts since last check, supports `?unread=true`
- [ ] `GET /api/digest` — daily digest endpoint aggregating all alert types

**Why this phase first:** Alerts create a daily check-in habit. Without them, users Google "property lookup" and forget PropScout exists. Every competitor (PropStream, Privy, Redfin) has alert systems — this is table stakes for retention.

### Phase 5: Market Report Generator + AI Narratives
*Give agents a shareable artifact no free tool produces.*

**One-Click Property Report:**
- [ ] Server-side HTML → PDF generation (puppeteer or html-pdf-node)
- [ ] Report sections: property summary with photo, 3-6 comps on map, price trend chart (ZHVI), momentum score with drivers, Deal Pulse signals, investment calculator results
- [ ] `POST /api/reports/property/:id` — generates PDF, returns download URL
- [ ] Report stored in `/data/reports/` with 30-day expiry

**Neighborhood Comparison Report:**
- [ ] Side-by-side 2-3 zip codes with momentum scores, ZHVI price history, safety, walkability, affordability
- [ ] Comparison table + radar chart (6 momentum dimensions per zip)
- [ ] `POST /api/reports/compare` — accepts array of zip codes

**AI Narrative Summary:**
- [ ] LLM-generated paragraph per property/neighborhood synthesizing all data points
- [ ] Example: *"This 3BR in 78702 is priced 12% below median. The neighborhood scores 72/100 on momentum, driven by 5.1% YoY price growth and declining vacancy. Deal Pulse estimates a 68% chance of further price reduction within 30 days."*
- [ ] `POST /api/ai/narrative` — accepts property + market data, returns prose
- [ ] Optional `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` env var (falls back to template-based narrative without key)

**Agent Branding:**
- [ ] `agent_profiles` SQLite table — name, email, phone, logo URL, brand color, tagline
- [ ] Branding applied to all PDF reports, portfolio pages, and email shares
- [ ] Logo upload endpoint (`POST /api/agent/profile` with multipart form)
- [ ] QR code on PDF linking to live portfolio dashboard

**Why this phase second:** Shareable reports drive viral adoption — agents send them to clients, clients share with friends. Momentum + Deal Pulse data in a branded PDF is something no free tool (Zillow, Redfin, Realtor.com) offers.

### Phase 6: Rental Revenue Analyzer + Enhanced Investment Suite
*Close the Mashvisor gap with rental-specific analysis using existing API data.*

**Rental Comp Lookup:**
- [ ] Surface RentCast nearby rental comps per property — $/sqft, bed/bath match, distance, lease type
- [ ] Rental comp cards in Search tab results (alongside sale comps)
- [ ] `GET /api/rental-comps?address=&radius=` endpoint

**Dual-Strategy Comparison:**
- [ ] Traditional rental vs. short-term rental projections side by side per saved property
- [ ] Traditional: RentCast rent estimate + vacancy rate + expense ratio
- [ ] Short-term: estimated nightly rate × occupancy rate (Census ACS tourism data + seasonal adjustment)
- [ ] Comparison table in investment calculator modal

**Enhanced Heatmap + Analytics:**
- [ ] "Rental Yield" heatmap layer — rent-to-price ratio by census tract (Census ACS median gross rent / median home value)
- [ ] Vacancy rate display in momentum tab and investment calculator
- [ ] Cap rate heatmap layer — estimated cap rates by tract

**Cash Flow Scenario Modeling:**
- [ ] Extend investment calculator with 3 scenarios: conservative / moderate / aggressive
- [ ] Adjustable assumptions per scenario (vacancy, expense ratio, appreciation, rent growth)
- [ ] Side-by-side comparison table with 5-year projections
- [ ] Break-even rent calculator — "What rent do you need to break even at this purchase price?"

**Portfolio-Level Analytics:**
- [ ] Aggregate metrics across all saved properties — total monthly cash flow, average cap rate, portfolio DSCR, weighted CoC return
- [ ] Diversification analysis by zip code and property type
- [ ] Portfolio summary card in saved drawer

**Why this phase third:** Deepens the investor value proposition. Mashvisor charges $50-250/mo for dual-strategy comparison — offering it free with PropScout's existing RentCast + Census data is a major differentiator.

### Phase 7: Lightweight Client CRM + Engagement Tracking
*Turn portfolios from a sharing feature into a relationship management tool.*

**Client Contacts:**
- [ ] `clients` SQLite table — (id, name, email, phone, type: buyer/seller/investor, notes, created_at)
- [ ] Simple client management UI — add/edit/delete contacts
- [ ] Link clients to portfolios — each portfolio assigned to a client

**Portfolio View Tracking:**
- [ ] `client_activity` SQLite table — (id, client_id, portfolio_id, event_type, metadata JSON, created_at)
- [ ] Tracking pixel/endpoint on portfolio pages — log views with timestamp and IP geolocation
- [ ] Agent dashboard: "Client X viewed your portfolio 3 times this week"
- [ ] View count + last viewed timestamp on each shared portfolio

**Email Sharing:**
- [ ] `POST /api/share` — sends branded email with portfolio link + optional PDF attachment
- [ ] Nodemailer integration (same pattern as password reset in UltiStats)
- [ ] Email templates: portfolio share, market report, price drop alert
- [ ] Optional `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` env vars

**Follow-Up Intelligence:**
- [ ] "You shared a portfolio with Jane 7 days ago and she hasn't viewed it — follow up?"
- [ ] Client activity timeline — chronological log of shares, views, alerts per contact
- [ ] Follow-up reminder alerts integrated into Phase 4 alert system

**Natural Language Search:**
- [ ] "Show me 3BR homes under $350K near good schools in Austin" → parsed into Scanner filters via LLM
- [ ] `POST /api/ai/search` — accepts natural language, returns structured filter object
- [ ] Search bar with NL mode toggle (structured filters ↔ free text)
- [ ] Requires `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (falls back to standard filters without key)

**Why this phase last:** Compounds everything — alerts feed client timelines, reports get shared to clients, rental analysis enriches portfolio views. Light CRM + engagement tracking is what makes PropStream sticky at $99/mo. A lightweight version integrated with PropScout's analytics creates the same daily-use loop.

---

### Implementation Priority Rationale

| Phase | Effort | Stickiness Impact | Competitive Edge |
|-------|--------|-------------------|------------------|
| **4: Smart Alerts** | Low-Med | Very High — daily check-in habit | Matches PropStream/Privy alerts |
| **5: Market Reports** | Medium | High — shareable artifacts drive viral growth | Branded PDFs with Momentum + Deal Pulse (unique) |
| **6: Rental Analyzer** | Medium | Med-High — captures investor segment | Closes Mashvisor gap using existing APIs |
| **7: Client CRM** | Medium | Very High — relationship stickiness | Lightweight Follow Up Boss integrated with analytics |

The order follows the **stickiness formula**: `Daily Alerts + Shared Client Artifacts + Compounding Data = Retention`. Alerts first because they create the habit. Reports second because they spread virally. Rental analysis third to deepen investor value. CRM last because it compounds all prior phases into a relationship management loop.
