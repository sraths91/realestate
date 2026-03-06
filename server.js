require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 4000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RENTCAST_KEY = process.env.RENTCAST_API_KEY;
const WALKSCORE_KEY = process.env.WALKSCORE_API_KEY;
const RENTCAST_BASE = 'https://api.rentcast.io/v1';
const GREATSCHOOLS_KEY = process.env.GREATSCHOOLS_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===========================================================================
// SQLite — persistent storage for historical momentum snapshots + ZHVI data
// ===========================================================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'propscout.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS momentum_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zip TEXT NOT NULL,
    score INTEGER NOT NULL,
    trend TEXT,
    factors TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_momentum_zip ON momentum_snapshots(zip, created_at);

  CREATE TABLE IF NOT EXISTS zhvi_data (
    zip TEXT PRIMARY KEY,
    current_value REAL,
    value_1yr_ago REAL,
    value_3yr_ago REAL,
    value_5yr_ago REAL,
    yoy_change REAL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS listing_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_key TEXT NOT NULL,
    address TEXT NOT NULL,
    city TEXT,
    state TEXT,
    zip TEXT,
    price INTEGER NOT NULL,
    price_per_sqft REAL,
    sqft INTEGER,
    bedrooms INTEGER,
    bathrooms REAL,
    property_type TEXT,
    year_built INTEGER,
    days_on_market INTEGER,
    status TEXT,
    source TEXT,
    scan_location TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_listing_key ON listing_snapshots(listing_key, created_at);
  CREATE INDEX IF NOT EXISTS idx_listing_zip ON listing_snapshots(zip, created_at);

  CREATE TABLE IF NOT EXISTS market_context_cache (
    zip TEXT PRIMARY KEY,
    median_dom INTEGER,
    median_price INTEGER,
    avg_ppsf REAL,
    total_inventory INTEGER,
    data_json TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS saved_properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    city TEXT,
    state TEXT,
    zip TEXT,
    bedrooms INTEGER,
    bathrooms REAL,
    sqft INTEGER,
    property_type TEXT,
    year_built INTEGER,
    saved_price INTEGER,
    current_price INTEGER,
    rent_estimate INTEGER,
    latitude REAL,
    longitude REAL,
    img_src TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS portfolios (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    property_ids TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS saved_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    filters TEXT NOT NULL,
    last_run_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    search_id INTEGER,
    property_address TEXT,
    data TEXT,
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (search_id) REFERENCES saved_searches(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_read ON alerts(read, created_at);
`);

// Cleanup old listing snapshots (keep 180 days)
try {
  const deleted = db.prepare("DELETE FROM listing_snapshots WHERE created_at < datetime('now', '-180 days')").run();
  if (deleted.changes > 0) console.log(`Cleaned up ${deleted.changes} old listing snapshots`);
} catch (e) { /* ignore on first run */ }
try {
  const alertsDel = db.prepare("DELETE FROM alerts WHERE created_at < datetime('now', '-90 days')").run();
  if (alertsDel.changes > 0) console.log(`Cleaned up ${alertsDel.changes} old alerts`);
} catch (e) { /* ignore on first run */ }
console.log('SQLite database initialized at', path.join(DATA_DIR, 'propscout.db'));

// ===========================================================================
// CACHE — 24-hour in-memory cache to stretch API calls
// ===========================================================================
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/** @param {string} key */
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/** @param {string} key @param {*} data */
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL) cache.delete(k);
    }
  }
}

// ===========================================================================
// RapidAPI helpers
// ===========================================================================

/**
 * Fetch from RapidAPI Zillow endpoint.
 * Host: zillow-com1.p.rapidapi.com
 */
async function zillowApiFetch(endpoint, params = {}) {
  const url = new URL(`https://zillow-com1.p.rapidapi.com${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetch(url.toString(), {
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'zillow-com1.p.rapidapi.com',
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Zillow API ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

/**
 * Fetch from RapidAPI Realty-in-US (Realtor.com) endpoint.
 * Host: realtor.p.rapidapi.com
 */
async function realtorApiFetch(endpoint, params = {}) {
  const url = new URL(`https://realtor.p.rapidapi.com${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetch(url.toString(), {
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'realtor.p.rapidapi.com',
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Realtor API ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

/**
 * Fetch from RentCast API.
 */
async function rentcastFetch(endpoint, params = {}) {
  const url = new URL(`${RENTCAST_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetch(url.toString(), {
    headers: { 'X-Api-Key': RENTCAST_KEY, Accept: 'application/json' },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`RentCast ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

// ===========================================================================
// PROPERTY LOOKUP — RapidAPI Zillow → Realtor → RentCast → 404
// ===========================================================================

/**
 * Reusable property lookup — cascades through Zillow → Realtor → RentCast.
 * @param {string} address
 * @returns {Object|null} { source, property, valuation?, rentEstimate? }
 */
async function lookupProperty(address) {
  const cacheKey = `lookup:${address.toLowerCase().trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  let result = null;

  // Source 1: RapidAPI Zillow
  if (!result && RAPIDAPI_KEY) {
      try {
        const data = await zillowApiFetch('/propertyExtendedSearch', {
          location: address,
          status_type: 'ForSale',
        });
        // propertyExtendedSearch returns { props: [...] } or similar
        const props = data?.props || data?.results || [];
        const prop = Array.isArray(props) ? props[0] : null;
        if (prop) {
          result = {
            source: 'zillow',
            property: {
              address: prop.streetAddress || prop.address || address,
              city: prop.city || null,
              state: prop.state || null,
              zipCode: prop.zipcode || null,
              propertyType: prop.propertyType || prop.homeType || null,
              bedrooms: prop.bedrooms ?? prop.beds ?? null,
              bathrooms: prop.bathrooms ?? prop.baths ?? null,
              squareFootage: prop.livingArea ?? prop.area ?? null,
              lotSize: prop.lotAreaValue ?? prop.lotSize ?? null,
              yearBuilt: prop.yearBuilt ?? null,
              lastSalePrice: prop.lastSoldPrice ?? null,
              lastSaleDate: prop.lastSoldDate ?? null,
              taxAssessment: prop.taxAssessedValue ?? null,
              latitude: prop.latitude ?? null,
              longitude: prop.longitude ?? null,
              zestimate: prop.zestimate ?? null,
              rentZestimate: prop.rentZestimate ?? null,
              price: prop.price ?? null,
              imgSrc: prop.imgSrc ?? null,
            },
          };
        }

        // If search didn't return, try direct property by zpid
        if (!result && data?.zpid) {
          const detail = await zillowApiFetch('/property', { zpid: data.zpid });
          if (detail) {
            result = {
              source: 'zillow',
              property: normalizeZillowDetail(detail, address),
            };
          }
        }
      } catch (err) {
        console.log('Zillow API failed:', err.message);
      }
    }

    // Source 2: RapidAPI Realtor.com — location autocomplete + property detail
    if (!result && RAPIDAPI_KEY) {
      try {
        // First autocomplete to find the property
        const autoData = await realtorApiFetch('/locations/auto-complete', {
          input: address,
        });
        const autoResults = autoData?.autocomplete || [];
        const match = autoResults.find(r => r.mpr_id || r.id) || autoResults[0];
        if (match && match.mpr_id) {
          const detail = await realtorApiFetch('/properties/v2/detail', {
            property_id: match.mpr_id,
          });
          const prop = detail?.properties?.[0] || detail?.data?.home || {};
          if (prop) {
            const addr = prop.address || {};
            result = {
              source: 'realtor',
              property: {
                address: addr.line || address,
                city: addr.city || null,
                state: addr.state_code || addr.state || null,
                zipCode: addr.postal_code || null,
                propertyType: prop.prop_type || prop.description?.type || null,
                bedrooms: prop.beds ?? prop.description?.beds ?? null,
                bathrooms: prop.baths ?? prop.description?.baths ?? null,
                squareFootage: prop.sqft ?? prop.description?.sqft ?? null,
                lotSize: prop.lot_sqft ?? prop.description?.lot_sqft ?? null,
                yearBuilt: prop.year_built ?? prop.description?.year_built ?? null,
                lastSalePrice: prop.last_sold_price ?? null,
                lastSaleDate: prop.last_sold_date ?? null,
                taxAssessment: null,
                latitude: prop.address?.lat ?? addr.lat ?? null,
                longitude: prop.address?.lon ?? addr.lon ?? null,
                price: prop.list_price ?? prop.price ?? null,
              },
            };
          }
        }
      } catch (err) {
        console.log('Realtor API failed:', err.message);
      }
    }

    // Source 3: RentCast — full property + valuation + rent
    if (!result && RENTCAST_KEY) {
      try {
        const propData = await rentcastFetch('/properties', { address });
        const property = Array.isArray(propData) ? propData[0] : propData;
        if (property) {
          let valuation = null;
          try {
            valuation = await rentcastFetch('/avm/value', { address, compCount: 10 });
          } catch { /* optional */ }

          let rent = null;
          try {
            rent = await rentcastFetch('/avm/rent/long-term', { address, compCount: 10 });
          } catch { /* optional */ }

          result = {
            source: 'rentcast',
            property: {
              address: property.addressLine1 || property.formattedAddress,
              city: property.city,
              state: property.state,
              zipCode: property.zipCode,
              propertyType: property.propertyType,
              bedrooms: property.bedrooms,
              bathrooms: property.bathrooms,
              squareFootage: property.squareFootage,
              lotSize: property.lotSize,
              yearBuilt: property.yearBuilt,
              lastSaleDate: property.lastSaleDate,
              lastSalePrice: property.lastSalePrice,
              taxAssessment: property.taxAssessment,
              latitude: property.latitude,
              longitude: property.longitude,
            },
            valuation: valuation ? {
              price: valuation.price,
              priceRangeLow: valuation.priceRangeLow,
              priceRangeHigh: valuation.priceRangeHigh,
              comparables: valuation.comparables,
            } : null,
            rentEstimate: rent?.rent || null,
          };
        }
      } catch (err) {
        console.log('RentCast failed:', err.message);
      }
    }

    if (!result) return null;

    cacheSet(cacheKey, result);
    return result;
}

app.get('/api/property-lookup', async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'Missing address' });
    const result = await lookupProperty(address);
    if (!result) return res.status(404).json({ error: 'Could not find property data from any source' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Normalize a Zillow property detail response.
 */
function normalizeZillowDetail(detail, fallbackAddr) {
  return {
    address: detail.streetAddress || detail.address?.streetAddress || fallbackAddr,
    city: detail.city || detail.address?.city || null,
    state: detail.state || detail.address?.state || null,
    zipCode: detail.zipcode || detail.address?.zipcode || null,
    propertyType: detail.homeType || null,
    bedrooms: detail.bedrooms ?? detail.beds ?? null,
    bathrooms: detail.bathrooms ?? detail.baths ?? null,
    squareFootage: detail.livingArea ?? null,
    lotSize: detail.lotAreaValue ?? detail.lotSize ?? null,
    yearBuilt: detail.yearBuilt ?? null,
    lastSalePrice: detail.lastSoldPrice ?? null,
    lastSaleDate: detail.lastSoldDate ?? null,
    taxAssessment: detail.taxAssessedValue ?? null,
    latitude: detail.latitude ?? null,
    longitude: detail.longitude ?? null,
    zestimate: detail.zestimate ?? null,
    rentZestimate: detail.rentZestimate ?? null,
    price: detail.price ?? null,
    imgSrc: detail.imgSrc ?? detail.hiResImageLink ?? null,
  };
}

// ===========================================================================
// LISTINGS LOOKUP — RapidAPI Zillow → Realtor → RentCast → null
// ===========================================================================

/**
 * Reusable listing fetch — cascades through Zillow → Realtor → RentCast.
 * @param {Object} filters - {location, city, state, zipCode, minPrice, maxPrice, beds, baths, limit}
 * @returns {Object|null} {source, listings[], compNarrative, marketContext}
 */
async function fetchListings(filters) {
  const { location, city, state, zipCode, minPrice, maxPrice, beds, baths, limit: lim } = filters;
  const loc = location || (city && state ? `${city}, ${state}` : zipCode);
  if (!loc) return null;

  const cacheKey = `listings:${loc}:${JSON.stringify({ minPrice, maxPrice, beds, baths })}`.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  let result = null;

  // Source 1: RapidAPI Zillow
  if (!result && RAPIDAPI_KEY) {
    try {
      const data = await zillowApiFetch('/propertyExtendedSearch', {
        location: loc, status_type: 'ForSale', home_type: 'Houses',
      });
      const props = data?.props || data?.results || [];
      if (Array.isArray(props) && props.length > 0) {
        result = {
          source: 'zillow',
          listings: props.slice(0, 25).map(p => ({
            address: p.streetAddress || p.address || '--',
            city: p.city || null, state: p.state || null, zipCode: p.zipcode || null,
            price: p.price ?? p.unformattedPrice ?? 0,
            bedrooms: p.bedrooms ?? p.beds ?? null, bathrooms: p.bathrooms ?? p.baths ?? null,
            squareFootage: p.livingArea ?? p.area ?? null,
            propertyType: p.propertyType || p.homeType || null, yearBuilt: p.yearBuilt ?? null,
            daysOnMarket: p.daysOnZillow ?? null,
            latitude: p.latitude ?? null, longitude: p.longitude ?? null,
            status: p.listingStatus || 'Active', imgSrc: p.imgSrc ?? null, zestimate: p.zestimate ?? null,
          })),
        };
      }
    } catch (err) { console.log('Zillow listings API failed:', err.message); }
  }

  // Source 2: RapidAPI Realtor.com
  if (!result && RAPIDAPI_KEY) {
    try {
      const params = { limit: lim || 25, offset: 0, sort: 'newest' };
      if (zipCode) { params.postal_code = zipCode; }
      else if (city && state) { params.city = city; params.state_code = state; }
      else {
        const autoData = await realtorApiFetch('/locations/auto-complete', { input: loc });
        const match = autoData?.autocomplete?.[0];
        if (match) { params.city = match.city; params.state_code = match.state_code; }
      }
      if (minPrice) params.price_min = minPrice;
      if (maxPrice) params.price_max = maxPrice;
      if (beds) params.beds_min = beds;
      if (baths) params.baths_min = baths;

      const data = await realtorApiFetch('/properties/v2/list-for-sale', params);
      const props = data?.properties || data?.data?.results || [];
      if (Array.isArray(props) && props.length > 0) {
        result = {
          source: 'realtor',
          listings: props.map(p => {
            const addr = p.address || {};
            return {
              address: addr.line || '--', city: addr.city || null,
              state: addr.state_code || null, zipCode: addr.postal_code || null,
              price: p.list_price ?? p.price ?? 0,
              bedrooms: p.beds ?? p.description?.beds ?? null,
              bathrooms: p.baths ?? p.description?.baths ?? null,
              squareFootage: p.sqft ?? p.building_size?.size ?? null,
              propertyType: p.prop_type || null, yearBuilt: p.year_built ?? null,
              daysOnMarket: null, latitude: addr.lat ?? null, longitude: addr.lon ?? null,
              status: p.prop_status || 'for_sale', imgSrc: p.thumbnail ?? p.photos?.[0]?.href ?? null,
            };
          }),
        };
      }
    } catch (err) { console.log('Realtor listings API failed:', err.message); }
  }

  // Source 3: RentCast
  if (!result && RENTCAST_KEY) {
    try {
      const data = await rentcastFetch('/listings/sale', {
        city, state, zipCode, bedrooms: beds, bathrooms: baths,
        status: 'Active', priceMin: minPrice, priceMax: maxPrice, limit: lim || 25,
      });
      if (Array.isArray(data) && data.length > 0) {
        result = {
          source: 'rentcast',
          listings: data.map(l => ({
            address: l.formattedAddress || l.addressLine1, city: l.city, state: l.state,
            zipCode: l.zipCode, price: l.price, bedrooms: l.bedrooms, bathrooms: l.bathrooms,
            squareFootage: l.squareFootage, propertyType: l.propertyType,
            latitude: l.latitude, longitude: l.longitude,
            daysOnMarket: l.daysOnMarket, yearBuilt: l.yearBuilt, status: l.status,
          })),
        };
      }
    } catch (err) { console.log('RentCast listings failed:', err.message); }
  }

  if (!result) return null;

  // Fetch market context for Deal Pulse enrichment
  let marketContext = null;
  const searchZip = zipCode || result.listings[0]?.zipCode;
  if (searchZip) {
    marketContext = getMarketContext(searchZip);
    if (!marketContext && RENTCAST_KEY) {
      try {
        const data = await rentcastFetch('/markets', { zipCode: searchZip, historyRange: 12 });
        if (data?.saleData || data?.rentalData) {
          const sale = data.saleData || {};
          db.prepare(`INSERT OR REPLACE INTO market_context_cache
            (zip, median_dom, median_price, avg_ppsf, total_inventory, data_json)
            VALUES (?, ?, ?, ?, ?, ?)`).run(searchZip,
            sale.averageDaysOnMarket || sale.medianDaysOnMarket || null,
            sale.medianPrice || sale.averagePrice || null,
            sale.averagePricePerSquareFoot || null,
            sale.totalInventory || null, JSON.stringify(data));
          marketContext = {
            medianDom: sale.averageDaysOnMarket || sale.medianDaysOnMarket,
            medianPrice: sale.medianPrice || sale.averagePrice,
            avgPpsf: sale.averagePricePerSquareFoot,
            totalInventory: sale.totalInventory,
          };
        }
      } catch (err) { console.log('RentCast market context failed:', err.message); }
    }
  }

  // Save listing snapshots and detect price changes
  if (result.listings) {
    result.listings = saveAndEnrichSnapshots(result.listings, loc, result.source);
  }

  // Enrich with Deal Pulse + comp narrative
  if (result.listings) {
    result.listings = enrichWithDealPulse(result.listings, marketContext);
  }
  const compNarrative = generateCompNarrative(result.listings, marketContext);

  const response = {
    ...result, compNarrative,
    marketContext: marketContext ? {
      medianDom: marketContext.medianDom, medianPrice: marketContext.medianPrice,
      avgPpsf: marketContext.avgPpsf, inventory: marketContext.totalInventory,
    } : null,
  };

  cacheSet(cacheKey, response);
  return response;
}

app.get('/api/listings-lookup', async (req, res) => {
  try {
    const result = await fetchListings(req.query);
    if (!result) return res.status(404).json({ error: 'No listings found from any source' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// RentCast direct route (market analytics — requires API key)
// ===========================================================================
function requireRentCast(req, res, next) {
  if (!RENTCAST_KEY) {
    return res.status(503).json({ error: 'RENTCAST_API_KEY not configured.', demo: true });
  }
  next();
}

app.get('/api/rentcast/market', requireRentCast, async (req, res) => {
  try {
    const { zipCode, city, state, historyRange } = req.query;
    const key = `rc-market:${zipCode || city}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);
    const data = await rentcastFetch('/markets', {
      zipCode, city, state, historyRange: historyRange || 12,
    });
    cacheSet(key, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// MOMENTUM SCORE v2 — Real trend analysis with multiple data sources
// Census Y-o-Y + Zillow ZHVI + FBI Crime trends + Walk Score + Schools
// ===========================================================================

/**
 * Fetch Census ACS data by zip code (ZCTA). Free, no key required.
 * Returns median income, median home value, population, vacancy rate.
 */
async function censusApiFetch(zipCode) {
  const cacheKey = `census:${zipCode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const vars = 'B19013_001E,B25077_001E,B01003_001E,B25002_003E,B25002_001E';
  const url = `https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=zip%20code%20tabulation%20area:${zipCode}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!r.ok) throw new Error(`Census API ${r.status}`);
  const data = await r.json();
  if (!data || data.length < 2) throw new Error('No census data for this zip');
  const row = data[1];
  const result = {
    medianIncome: parseInt(row[0]) || null,
    medianHomeValue: parseInt(row[1]) || null,
    population: parseInt(row[2]) || null,
    vacantUnits: parseInt(row[3]) || null,
    totalUnits: parseInt(row[4]) || null,
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Fetch Census ACS data for TWO years (2022 + 2021) to compute Y-o-Y trends.
 * Returns { current, prior, trends } where trends has real percentage changes.
 */
async function censusMultiYearFetch(zipCode) {
  const cacheKey = `census-yoy:${zipCode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const vars = 'B19013_001E,B25077_001E,B01003_001E,B25002_003E,B25002_001E';
  const parseCensusRow = (row) => ({
    medianIncome: parseInt(row[0]) || null,
    medianHomeValue: parseInt(row[1]) || null,
    population: parseInt(row[2]) || null,
    vacantUnits: parseInt(row[3]) || null,
    totalUnits: parseInt(row[4]) || null,
  });

  const fetchYear = async (year) => {
    try {
      const url = `https://api.census.gov/data/${year}/acs/acs5?get=${vars}&for=zip%20code%20tabulation%20area:${zipCode}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
      if (!r.ok) return null;
      const data = await r.json();
      if (!data || data.length < 2) return null;
      return parseCensusRow(data[1]);
    } catch { return null; }
  };

  const [current, prior] = await Promise.all([fetchYear(2022), fetchYear(2021)]);

  const result = { current, prior, trends: {} };

  if (current && prior) {
    if (current.medianIncome && prior.medianIncome) {
      result.trends.incomeChange = +((current.medianIncome - prior.medianIncome) / prior.medianIncome * 100).toFixed(1);
    }
    if (current.medianHomeValue && prior.medianHomeValue) {
      result.trends.homeValueChange = +((current.medianHomeValue - prior.medianHomeValue) / prior.medianHomeValue * 100).toFixed(1);
    }
    if (current.population && prior.population) {
      result.trends.populationChange = +((current.population - prior.population) / prior.population * 100).toFixed(1);
    }
    if (current.vacantUnits != null && prior.vacantUnits != null && current.totalUnits && prior.totalUnits) {
      const curVac = current.vacantUnits / current.totalUnits;
      const priorVac = prior.vacantUnits / prior.totalUnits;
      result.trends.vacancyChange = +((curVac - priorVac) * 100).toFixed(2);
    }
  }

  cacheSet(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Zillow ZHVI — Home Value Index CSV (free, ~30MB download)
// ---------------------------------------------------------------------------
const ZHVI_URL = 'https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv';
let zhviLoaded = false;

/** Parse a CSV line handling quoted fields. */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

/** Download Zillow ZHVI CSV and load into SQLite. Runs in background. */
async function downloadAndParseZHVI() {
  try {
    const check = db.prepare("SELECT COUNT(*) as count FROM zhvi_data WHERE updated_at > datetime('now', '-7 days')").get();
    if (check.count > 1000) {
      console.log(`ZHVI: ${check.count} zips cached (fresh)`);
      zhviLoaded = true;
      return;
    }

    console.log('ZHVI: downloading Zillow Home Value Index...');
    const response = await fetch(ZHVI_URL, { headers: { 'User-Agent': 'PropScout/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const text = await response.text();
    const lines = text.split('\n');
    const headers = parseCSVLine(lines[0]).map(h => h.trim().replace(/"/g, ''));

    // Find date columns (YYYY-MM-DD format), sorted newest first
    const dateColumns = headers
      .map((h, i) => ({ header: h, index: i }))
      .filter(h => /^\d{4}-\d{2}-\d{2}$/.test(h.header))
      .sort((a, b) => b.header.localeCompare(a.header));

    if (dateColumns.length < 13) throw new Error('Insufficient date columns');

    const latestCol = dateColumns[0].index;
    const oneYearCol = dateColumns[12]?.index;
    const threeYearCol = dateColumns[36]?.index;
    const fiveYearCol = dateColumns[60]?.index;
    const zipCol = headers.findIndex(h => h === 'RegionName');

    const insert = db.prepare(`
      INSERT OR REPLACE INTO zhvi_data (zip, current_value, value_1yr_ago, value_3yr_ago, value_5yr_ago, yoy_change, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = parseCSVLine(lines[i]);
      const zip = (cols[zipCol] || '').trim().replace(/"/g, '').padStart(5, '0');
      if (zip.length !== 5 || !/^\d+$/.test(zip)) continue;

      const current = parseFloat(cols[latestCol]) || null;
      const oneYr = oneYearCol != null ? parseFloat(cols[oneYearCol]) || null : null;
      const threeYr = threeYearCol != null ? parseFloat(cols[threeYearCol]) || null : null;
      const fiveYr = fiveYearCol != null ? parseFloat(cols[fiveYearCol]) || null : null;
      const yoyChange = current && oneYr ? +((current - oneYr) / oneYr * 100).toFixed(1) : null;

      rows.push([zip, current, oneYr, threeYr, fiveYr, yoyChange]);
    }

    // Batch insert in a transaction
    db.transaction(() => { for (const r of rows) insert.run(...r); })();

    console.log(`ZHVI: loaded ${rows.length} zip codes (latest: ${dateColumns[0].header})`);
    zhviLoaded = true;
  } catch (err) {
    console.log('ZHVI download failed (non-critical):', err.message);
  }
}

/** Get ZHVI data for a zip code from SQLite. */
function getZHVIData(zipCode) {
  try {
    return db.prepare('SELECT * FROM zhvi_data WHERE zip = ?').get(zipCode) || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// GreatSchools API — school ratings by location (optional, needs API key)
// ---------------------------------------------------------------------------
async function fetchSchoolRatings(lat, lon) {
  if (!GREATSCHOOLS_KEY) return null;
  const cacheKey = `schools:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://gs-api.greatschools.org/nearby-schools?lat=${lat}&lon=${lon}&limit=10&radius=5`;
    const r = await fetch(url, {
      headers: { 'X-API-Key': GREATSCHOOLS_KEY, 'User-Agent': 'PropScout/1.0' },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const schools = (data.schools || []).filter(s => s.rating != null);
    if (!schools.length) return null;

    const avgRating = schools.reduce((s, sc) => s + sc.rating, 0) / schools.length;
    const result = {
      avgRating: +avgRating.toFixed(1),
      schoolCount: schools.length,
      topSchool: schools.sort((a, b) => b.rating - a.rating)[0]?.name || null,
      topRating: schools.sort((a, b) => b.rating - a.rating)[0]?.rating || null,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch { return null; }
}

/**
 * Fetch Walk Score for a lat/lon. Requires WALKSCORE_API_KEY (free tier: 5000/day).
 */
async function walkScoreFetch(lat, lon, address) {
  if (!WALKSCORE_KEY) return null;
  const cacheKey = `walkscore:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `https://api.walkscore.com/score?format=json&lat=${lat}&lon=${lon}&transit=1&bike=1&wsapikey=${WALKSCORE_KEY}&address=${encodeURIComponent(address || '')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!r.ok) throw new Error(`Walk Score API ${r.status}`);
  const data = await r.json();
  const result = {
    walkscore: data.walkscore ?? null,
    transit: data.transit?.score ?? null,
    bike: data.bike?.score ?? null,
    description: data.description || null,
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Fetch FBI crime data by state abbreviation. Free, no key required.
 * Returns violent + property crime rates per 100k WITH multi-year trend data.
 */
async function crimeApiFetch(stateAbbr) {
  if (!stateAbbr) return null;
  const cacheKey = `crime:${stateAbbr.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `https://api.usa.gov/crime/fbi/cde/estimate/state/${stateAbbr.toLowerCase()}?from=2019&to=2022&API_KEY=iiHnOKfno2Mgkt5AynpvPpUQTEyxE77jo1RU8PIv`;
  const r = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!r.ok) throw new Error(`FBI Crime API ${r.status}`);
  const data = await r.json();

  const results = data.results || [];
  const latest = results[results.length - 1] || {};
  const pop = latest.population || 1;

  // Multi-year rates for trend analysis
  const yearlyRates = results
    .filter(r => r.population > 0 && r.violent_crime != null)
    .map(r => ({
      year: r.year,
      rate: Math.round((r.violent_crime / r.population) * 100000),
      propertyRate: r.property_crime ? Math.round((r.property_crime / r.population) * 100000) : null,
    }));

  const result = {
    violentCrimeRate: latest.violent_crime ? Math.round((latest.violent_crime / pop) * 100000) : null,
    propertyCrimeRate: latest.property_crime ? Math.round((latest.property_crime / pop) * 100000) : null,
    year: latest.year || null,
    yearlyRates,
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Compute composite momentum score v2 (0-100) with REAL trend analysis.
 * Uses multi-year Census data, Zillow ZHVI price velocity, FBI crime trends,
 * Walk Score, and optional school ratings.
 *
 * @param {object} censusData - { current, prior, trends } from censusMultiYearFetch
 * @param {object} walkScore - Walk Score API result
 * @param {object} crime - FBI crime data with yearlyRates
 * @param {object|null} zhvi - Zillow ZHVI data { current_value, yoy_change, ... }
 * @param {object|null} schools - GreatSchools ratings
 * @returns {{ overallScore, trend, factors, drivers, dataSources }}
 */
function computeMomentumScore(censusData, walkScore, crime, zhvi, schools) {
  const census = censusData?.current;
  const trends = censusData?.trends || {};
  const factors = [];
  const dataSources = [];

  // === 1. Price Velocity (25%) — real Y-o-Y home value change ===
  let priceScore = 50;
  let priceDetail = 'No price trend data';
  let priceTrend = 'stable';

  if (zhvi?.yoy_change != null) {
    // ZHVI: -10% → 20, 0% → 50, +5% → 65, +15% → 95
    priceScore = Math.min(100, Math.max(0, Math.round(50 + zhvi.yoy_change * 3)));
    const dir = zhvi.yoy_change >= 0 ? '+' : '';
    priceDetail = `${dir}${zhvi.yoy_change.toFixed(1)}% Y-o-Y`;
    if (zhvi.current_value) priceDetail += ` (Zillow: $${Math.round(zhvi.current_value / 1000)}K)`;
    priceTrend = zhvi.yoy_change > 2 ? 'up' : zhvi.yoy_change < -2 ? 'down' : 'stable';
    dataSources.push('Zillow ZHVI');
  } else if (trends.homeValueChange != null) {
    priceScore = Math.min(100, Math.max(0, Math.round(50 + trends.homeValueChange * 3)));
    const dir = trends.homeValueChange >= 0 ? '+' : '';
    priceDetail = `${dir}${trends.homeValueChange}% Y-o-Y (Census ACS)`;
    priceTrend = trends.homeValueChange > 2 ? 'up' : trends.homeValueChange < -2 ? 'down' : 'stable';
  } else if (census?.vacantUnits != null && census?.totalUnits > 0) {
    const vacRate = census.vacantUnits / census.totalUnits;
    priceScore = Math.min(100, Math.max(0, Math.round(100 - vacRate * 500)));
    priceDetail = `${(vacRate * 100).toFixed(1)}% vacancy (proxy)`;
  }
  factors.push({ name: 'Price Velocity', score: priceScore, weight: 0.25, detail: priceDetail, trend: priceTrend });

  // === 2. Affordability (20%) — income/price ratio ===
  let affordScore = 50;
  let affordDetail = 'No data available';
  if (census?.medianIncome && census?.medianHomeValue && census.medianHomeValue > 0) {
    const ratio = census.medianIncome / census.medianHomeValue;
    affordScore = Math.min(100, Math.max(0, Math.round(ratio * 250)));
    affordDetail = `$${(census.medianHomeValue / 1000).toFixed(0)}K home vs $${(census.medianIncome / 1000).toFixed(0)}K income`;
  }
  factors.push({ name: 'Affordability', score: affordScore, weight: 0.20, detail: affordDetail });

  // === 3. Safety (15%) — crime rate + multi-year direction ===
  let safetyScore = 50;
  let safetyDetail = 'No crime data';
  let safetyTrend = 'stable';
  if (crime?.violentCrimeRate != null) {
    safetyScore = Math.min(100, Math.max(0, Math.round(100 - (crime.violentCrimeRate / 8))));
    safetyDetail = `${crime.violentCrimeRate} violent crimes/100K`;
    dataSources.push('FBI Crime Data');

    if (crime.yearlyRates?.length >= 2) {
      const first = crime.yearlyRates[0].rate;
      const last = crime.yearlyRates[crime.yearlyRates.length - 1].rate;
      const changePercent = ((last - first) / first * 100).toFixed(0);
      if (last < first * 0.95) {
        safetyTrend = 'up';
        safetyDetail += ` (↓${Math.abs(changePercent)}% since ${crime.yearlyRates[0].year})`;
      } else if (last > first * 1.05) {
        safetyTrend = 'down';
        safetyDetail += ` (↑${changePercent}% since ${crime.yearlyRates[0].year})`;
      } else {
        safetyDetail += ` (stable since ${crime.yearlyRates[0].year})`;
      }
    }
  }
  factors.push({ name: 'Safety', score: safetyScore, weight: 0.15, detail: safetyDetail, trend: safetyTrend });

  // === 4. Demand Signals (15%) — vacancy change + population growth ===
  let demandScore = 50;
  let demandDetail = 'No demand data';
  let demandTrend = 'stable';
  if (trends.vacancyChange != null || trends.populationChange != null) {
    let points = 50;
    const parts = [];
    if (trends.vacancyChange != null) {
      points += -trends.vacancyChange * 20;
      const dir = trends.vacancyChange >= 0 ? '+' : '';
      parts.push(`vacancy ${dir}${trends.vacancyChange}pp`);
      if (trends.vacancyChange < -0.5) demandTrend = 'up';
      else if (trends.vacancyChange > 0.5) demandTrend = 'down';
    }
    if (trends.populationChange != null) {
      points += trends.populationChange * 5;
      const dir = trends.populationChange >= 0 ? '+' : '';
      parts.push(`population ${dir}${trends.populationChange}%`);
      if (demandTrend === 'stable') {
        if (trends.populationChange > 1) demandTrend = 'up';
        else if (trends.populationChange < -1) demandTrend = 'down';
      }
    }
    demandScore = Math.min(100, Math.max(0, Math.round(points)));
    demandDetail = parts.join(', ');
    dataSources.push('Census ACS (Y-o-Y)');
  }
  factors.push({ name: 'Demand Signals', score: demandScore, weight: 0.15, detail: demandDetail, trend: demandTrend });

  // === 5. Income Growth (15%) — Y-o-Y income change ===
  let incomeScore = 50;
  let incomeDetail = 'No income data';
  let incomeTrend = 'stable';
  if (trends.incomeChange != null) {
    incomeScore = Math.min(100, Math.max(0, Math.round(50 + trends.incomeChange * 5)));
    const dir = trends.incomeChange >= 0 ? '+' : '';
    incomeDetail = `${dir}${trends.incomeChange}% Y-o-Y`;
    if (census?.medianIncome) incomeDetail += ` ($${(census.medianIncome / 1000).toFixed(0)}K)`;
    incomeTrend = trends.incomeChange > 2 ? 'up' : trends.incomeChange < -2 ? 'down' : 'stable';
  } else if (census?.medianIncome) {
    incomeScore = Math.min(100, Math.max(0, Math.round((census.medianIncome / 150000) * 100)));
    incomeDetail = `$${(census.medianIncome / 1000).toFixed(0)}K median household`;
  }
  factors.push({ name: 'Income Growth', score: incomeScore, weight: 0.15, detail: incomeDetail, trend: incomeTrend });

  // === 6. Walkability (10%) — or Schools if available ===
  if (schools?.avgRating != null) {
    const schoolScore = Math.min(100, Math.round(schools.avgRating * 10));
    factors.push({
      name: 'Schools', score: schoolScore, weight: 0.05,
      detail: `${schools.avgRating}/10 avg (${schools.schoolCount} nearby)`,
    });
    dataSources.push('GreatSchools');
    // Give walkability remaining 5%
    let walkVal = 50;
    let walkDet = WALKSCORE_KEY ? 'Score unavailable' : 'Add WALKSCORE_API_KEY';
    if (walkScore?.walkscore != null) {
      walkVal = walkScore.walkscore;
      walkDet = walkScore.description || `Walk Score: ${walkScore.walkscore}`;
      dataSources.push('Walk Score');
    }
    factors.push({ name: 'Walkability', score: walkVal, weight: 0.05, detail: walkDet });
  } else {
    let walkVal = 50;
    let walkDet = WALKSCORE_KEY ? 'Score unavailable' : 'Add WALKSCORE_API_KEY for data';
    if (walkScore?.walkscore != null) {
      walkVal = walkScore.walkscore;
      walkDet = walkScore.description || `Walk Score: ${walkScore.walkscore}`;
      dataSources.push('Walk Score');
    }
    factors.push({ name: 'Walkability', score: walkVal, weight: 0.10, detail: walkDet });
  }

  // Weighted average
  const overall = Math.round(factors.reduce((sum, f) => sum + f.score * f.weight, 0));

  // Real trend direction — weighted vote from factors with directional data
  const trendVotes = factors.filter(f => f.trend);
  const trendValue = trendVotes.reduce((sum, f) => {
    const tv = f.trend === 'up' ? 1 : f.trend === 'down' ? -1 : 0;
    return sum + tv * f.weight;
  }, 0);
  let trend = 'stable';
  if (trendValue > 0.08) trend = 'up';
  else if (trendValue < -0.08) trend = 'down';

  // Human-readable drivers: "driven by +4.2% price growth and declining crime"
  const drivers = factors
    .filter(f => f.trend === 'up' || f.trend === 'down')
    .map(f => ({ name: f.name, direction: f.trend, detail: f.detail }))
    .slice(0, 3);

  return { overallScore: overall, trend, factors, drivers, dataSources };
}

/** Save a momentum snapshot to SQLite for historical tracking. */
function saveMomentumSnapshot(zipCode, score, trend, factors) {
  try {
    db.prepare('INSERT INTO momentum_snapshots (zip, score, trend, factors) VALUES (?, ?, ?, ?)')
      .run(zipCode, score, trend, JSON.stringify(factors));
  } catch (err) {
    console.log('Snapshot save failed:', err.message);
  }
}

/** Get the most recent prior snapshot for comparison. */
function getPriorSnapshot(zipCode) {
  try {
    return db.prepare(
      'SELECT score, trend, factors, created_at FROM momentum_snapshots WHERE zip = ? ORDER BY created_at DESC LIMIT 1 OFFSET 1'
    ).get(zipCode) || null;
  } catch { return null; }
}

app.get('/api/momentum', async (req, res) => {
  try {
    const { zipCode, lat, lon, state } = req.query;
    if (!zipCode) return res.status(400).json({ error: 'Missing zipCode parameter' });

    const cacheKey = `momentum-v2:${zipCode}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const errors = [];
    const latF = lat ? parseFloat(lat) : null;
    const lonF = lon ? parseFloat(lon) : null;

    // Fetch ALL data sources in parallel
    const [censusResult, walkResult, crimeResult, schoolResult] = await Promise.allSettled([
      censusMultiYearFetch(zipCode),
      latF && lonF ? walkScoreFetch(latF, lonF, '') : Promise.resolve(null),
      state ? crimeApiFetch(state) : Promise.resolve(null),
      latF && lonF ? fetchSchoolRatings(latF, lonF) : Promise.resolve(null),
    ]);

    const censusData = censusResult.status === 'fulfilled' ? censusResult.value : null;
    if (censusResult.status === 'rejected') errors.push('Census: ' + censusResult.reason?.message);

    const walkData = walkResult.status === 'fulfilled' ? walkResult.value : null;
    if (walkResult.status === 'rejected') errors.push('Walk Score: ' + walkResult.reason?.message);

    const crimeData = crimeResult.status === 'fulfilled' ? crimeResult.value : null;
    if (crimeResult.status === 'rejected') errors.push('Crime: ' + crimeResult.reason?.message);

    const schoolData = schoolResult.status === 'fulfilled' ? schoolResult.value : null;

    // ZHVI lookup (instant, from SQLite)
    const zhviData = getZHVIData(zipCode);

    // If no data at all, return demo
    if (!censusData?.current && !walkData && !crimeData && !zhviData) {
      return res.json({ demo: true, zipCode, ...getDemoMomentum() });
    }

    const momentum = computeMomentumScore(censusData, walkData, crimeData, zhviData, schoolData);

    // Save snapshot for historical tracking
    saveMomentumSnapshot(zipCode, momentum.overallScore, momentum.trend, momentum.factors);

    // Get prior snapshot for comparison
    const priorSnapshot = getPriorSnapshot(zipCode);

    // Build ZHVI mini-summary for response
    let zhviSummary = null;
    if (zhviData) {
      zhviSummary = {
        currentValue: zhviData.current_value,
        yoyChange: zhviData.yoy_change,
        value1YrAgo: zhviData.value_1yr_ago,
        value3YrAgo: zhviData.value_3yr_ago,
        value5YrAgo: zhviData.value_5yr_ago,
      };
    }

    const result = {
      zipCode,
      ...momentum,
      zhvi: zhviSummary,
      priorSnapshot: priorSnapshot ? {
        score: priorSnapshot.score,
        trend: priorSnapshot.trend,
        date: priorSnapshot.created_at,
      } : null,
      rawData: {
        census: censusData?.current || null,
        censusPrior: censusData?.prior || null,
        censusTrends: censusData?.trends || null,
        walkScore: walkData,
        crime: crimeData,
        schools: schoolData,
      },
      errors: errors.length ? errors : undefined,
    };

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Demo momentum data when APIs are unavailable. */
function getDemoMomentum() {
  const factors = [
    { name: 'Price Velocity', score: 68, weight: 0.25, detail: '+4.2% Y-o-Y (Zillow: $325K)', trend: 'up' },
    { name: 'Affordability', score: 55, weight: 0.20, detail: '$285K home vs $72K income' },
    { name: 'Safety', score: 62, weight: 0.15, detail: '305 violent crimes/100K (↓8% since 2019)', trend: 'up' },
    { name: 'Demand Signals', score: 58, weight: 0.15, detail: 'vacancy -0.3pp, population +0.8%', trend: 'up' },
    { name: 'Income Growth', score: 54, weight: 0.15, detail: '+3.1% Y-o-Y ($72K)', trend: 'up' },
    { name: 'Walkability', score: 45, weight: 0.10, detail: 'Car-Dependent' },
  ];
  const overall = Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0));
  return {
    overallScore: overall,
    trend: 'up',
    factors,
    drivers: [
      { name: 'Price Velocity', direction: 'up', detail: '+4.2% Y-o-Y' },
      { name: 'Safety', direction: 'up', detail: 'Crime declining' },
      { name: 'Income Growth', direction: 'up', detail: '+3.1% Y-o-Y' },
    ],
    dataSources: ['Demo Data'],
  };
}

// ===========================================================================
// MARKET CONTEXT — fetch and cache RentCast market data in SQLite
// ===========================================================================

/**
 * Get cached market context for a zip code (7-day TTL).
 * @param {string} zip
 * @returns {Object|null} { medianDom, medianPrice, avgPpsf, totalInventory }
 */
function getMarketContext(zip) {
  try {
    const row = db.prepare(
      "SELECT * FROM market_context_cache WHERE zip = ? AND updated_at > datetime('now', '-7 days')"
    ).get(zip);
    if (!row) return null;
    return {
      medianDom: row.median_dom,
      medianPrice: row.median_price,
      avgPpsf: row.avg_ppsf,
      totalInventory: row.total_inventory,
    };
  } catch { return null; }
}

// ===========================================================================
// LISTING SNAPSHOTS — track prices over time, detect reductions
// ===========================================================================

/**
 * Generate a deterministic key for deduplicating listings across scans.
 * @param {Object} listing
 * @returns {string} e.g. "123 main st:55401"
 */
function listingKey(listing) {
  const addr = (listing.address || listing.formattedAddress || '').toLowerCase().trim();
  const zip = (listing.zipCode || '').trim();
  return `${addr}:${zip}`;
}

/**
 * Save listing snapshots to SQLite and enrich with price history.
 * @param {Array} listings - Normalized listing objects
 * @param {string} scanLocation - Search query used
 * @param {string} source - Data source name
 * @returns {Array} Listings enriched with priceHistory
 */
function saveAndEnrichSnapshots(listings, scanLocation, source) {
  const insertStmt = db.prepare(`
    INSERT INTO listing_snapshots
      (listing_key, address, city, state, zip, price, price_per_sqft, sqft,
       bedrooms, bathrooms, property_type, year_built, days_on_market, status, source, scan_location)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const historyStmt = db.prepare(`
    SELECT price, days_on_market, created_at
    FROM listing_snapshots
    WHERE listing_key = ?
    ORDER BY created_at DESC
    LIMIT 10
  `);

  const enriched = listings.map(listing => {
    const key = listingKey(listing);
    const ppsf = listing.squareFootage > 0 ? listing.price / listing.squareFootage : null;

    // Get prior snapshots BEFORE inserting current
    const history = historyStmt.all(key);

    const priceHistory = {
      snapshots: history.map(h => ({ price: h.price, dom: h.days_on_market, date: h.created_at })),
      priceChanges: [],
      hasDropped: false,
      totalDrop: 0,
      totalDropPercent: 0,
      daysSinceFirstSeen: 0,
    };

    if (history.length > 0) {
      const firstSeen = history[history.length - 1];
      const firstDate = new Date(firstSeen.created_at);
      priceHistory.daysSinceFirstSeen = Math.floor((Date.now() - firstDate) / 86400000);

      // Detect price changes between consecutive snapshots
      let prevPrice = listing.price;
      for (const snap of history) {
        if (snap.price !== prevPrice) {
          priceHistory.priceChanges.push({
            from: snap.price,
            to: prevPrice,
            change: prevPrice - snap.price,
            changePercent: ((prevPrice - snap.price) / snap.price * 100).toFixed(1),
            date: snap.created_at,
          });
        }
        prevPrice = snap.price;
      }

      if (firstSeen.price > listing.price) {
        priceHistory.hasDropped = true;
        priceHistory.totalDrop = firstSeen.price - listing.price;
        priceHistory.totalDropPercent = ((firstSeen.price - listing.price) / firstSeen.price * 100).toFixed(1);
      }
    }

    return { ...listing, priceHistory, _key: key, _ppsf: ppsf };
  });

  // Batch insert all current snapshots
  const insertMany = db.transaction((items) => {
    for (const item of items) {
      try { insertStmt.run(...item); } catch { /* skip duplicates */ }
    }
  });

  const rows = enriched.map(l => [
    l._key, l.address || l.formattedAddress, l.city, l.state, l.zipCode,
    l.price, l._ppsf, l.squareFootage, l.bedrooms, l.bathrooms,
    l.propertyType, l.yearBuilt, l.daysOnMarket, l.status, source, scanLocation,
  ]);
  try { insertMany(rows); } catch (err) { console.log('Snapshot save failed:', err.message); }

  // Clean internal fields
  return enriched.map(({ _key, _ppsf, ...rest }) => rest);
}

/**
 * Get historical price drop rate for a zip code from stored snapshots.
 * @param {string} zip
 * @returns {number|null} Drop rate as percentage, or null if insufficient data
 */
function getZipDropRate(zip) {
  try {
    const rows = db.prepare(`
      SELECT listing_key, GROUP_CONCAT(DISTINCT price) as prices
      FROM listing_snapshots
      WHERE zip = ? AND created_at > datetime('now', '-90 days')
      GROUP BY listing_key
      HAVING COUNT(*) > 1
    `).all(zip);
    if (rows.length < 3) return null; // insufficient data

    const totalKeys = db.prepare(`
      SELECT COUNT(DISTINCT listing_key) as cnt
      FROM listing_snapshots
      WHERE zip = ? AND created_at > datetime('now', '-90 days')
    `).get(zip);

    const droppedCount = rows.filter(r => {
      const prices = r.prices.split(',').map(Number);
      return prices.length > 1 && Math.min(...prices) < Math.max(...prices);
    }).length;

    return totalKeys.cnt > 0 ? Math.round((droppedCount / totalKeys.cnt) * 100) : null;
  } catch { return null; }
}

// ===========================================================================
// DEAL PULSE v2 — market-aware deal scoring with historical data
// ===========================================================================

/**
 * Enrich listings with Deal Pulse metrics.
 * @param {Array} listings - Array of normalized listing objects (with priceHistory)
 * @param {Object|null} marketContext - RentCast market data { medianDom, medianPrice, avgPpsf, totalInventory }
 * @returns {Array} listings with dealPulse, dealScore, priceDropProbability, offerTiming, marketPosition, biddingWarProb, daysToSellEstimate
 */
function enrichWithDealPulse(listings, marketContext) {
  if (!listings.length) return listings;

  const withPrice = listings.filter(l => l.price > 0 && l.squareFootage > 0);
  const scanPpsfs = withPrice.map(l => l.price / l.squareFootage).sort((a, b) => a - b);
  const medianPpsf = scanPpsfs.length ? scanPpsfs[Math.floor(scanPpsfs.length / 2)] : 0;
  const marketPpsf = marketContext?.avgPpsf || 0;

  // Count fast movers for bidding war signal
  const withDom = listings.filter(l => l.daysOnMarket != null);
  const fastMoverRatio = withDom.length
    ? withDom.filter(l => l.daysOnMarket < 14).length / withDom.length
    : 0;

  // Historical drop rate for this zip
  const zip = listings[0]?.zipCode;
  const histDropRate = zip ? getZipDropRate(zip) : null;

  return listings.map(listing => {
    const ppsf = listing.squareFootage > 0 ? listing.price / listing.squareFootage : 0;
    const dom = listing.daysOnMarket || 0;
    const mDom = marketContext?.medianDom || 0;

    // --- Price ratio (blended scan + market when available) ---
    let scanRatio = medianPpsf > 0 && ppsf > 0 ? ppsf / medianPpsf : 1;
    let marketRatio = marketPpsf > 0 && ppsf > 0 ? ppsf / marketPpsf : scanRatio;
    let blendedRatio = marketPpsf > 0 ? scanRatio * 0.6 + marketRatio * 0.4 : scanRatio;

    // --- Market position ---
    let marketPosition = 'fair';
    if (blendedRatio < 0.90) marketPosition = 'underpriced';
    else if (blendedRatio > 1.10) marketPosition = 'overpriced';

    // --- Price drop probability ---
    let priceDropProb = histDropRate != null ? histDropRate : 15;
    // DOM adjustments
    if (mDom > 0) {
      if (dom > mDom * 2) priceDropProb += 20;
      else if (dom > mDom * 1.5) priceDropProb += 10;
    } else {
      if (dom > 60) priceDropProb += 35;
      else if (dom > 30) priceDropProb += 20;
      else if (dom > 14) priceDropProb += 8;
    }
    // Price ratio adjustments
    if (blendedRatio > 1.15) priceDropProb += 15;
    else if (blendedRatio > 1.05) priceDropProb += 8;
    else if (blendedRatio < 0.9) priceDropProb -= 10;
    // Inventory pressure (buyer's market)
    if (marketContext?.totalInventory > 300) priceDropProb += 10;
    // Already dropped — seller is responsive
    if (listing.priceHistory?.hasDropped) priceDropProb -= 10;
    // Fresh listing
    if (dom < 7) priceDropProb -= 5;
    priceDropProb = Math.max(5, Math.min(95, priceDropProb));

    // --- Offer timing ---
    let offerTiming = 'watch';
    if (marketPosition === 'underpriced' && mDom > 0 && dom < mDom * 0.5) offerTiming = 'now';
    else if (priceDropProb > 55) offerTiming = 'wait';
    else if (marketPosition === 'underpriced') offerTiming = 'now';
    else if (mDom > 0 && dom > mDom * 2) offerTiming = 'wait';
    else if (dom > 30) offerTiming = 'wait';

    // --- Deal Score (0-100) ---
    let dealScore = 50;
    // Price efficiency
    if (blendedRatio < 0.85) dealScore += 25;
    else if (blendedRatio < 0.92) dealScore += 15;
    else if (blendedRatio < 1.00) dealScore += 8;
    else if (blendedRatio > 1.15) dealScore -= 20;
    else if (blendedRatio > 1.08) dealScore -= 10;

    // DOM signal (market-relative)
    if (mDom > 0) {
      const domRatio = dom / mDom;
      if (domRatio > 3.0) dealScore += 18;
      else if (domRatio > 1.5) dealScore += 12;
      else if (domRatio > 1.0) dealScore += 5;
      else if (domRatio < 0.5) dealScore -= 5;
    } else {
      if (dom > 60) dealScore += 15;
      else if (dom > 30) dealScore += 10;
      else if (dom > 14) dealScore += 5;
    }

    // Historical price signal
    if (listing.priceHistory?.hasDropped) {
      const dropPct = parseFloat(listing.priceHistory.totalDropPercent) || 0;
      if (dropPct > 10) dealScore += 15;
      else if (dropPct > 5) dealScore += 10;
      else if (dropPct > 0) dealScore += 5;
    }

    // Construction age
    if (listing.yearBuilt >= 2015) dealScore += 5;
    else if (listing.yearBuilt >= 2000) dealScore += 3;

    dealScore = Math.max(0, Math.min(100, dealScore));

    let dealPulse = 'cold';
    if (dealScore >= 72) dealPulse = 'hot';
    else if (dealScore >= 55) dealPulse = 'warm';

    // --- Days-to-sell estimate ---
    let daysToSellEstimate = null;
    if (mDom > 0) {
      let est = mDom;
      if (marketPosition === 'underpriced') est *= 0.7;
      else if (marketPosition === 'overpriced') est *= 1.5;
      if (listing.priceHistory?.hasDropped) est *= 0.85;
      daysToSellEstimate = Math.round(est);
    }

    // --- Bidding war probability ---
    let biddingWarProb = 5;
    if (dom < 7) biddingWarProb += 25;
    else if (dom < 14) biddingWarProb += 15;
    if (mDom > 0 && dom < mDom * 0.5) biddingWarProb += 10;
    if (marketContext?.totalInventory < 100) biddingWarProb += 20;
    else if (marketContext?.totalInventory < 200) biddingWarProb += 10;
    if (marketPosition === 'underpriced') biddingWarProb += 15;
    if (blendedRatio < 0.85) biddingWarProb += 10;
    if (fastMoverRatio > 0.5) biddingWarProb += 10;
    if (dom > 30) biddingWarProb -= 15;
    biddingWarProb = Math.max(0, Math.min(85, biddingWarProb));

    return {
      ...listing,
      dealPulse,
      dealScore,
      priceDropProbability: priceDropProb,
      offerTiming,
      marketPosition,
      daysToSellEstimate,
      biddingWarProb,
    };
  });
}

// ===========================================================================
// COMP NARRATIVE — human-readable market insight for listing sets
// ===========================================================================

/**
 * Generate a comp narrative for a listing set.
 * @param {Array} listings - Enriched listings (with Deal Pulse + priceHistory)
 * @param {Object|null} marketContext
 * @returns {Object} { summary, bullets, confidence }
 */
function generateCompNarrative(listings, marketContext) {
  if (!listings || listings.length < 2) {
    return { summary: 'Insufficient comparable data for narrative.', bullets: [], confidence: 'low' };
  }

  const withPrice = listings.filter(l => l.price > 0 && l.squareFootage > 0);
  if (withPrice.length < 2) {
    return { summary: 'Insufficient comparable data for narrative.', bullets: [], confidence: 'low' };
  }

  const prices = withPrice.map(l => l.price).sort((a, b) => a - b);
  const ppsfs = withPrice.map(l => l.price / l.squareFootage).sort((a, b) => a - b);
  const doms = listings.filter(l => l.daysOnMarket != null).map(l => l.daysOnMarket);
  const medianPrice = prices[Math.floor(prices.length / 2)];
  const medianPpsf = ppsfs[Math.floor(ppsfs.length / 2)];
  const avgDom = doms.length ? Math.round(doms.reduce((s, d) => s + d, 0) / doms.length) : null;

  const bullets = [];
  const parts = [];

  // Price range
  const lo = prices[0] >= 1000000 ? `$${(prices[0] / 1000000).toFixed(1)}M` : `$${(prices[0] / 1000).toFixed(0)}K`;
  const hi = prices[prices.length - 1] >= 1000000 ? `$${(prices[prices.length - 1] / 1000000).toFixed(1)}M` : `$${(prices[prices.length - 1] / 1000).toFixed(0)}K`;
  parts.push(`${withPrice.length} comparable properties range from ${lo}-${hi}`);

  // Fast movers
  const fastMovers = listings.filter(l => l.daysOnMarket != null && l.daysOnMarket < 14);
  if (fastMovers.length > 0) {
    const pct = Math.round((fastMovers.length / withPrice.length) * 100);
    bullets.push(`${fastMovers.length} of ${withPrice.length} comps listed under 14 days (${pct}% moving fast)`);
    if (pct > 50) parts.push('with the majority moving in under 2 weeks');
  }

  // Underpriced comps
  const underpriced = listings.filter(l => l.marketPosition === 'underpriced');
  if (underpriced.length > 0) {
    bullets.push(`${underpriced.length} listing${underpriced.length > 1 ? 's' : ''} priced below market median ($${medianPpsf.toFixed(0)}/sqft)`);
  }

  // Price drops detected
  const dropped = listings.filter(l => l.priceHistory?.hasDropped);
  if (dropped.length > 0) {
    const avgDropPct = (dropped.reduce((s, l) => s + parseFloat(l.priceHistory.totalDropPercent), 0) / dropped.length).toFixed(1);
    bullets.push(`${dropped.length} have already reduced price (avg -${avgDropPct}%)`);
    parts.push(`and ${dropped.length} seller${dropped.length > 1 ? 's have' : ' has'} already cut prices`);
  }

  // Market context overlay
  if (marketContext) {
    const mDom = marketContext.medianDom;
    const mPrice = marketContext.medianPrice;
    if (mDom) {
      bullets.push(`Market average days on market: ${mDom} days (zip-level)`);
      if (avgDom && avgDom < mDom * 0.8) {
        parts.push('-- this pocket is moving faster than the broader market');
      } else if (avgDom && avgDom > mDom * 1.3) {
        parts.push('-- this area is slower than the zip average');
      }
    }
    if (mPrice && medianPrice) {
      const diff = ((medianPrice - mPrice) / mPrice * 100).toFixed(0);
      if (Math.abs(Number(diff)) > 5) {
        bullets.push(`Scan median ${Number(diff) > 0 ? '+' : ''}${diff}% vs zip-level median ($${(mPrice / 1000).toFixed(0)}K)`);
      }
    }
  }

  // Bidding war listings
  const biddingWar = listings.filter(l => l.biddingWarProb > 50);
  if (biddingWar.length > 0) {
    bullets.push(`${biddingWar.length} listing${biddingWar.length > 1 ? 's show' : ' shows'} bidding war signals`);
  }

  let confidence = 'medium';
  if (withPrice.length >= 8 && marketContext) confidence = 'high';
  else if (withPrice.length < 4 && !marketContext) confidence = 'low';

  const summary = parts.join(', ') + '.';

  return { summary, bullets, confidence };
}

// ===========================================================================
// HEATMAP — Census tract-level data for neighborhood heatmap overlay
// ===========================================================================

/**
 * FCC Census Area API — map lat/lon → state FIPS + county FIPS.
 * Free, no key required.
 */
async function fccGeocode(lat, lon) {
  const cacheKey = `fcc:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `https://geo.fcc.gov/api/census/area?format=json&lat=${lat}&lon=${lon}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!r.ok) throw new Error(`FCC API ${r.status}`);
  const data = await r.json();
  if (!data.results || !data.results.length) throw new Error('No FCC results');

  const raw = data.results[0];
  // county_fips from FCC is full 5-digit (state+county, e.g. "27053")
  // Census API needs just the 3-digit county part (e.g. "053")
  const countyFips3 = raw.county_fips.length > 3
    ? raw.county_fips.substring(raw.state_fips.length)
    : raw.county_fips;
  const result = {
    stateFips: raw.state_fips,
    countyFips: countyFips3,
    blockFips: raw.block_fips,
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Batch-fetch Census ACS data for ALL tracts in a county.
 * Returns array of tract objects with economic data.
 */
async function censusTractFetch(stateFips, countyFips) {
  const cacheKey = `census-tracts:${stateFips}:${countyFips}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const vars = 'B19013_001E,B25077_001E,B01003_001E,B25002_003E,B25002_001E';
  const url = `https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=tract:*&in=state:${stateFips}&in=county:${countyFips}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!r.ok) throw new Error(`Census Tract API ${r.status}`);
  const data = await r.json();

  if (!data || data.length < 2) throw new Error('No tract data for this county');

  // data[0] = headers, data[1..n] = rows
  const tracts = data.slice(1).map(row => ({
    medianIncome: parseInt(row[0]) || null,
    medianHomeValue: parseInt(row[1]) || null,
    population: parseInt(row[2]) || null,
    vacantUnits: parseInt(row[3]) || null,
    totalUnits: parseInt(row[4]) || null,
    state: row[5],
    county: row[6],
    tract: row[7],
  }));

  cacheSet(cacheKey, tracts);
  return tracts;
}

/**
 * Generate demo heatmap data when APIs are unavailable.
 */
function getDemoHeatmap(lat, lon, metric) {
  const points = [];
  const count = 35;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const dist = 0.005 + Math.random() * 0.02;
    const pLat = lat + Math.cos(angle) * dist + (Math.random() - 0.5) * 0.008;
    const pLon = lon + Math.sin(angle) * dist + (Math.random() - 0.5) * 0.008;
    const intensity = 0.15 + Math.random() * 0.85;
    points.push([pLat, pLon, +intensity.toFixed(3)]);
  }
  return {
    points,
    metric,
    demo: true,
    stats: { min: 0.15, max: 1.0, avg: 0.55 },
  };
}

app.get('/api/heatmap', async (req, res) => {
  try {
    const { lat, lon, radius, metric } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

    const centerLat = parseFloat(lat);
    const centerLon = parseFloat(lon);
    const radiusMiles = parseFloat(radius) || 5;
    const chosenMetric = metric || 'home-value';

    const cacheKey = `heatmap:${centerLat.toFixed(3)},${centerLon.toFixed(3)}:${radiusMiles}:${chosenMetric}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    // Generate a 7x7 grid of sample points covering the radius
    const degreesPerMileLat = 1 / 69;
    const degreesPerMileLon = 1 / (69 * Math.cos(centerLat * Math.PI / 180));
    const gridSize = 7;
    const step = (radiusMiles * 2) / (gridSize - 1);

    // Step 1: FCC-geocode grid points to find unique state+county pairs
    const countySet = new Map(); // key: "state:county" → { stateFips, countyFips }
    const gridPointTracts = []; // { lat, lon, stateFips, countyFips, blockFips }

    const gridPromises = [];
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const pLat = centerLat + (i - Math.floor(gridSize / 2)) * step * degreesPerMileLat;
        const pLon = centerLon + (j - Math.floor(gridSize / 2)) * step * degreesPerMileLon;
        gridPromises.push(
          fccGeocode(pLat, pLon)
            .then(fcc => {
              gridPointTracts.push({ lat: pLat, lon: pLon, ...fcc });
              const key = `${fcc.stateFips}:${fcc.countyFips}`;
              if (!countySet.has(key)) {
                countySet.set(key, { stateFips: fcc.stateFips, countyFips: fcc.countyFips });
              }
            })
            .catch(() => { /* skip points that fail geocoding */ })
        );
      }
    }
    await Promise.all(gridPromises);

    if (countySet.size === 0) {
      // FCC geocoding failed — return demo data
      return res.json(getDemoHeatmap(centerLat, centerLon, chosenMetric));
    }

    // Step 2: Batch-fetch Census tract data for each unique county
    const allTracts = [];
    const tractFetches = [];
    for (const { stateFips, countyFips } of countySet.values()) {
      tractFetches.push(
        censusTractFetch(stateFips, countyFips)
          .then(tracts => allTracts.push(...tracts))
          .catch(err => console.log(`Census tract fetch failed for ${stateFips}/${countyFips}:`, err.message))
      );
    }
    await Promise.all(tractFetches);

    if (allTracts.length === 0) {
      return res.json(getDemoHeatmap(centerLat, centerLon, chosenMetric));
    }

    // Step 3: Map grid points to tracts and compute centroids
    // blockFips format: state(2) + county(3) + tract(6) + block(4) = 15 digits
    // Extract tract code from blockFips
    const tractCentroids = new Map(); // key: "state:county:tract" → { latSum, lonSum, count }
    for (const gp of gridPointTracts) {
      // blockFips is 15 digits: 2(state) + 3(county) + 6(tract) + 4(block)
      const tractCode = gp.blockFips.substring(5, 11);
      const key = `${gp.stateFips}:${gp.countyFips}:${tractCode}`;
      if (!tractCentroids.has(key)) {
        tractCentroids.set(key, { latSum: 0, lonSum: 0, count: 0 });
      }
      const c = tractCentroids.get(key);
      c.latSum += gp.lat;
      c.lonSum += gp.lon;
      c.count++;
    }

    // Step 4: Compute metric values and build heatmap points
    // Build lookup: "state:county:tract" → tract data
    const tractLookup = new Map();
    for (const t of allTracts) {
      tractLookup.set(`${t.state}:${t.county}:${t.tract}`, t);
    }

    // Collect raw values for normalization
    const rawValues = [];
    const rawPoints = [];

    for (const [key, centroid] of tractCentroids) {
      const tractData = tractLookup.get(key);
      if (!tractData) continue;

      const avgLat = centroid.latSum / centroid.count;
      const avgLon = centroid.lonSum / centroid.count;

      let rawValue = null;
      switch (chosenMetric) {
        case 'home-value':
          rawValue = tractData.medianHomeValue;
          break;
        case 'affordability':
          if (tractData.medianIncome && tractData.medianHomeValue && tractData.medianHomeValue > 0) {
            rawValue = tractData.medianIncome / tractData.medianHomeValue;
          }
          break;
        case 'momentum':
          rawValue = computeMomentumScore({ current: tractData, prior: null, trends: {} }, null, null, null, null).overallScore;
          break;
        case 'density':
          rawValue = tractData.population;
          break;
        default:
          rawValue = tractData.medianHomeValue;
      }

      if (rawValue != null && rawValue > 0) {
        rawValues.push(rawValue);
        rawPoints.push({ lat: avgLat, lon: avgLon, value: rawValue });
      }
    }

    if (rawPoints.length === 0) {
      return res.json(getDemoHeatmap(centerLat, centerLon, chosenMetric));
    }

    // Normalize values to 0-1 range
    const minVal = Math.min(...rawValues);
    const maxVal = Math.max(...rawValues);
    const range = maxVal - minVal || 1;

    const points = rawPoints.map(p => [
      +p.lat.toFixed(5),
      +p.lon.toFixed(5),
      +((p.value - minVal) / range).toFixed(3),
    ]);

    const avg = rawValues.reduce((s, v) => s + v, 0) / rawValues.length;

    // Preserve precision for small-value metrics (affordability ratios)
    const fmtStat = (v) => Math.abs(v) < 10 ? +v.toFixed(3) : Math.round(v);

    const result = {
      points,
      metric: chosenMetric,
      tractCount: rawPoints.length,
      stats: {
        min: fmtStat(minVal),
        max: fmtStat(maxVal),
        avg: fmtStat(avg),
      },
    };

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.log('Heatmap error:', err.message);
    // Fallback to demo
    const centerLat = parseFloat(req.query.lat) || 39.83;
    const centerLon = parseFloat(req.query.lon) || -98.58;
    res.json(getDemoHeatmap(centerLat, centerLon, req.query.metric || 'home-value'));
  }
});

// ===========================================================================
// Geocoding (OpenStreetMap Nominatim — free, no key)
// ===========================================================================
app.get('/api/geocode', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
    const key = `geo:${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
    const data = await response.json();
    cacheSet(key, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reverse-geocode', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    const key = `revgeo:${lat},${lon}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
    const data = await response.json();
    cacheSet(key, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cache stats
app.get('/api/cache/stats', (req, res) => {
  res.json({ entries: cache.size, maxAge: '24 hours' });
});

// Health check
app.get('/api/health', (req, res) => {
  const sources = {};
  if (RAPIDAPI_KEY) {
    sources.zillow = 'active';
    sources.realtor = 'active';
  } else {
    sources.zillow = 'not configured (needs RAPIDAPI_KEY)';
    sources.realtor = 'not configured (needs RAPIDAPI_KEY)';
  }
  sources.rentcast = RENTCAST_KEY ? 'active' : 'not configured';
  sources.census = 'active (free, multi-year Y-o-Y)';
  sources.walkscore = WALKSCORE_KEY ? 'active' : 'not configured';
  sources.greatschools = GREATSCHOOLS_KEY ? 'active' : 'not configured';
  sources.crime = 'active (free, multi-year trends)';
  sources.geocoding = 'active (free)';
  sources.fccGeocode = 'active (free)';
  sources.censusTract = 'active (free)';
  sources.zhvi = zhviLoaded ? 'active (Zillow CSV)' : 'loading...';

  let zhviCount = 0, snapshotCount = 0, marketCacheCount = 0, savedCount = 0, portfolioCount = 0, searchCount = 0, alertCount = 0;
  try { zhviCount = db.prepare('SELECT COUNT(*) as c FROM zhvi_data').get().c; } catch (e) {}
  try { snapshotCount = db.prepare('SELECT COUNT(*) as c FROM listing_snapshots').get().c; } catch (e) {}
  try { marketCacheCount = db.prepare('SELECT COUNT(*) as c FROM market_context_cache').get().c; } catch (e) {}
  try { savedCount = db.prepare('SELECT COUNT(*) as c FROM saved_properties').get().c; } catch (e) {}
  try { portfolioCount = db.prepare('SELECT COUNT(*) as c FROM portfolios').get().c; } catch (e) {}
  try { searchCount = db.prepare('SELECT COUNT(*) as c FROM saved_searches').get().c; } catch (e) {}
  try { alertCount = db.prepare('SELECT COUNT(*) as c FROM alerts WHERE read = 0').get().c; } catch (e) {}

  res.json({
    status: 'ok',
    sources,
    cache: { entries: cache.size },
    database: { zhviZips: zhviCount, listingSnapshots: snapshotCount, marketContextZips: marketCacheCount, savedProperties: savedCount, portfolios: portfolioCount, savedSearches: searchCount, unreadAlerts: alertCount },
    uptime: process.uptime(),
  });
});

// ===========================================================================
// SAVED PROPERTIES — server-side CRUD for persistent property tracking
// ===========================================================================

app.get('/api/saved', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM saved_properties ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/saved', (req, res) => {
  try {
    const { address, city, state, zip, bedrooms, bathrooms, sqft, propertyType, yearBuilt,
            savedPrice, currentPrice, rentEstimate, latitude, longitude, imgSrc, notes } = req.body;
    if (!address) return res.status(400).json({ error: 'Missing address' });

    // Dedup by address
    const existing = db.prepare('SELECT id FROM saved_properties WHERE address = ?').get(address);
    if (existing) return res.json({ id: existing.id, exists: true });

    const result = db.prepare(`
      INSERT INTO saved_properties
        (address, city, state, zip, bedrooms, bathrooms, sqft, property_type, year_built,
         saved_price, current_price, rent_estimate, latitude, longitude, img_src, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(address, city, state, zip, bedrooms, bathrooms, sqft, propertyType, yearBuilt,
           savedPrice, currentPrice || savedPrice, rentEstimate, latitude, longitude, imgSrc, notes);

    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/saved/:id', (req, res) => {
  try {
    const { notes, currentPrice } = req.body;
    const updates = [];
    const params = [];
    if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
    if (currentPrice !== undefined) { updates.push('current_price = ?'); params.push(currentPrice); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    db.prepare(`UPDATE saved_properties SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/saved/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM saved_properties WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/saved/refresh', async (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM saved_properties').all();
    let updated = 0;
    for (const row of rows) {
      try {
        const result = await lookupProperty(row.address);
        if (result?.property) {
          const newPrice = result.property.zestimate || result.property.price || result.valuation?.price;
          const newRent = result.rentEstimate || null;
          if (newPrice) {
            db.prepare("UPDATE saved_properties SET current_price = ?, rent_estimate = COALESCE(?, rent_estimate), updated_at = datetime('now') WHERE id = ?")
              .run(newPrice, newRent, row.id);
            updated++;
          }
        }
      } catch { /* skip individual failures */ }
    }
    const refreshed = db.prepare('SELECT * FROM saved_properties ORDER BY created_at DESC').all();
    res.json({ updated, total: rows.length, properties: refreshed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// PORTFOLIOS — persistent shareable property collections
// ===========================================================================

app.post('/api/portfolios', (req, res) => {
  try {
    const { name, description, propertyIds } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing portfolio name' });
    if (!Array.isArray(propertyIds) || !propertyIds.length) {
      return res.status(400).json({ error: 'Missing property IDs' });
    }

    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO portfolios (id, name, description, property_ids) VALUES (?, ?, ?, ?)`)
      .run(id, name, description || '', JSON.stringify(propertyIds));

    res.json({ id, url: `/p/${id}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/portfolios/:id', (req, res) => {
  try {
    const portfolio = db.prepare('SELECT * FROM portfolios WHERE id = ?').get(req.params.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    let propertyIds = [];
    try { propertyIds = JSON.parse(portfolio.property_ids); } catch {}

    let properties = [];
    if (propertyIds.length) {
      const placeholders = propertyIds.map(() => '?').join(',');
      properties = db.prepare(`SELECT * FROM saved_properties WHERE id IN (${placeholders})`).all(...propertyIds);
    }

    res.json({
      id: portfolio.id,
      name: portfolio.name,
      description: portfolio.description,
      createdAt: portfolio.created_at,
      properties,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve portfolio page for client-facing share links
app.get('/p/:uuid', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
});

// ===========================================================================
// INVESTMENT CALCULATOR — mortgage + ROI analysis
// ===========================================================================

app.post('/api/investment/calculate', (req, res) => {
  try {
    const {
      price = 0,
      downPaymentPct = 20,
      interestRate = 6.5,
      loanTermYears = 30,
      monthlyRent = 0,
      annualExpensesPct = 40,
    } = req.body;

    const downPayment = price * (downPaymentPct / 100);
    const loanAmount = price - downPayment;
    const monthlyRate = interestRate / 100 / 12;
    const totalPayments = loanTermYears * 12;

    // Monthly mortgage payment
    let monthlyPayment = 0;
    if (monthlyRate > 0 && totalPayments > 0) {
      monthlyPayment = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, totalPayments))
        / (Math.pow(1 + monthlyRate, totalPayments) - 1);
    }

    const annualRent = monthlyRent * 12;
    const annualExpenses = annualRent * (annualExpensesPct / 100);
    const noi = annualRent - annualExpenses;
    const annualDebtService = monthlyPayment * 12;
    const annualCashFlow = noi - annualDebtService;
    const monthlyCashFlow = annualCashFlow / 12;

    // First year amortization breakdown
    let principalFirstYear = 0;
    let interestFirstYear = 0;
    let balance = loanAmount;
    for (let i = 0; i < 12 && balance > 0; i++) {
      const interestPayment = balance * monthlyRate;
      const principalPayment = monthlyPayment - interestPayment;
      interestFirstYear += interestPayment;
      principalFirstYear += principalPayment;
      balance -= principalPayment;
    }

    const totalCashNeeded = downPayment;
    const capRate = price > 0 ? (noi / price) * 100 : 0;
    const cashOnCash = totalCashNeeded > 0 ? (annualCashFlow / totalCashNeeded) * 100 : 0;
    const grossYield = price > 0 ? (annualRent / price) * 100 : 0;
    const dscr = annualDebtService > 0 ? noi / annualDebtService : 0;
    const breakEvenOccupancy = annualRent > 0 ? ((annualExpenses + annualDebtService) / annualRent) * 100 : 0;
    const onePercentRule = price > 0 ? monthlyRent >= price * 0.01 : false;

    res.json({
      monthlyPayment: Math.round(monthlyPayment),
      totalCashNeeded: Math.round(totalCashNeeded),
      monthlyCashFlow: Math.round(monthlyCashFlow),
      annualCashFlow: Math.round(annualCashFlow),
      capRate: +capRate.toFixed(2),
      cashOnCash: +cashOnCash.toFixed(2),
      grossYield: +grossYield.toFixed(2),
      dscr: +dscr.toFixed(2),
      breakEvenOccupancy: +breakEvenOccupancy.toFixed(1),
      onePercentRule,
      amortizationFirstYear: {
        principal: Math.round(principalFirstYear),
        interest: Math.round(interestFirstYear),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// SAVED SEARCHES — persistent scanner filter presets
// ===========================================================================

app.get('/api/saved-searches', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM saved_searches ORDER BY created_at DESC').all();
    res.json(rows.map(r => ({ ...r, filters: JSON.parse(r.filters) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/saved-searches', (req, res) => {
  try {
    const { name, filters } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing search name' });
    if (!filters || typeof filters !== 'object') return res.status(400).json({ error: 'Missing filters' });
    // Limit to 20 saved searches
    const count = db.prepare('SELECT COUNT(*) as c FROM saved_searches').get().c;
    if (count >= 20) return res.status(400).json({ error: 'Maximum 20 saved searches' });
    const result = db.prepare('INSERT INTO saved_searches (name, filters) VALUES (?, ?)')
      .run(name, JSON.stringify(filters));
    res.json({ id: result.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/saved-searches/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM saved_searches WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/saved-searches/:id/run', async (req, res) => {
  try {
    const search = db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(req.params.id);
    if (!search) return res.status(404).json({ error: 'Search not found' });
    const filters = JSON.parse(search.filters);
    const result = await fetchListings(filters);
    db.prepare("UPDATE saved_searches SET last_run_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json(result || { listings: [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// ALERTS — notification system for price drops, new listings, momentum changes
// ===========================================================================

app.get('/api/alerts', (req, res) => {
  try {
    const { unread, limit: lim } = req.query;
    let sql = 'SELECT * FROM alerts';
    const params = [];
    if (unread === 'true') { sql += ' WHERE read = 0'; }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(lim) || 50);
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(r => ({ ...r, data: JSON.parse(r.data || '{}') })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/alerts/count', (req, res) => {
  try {
    const row = db.prepare('SELECT COUNT(*) as count FROM alerts WHERE read = 0').get();
    res.json({ unread: row.count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/alerts/:id/read', (req, res) => {
  try {
    db.prepare('UPDATE alerts SET read = 1 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/alerts/read-all', (req, res) => {
  try {
    db.prepare('UPDATE alerts SET read = 1 WHERE read = 0').run();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// BACKGROUND ALERT SCANNER — runs every 6 hours
// ===========================================================================

let lastMomentumScan = 0;

async function runAlertScanner() {
  console.log('[AlertScanner] Starting scan...');
  const insertAlert = db.prepare(
    'INSERT INTO alerts (type, search_id, property_address, data) VALUES (?, ?, ?, ?)'
  );

  // 1. Re-run saved searches, diff against listing_snapshots
  const searches = db.prepare('SELECT * FROM saved_searches').all();
  for (const search of searches) {
    try {
      const filters = JSON.parse(search.filters);
      const result = await fetchListings(filters);
      if (!result?.listings) continue;

      for (const listing of result.listings) {
        const key = listingKey(listing);
        const prior = db.prepare(
          'SELECT price FROM listing_snapshots WHERE listing_key = ? ORDER BY created_at DESC LIMIT 1 OFFSET 1'
        ).get(key);

        if (!prior) {
          // Check if this is truly new (no snapshot at all)
          const any = db.prepare('SELECT id FROM listing_snapshots WHERE listing_key = ?').get(key);
          if (!any) {
            insertAlert.run('new_listing', search.id, listing.address || listing.formattedAddress, JSON.stringify({
              price: listing.price, beds: listing.bedrooms, baths: listing.bathrooms,
              sqft: listing.squareFootage, searchName: search.name,
            }));
          }
        } else if (prior.price > listing.price) {
          insertAlert.run('price_drop', search.id, listing.address || listing.formattedAddress, JSON.stringify({
            oldPrice: prior.price, newPrice: listing.price,
            drop: prior.price - listing.price,
            dropPercent: ((prior.price - listing.price) / prior.price * 100).toFixed(1),
            searchName: search.name,
          }));
        }
      }
      db.prepare("UPDATE saved_searches SET last_run_at = datetime('now') WHERE id = ?").run(search.id);
    } catch (err) {
      console.log(`[AlertScanner] Search ${search.id} failed:`, err.message);
    }
  }

  // 2. Check saved property price changes
  const savedProps = db.prepare('SELECT * FROM saved_properties').all();
  for (const prop of savedProps) {
    try {
      const result = await lookupProperty(prop.address);
      if (!result?.property) continue;
      const newPrice = result.property.zestimate || result.property.price || result.valuation?.price;
      if (newPrice && prop.current_price && newPrice !== prop.current_price) {
        const type = newPrice < prop.current_price ? 'price_drop' : 'price_increase';
        insertAlert.run(type, null, prop.address, JSON.stringify({
          oldPrice: prop.current_price, newPrice,
          change: newPrice - prop.current_price,
          changePercent: ((newPrice - prop.current_price) / prop.current_price * 100).toFixed(1),
        }));
        db.prepare("UPDATE saved_properties SET current_price = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newPrice, prop.id);
      }
    } catch (err) { /* skip individual failures */ }
  }

  // 3. Weekly momentum re-check for saved property zips
  const now = Date.now();
  if (now - lastMomentumScan > 7 * 24 * 60 * 60 * 1000) {
    lastMomentumScan = now;
    const zips = [...new Set(savedProps.map(p => p.zip).filter(Boolean))];
    for (const zip of zips) {
      try {
        const priorSnap = db.prepare(
          'SELECT score FROM momentum_snapshots WHERE zip = ? ORDER BY created_at DESC LIMIT 1'
        ).get(zip);
        if (!priorSnap) continue;
        // Note: Full momentum re-computation requires Census/WalkScore/Crime calls.
        // For now, log that we'd check here. Full implementation when momentum
        // compute is extracted into a reusable helper.
      } catch (err) { /* skip */ }
    }
  }

  console.log('[AlertScanner] Scan complete');
}

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\nPropScout running at http://localhost:${PORT}\n`);
  console.log('Data sources:');
  if (RAPIDAPI_KEY) {
    console.log('  Zillow (RapidAPI): ACTIVE');
    console.log('  Realtor.com (RapidAPI): ACTIVE');
  } else {
    console.log('  Zillow (RapidAPI): not configured — add RAPIDAPI_KEY to .env');
    console.log('  Realtor.com (RapidAPI): not configured — add RAPIDAPI_KEY to .env');
  }
  if (RENTCAST_KEY) console.log('  RentCast: ACTIVE');
  else console.log('  RentCast: not configured — add RENTCAST_API_KEY to .env');
  console.log('  Census ACS (free): multi-year Y-o-Y comparison');
  console.log('  FBI Crime (free): multi-year trend analysis');
  if (WALKSCORE_KEY) console.log('  Walk Score: ACTIVE');
  if (GREATSCHOOLS_KEY) console.log('  GreatSchools: ACTIVE');
  console.log(`  SQLite: ${path.join(DATA_DIR, 'propscout.db')}`);
  console.log('  Cache: 24-hour TTL\n');

  // Download Zillow ZHVI data in background (non-blocking)
  downloadAndParseZHVI();

  // Background alert scanner — every 6 hours
  setInterval(() => { runAlertScanner().catch(err => console.error('[AlertScanner] Error:', err)); }, 6 * 60 * 60 * 1000);
  // Initial scan after 5 minutes (let ZHVI + cache warm up first)
  setTimeout(() => { runAlertScanner().catch(err => console.error('[AlertScanner] Error:', err)); }, 5 * 60 * 1000);
});
