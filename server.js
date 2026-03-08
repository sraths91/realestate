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
const SCHOOLDIGGER_APP_ID = process.env.SCHOOLDIGGER_APP_ID;
const SCHOOLDIGGER_API_KEY = process.env.SCHOOLDIGGER_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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

  CREATE TABLE IF NOT EXISTS agent_profiles (
    id INTEGER PRIMARY KEY DEFAULT 1,
    name TEXT,
    email TEXT,
    phone TEXT,
    logo_url TEXT,
    brand_color TEXT DEFAULT '#5b8df9',
    tagline TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    data_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT DEFAULT (datetime('now', '+30 days'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    client_type TEXT DEFAULT 'buyer',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS client_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    portfolio_id TEXT,
    data_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_client_activity ON client_activity(client_id, created_at);

  CREATE TABLE IF NOT EXISTS ai_cache (
    cache_key TEXT PRIMARY KEY,
    feature TEXT NOT NULL,
    response_json TEXT NOT NULL,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_cache (
    cache_key TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

// Extend portfolios table for client tracking (safe ALTER, ignore if already exists)
try { db.exec('ALTER TABLE portfolios ADD COLUMN client_id INTEGER'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE portfolios ADD COLUMN view_count INTEGER DEFAULT 0'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE portfolios ADD COLUMN last_viewed_at TEXT'); } catch { /* already exists */ }

// Cleanup old listing snapshots (keep 180 days)
try {
  const deleted = db.prepare("DELETE FROM listing_snapshots WHERE created_at < datetime('now', '-180 days')").run();
  if (deleted.changes > 0) console.log(`Cleaned up ${deleted.changes} old listing snapshots`);
} catch (e) { /* ignore on first run */ }
try {
  const alertsDel = db.prepare("DELETE FROM alerts WHERE created_at < datetime('now', '-90 days')").run();
  if (alertsDel.changes > 0) console.log(`Cleaned up ${alertsDel.changes} old alerts`);
} catch (e) { /* ignore on first run */ }
try {
  const reportsDel = db.prepare("DELETE FROM reports WHERE expires_at < datetime('now')").run();
  if (reportsDel.changes > 0) console.log(`Cleaned up ${reportsDel.changes} expired reports`);
} catch (e) { /* ignore on first run */ }
try {
  const aiDel = db.prepare("DELETE FROM ai_cache WHERE expires_at < datetime('now')").run();
  if (aiDel.changes > 0) console.log(`Cleaned up ${aiDel.changes} expired AI cache entries`);
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

// ---------------------------------------------------------------------------
// Persistent SQLite cache — survives Railway redeploys (for rate-limited APIs)
// ---------------------------------------------------------------------------

/**
 * Get from SQLite-backed cache. Returns null if expired or missing.
 * @param {string} key
 * @returns {*|null}
 */
function dbCacheGet(key) {
  try {
    const row = db.prepare(
      "SELECT data_json FROM api_cache WHERE cache_key = ? AND expires_at > datetime('now')"
    ).get(key);
    return row ? JSON.parse(row.data_json) : null;
  } catch { return null; }
}

/**
 * Write to SQLite-backed cache with configurable TTL.
 * @param {string} key
 * @param {*} data
 * @param {string} [ttl='7 days'] - SQLite date modifier (e.g. '24 hours', '7 days')
 */
function dbCacheSet(key, data, ttl = '7 days') {
  try {
    db.prepare(
      "INSERT OR REPLACE INTO api_cache (cache_key, data_json, expires_at) VALUES (?, ?, datetime('now', ?))"
    ).run(key, JSON.stringify(data), '+' + ttl);
  } catch (err) {
    console.log('dbCacheSet error:', err.message);
  }
}

// Cleanup expired api_cache entries on startup
try {
  const cleaned = db.prepare("DELETE FROM api_cache WHERE expires_at < datetime('now')").run();
  if (cleaned.changes > 0) console.log(`Cleaned up ${cleaned.changes} expired API cache entries`);
} catch { /* ignore on first run */ }

// ===========================================================================
// SHARED AI HELPER — Claude → OpenAI → Gemini → Groq with SQLite cache
// ===========================================================================

/** Check if daily AI request limit reached (18 of 20 RPD budget) */
function checkAIDailyLimit() {
  try {
    const { cnt } = db.prepare(
      "SELECT COUNT(*) as cnt FROM ai_cache WHERE created_at > datetime('now', '-1 day') AND source != 'template'"
    ).get();
    return cnt < 18;
  } catch { return true; }
}

/**
 * Call AI with cascading provider fallback and SQLite caching.
 * @param {string} prompt - The full prompt text
 * @param {Object} opts - { maxOutputTokens, cacheKey, cacheTTL, feature, jsonMode }
 * @returns {{ source: string, text: string, cached?: boolean } | null}
 */
async function callAI(prompt, opts = {}) {
  const { maxOutputTokens = 800, cacheKey, cacheTTL = '7 days', feature = 'general', jsonMode = false } = opts;

  // Check SQLite cache first
  if (cacheKey) {
    try {
      const cached = db.prepare(
        "SELECT response_json, source FROM ai_cache WHERE cache_key = ? AND expires_at > datetime('now')"
      ).get(cacheKey);
      if (cached) {
        return { source: cached.source, text: cached.response_json, cached: true };
      }
    } catch { /* cache miss */ }
  }

  // Check daily limit
  if (!checkAIDailyLimit()) {
    console.log('[AI] Daily limit reached (18/20), skipping API call');
    return null;
  }

  let result = null;

  // 1. Claude
  if (!result && ANTHROPIC_API_KEY) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxOutputTokens, messages: [{ role: 'user', content: prompt }] }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.content?.[0]?.text || '';
        if (text) result = { source: 'claude', text };
      }
    } catch (err) { console.log('[AI] Claude error:', err.message); }
  }

  // 2. OpenAI
  if (!result && OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: maxOutputTokens, messages: [{ role: 'user', content: prompt }] }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        if (text) result = { source: 'openai', text };
      }
    } catch (err) { console.log('[AI] OpenAI error:', err.message); }
  }

  // 3. Gemini (free tier)
  if (!result && GEMINI_API_KEY) {
    try {
      const genConfig = { maxOutputTokens };
      if (jsonMode) genConfig.responseMimeType = 'application/json';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: genConfig }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) result = { source: 'gemini', text };
        else console.log('[AI] Gemini: empty text, finishReason:', data.candidates?.[0]?.finishReason);
      } else {
        console.log('[AI] Gemini HTTP', res.status, await res.text().then(t => t.substring(0, 200)));
      }
    } catch (err) { console.log('[AI] Gemini error:', err.message); }
  }

  // 4. Groq (free tier)
  if (!result && GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxOutputTokens, messages: [{ role: 'user', content: prompt }] }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        if (text) result = { source: 'groq', text };
      }
    } catch (err) { console.log('[AI] Groq error:', err.message); }
  }

  // Save to SQLite cache
  if (result && cacheKey) {
    try {
      db.prepare(
        "INSERT OR REPLACE INTO ai_cache (cache_key, feature, response_json, source, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
      ).run(cacheKey, feature, result.text, result.source, '+' + cacheTTL);
    } catch { /* ignore cache write errors */ }
  }

  return result;
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
 * Fetch from RapidAPI Realty-in-US endpoint (GET with query params).
 * Host: realty-in-us.p.rapidapi.com
 */
async function realtorApiGet(endpoint, params = {}) {
  const url = new URL(`https://realty-in-us.p.rapidapi.com${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetch(url.toString(), {
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'realty-in-us.p.rapidapi.com',
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Realtor API ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

/**
 * Fetch from RapidAPI Realty-in-US endpoint (POST with JSON body).
 * Host: realty-in-us.p.rapidapi.com
 */
async function realtorApiPost(endpoint, body = {}) {
  const url = `https://realty-in-us.p.rapidapi.com${endpoint}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'realty-in-us.p.rapidapi.com',
    },
    body: JSON.stringify(body),
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
/**
 * Clean verbose Nominatim display_name into a simple address for API lookups.
 * "114, Northeast 3rd Avenue, St Anthony West, Minneapolis, Hennepin County, Minnesota, 55413, United States"
 * → "114 Northeast 3rd Avenue, Minneapolis, Minnesota 55413"
 * "Columbus Avenue South, Bryant, Regina, Powderhorn, Minneapolis, Hennepin County, Minnesota, 55417, United States"
 * → "Columbus Avenue South, Minneapolis, Minnesota 55417"
 */
function cleanAddress(raw) {
  // If it doesn't contain commas, it's already a simple address
  if (!raw.includes(',')) return raw.trim();
  const parts = raw.split(',').map(s => s.trim());
  // Remove country
  if (/united states|usa|^us$/i.test(parts[parts.length - 1])) parts.pop();
  // Extract and remove zip code
  const zipIdx = parts.findIndex(p => /^\d{5}/.test(p));
  const zip = zipIdx >= 0 ? parts.splice(zipIdx, 1)[0].slice(0, 5) : '';
  // Remove county parts
  const filtered = parts.filter(p => !/county$/i.test(p));
  if (filtered.length <= 3) {
    return (filtered.join(', ') + (zip ? ' ' + zip : '')).replace(/\s+/g, ' ').trim();
  }
  // Long Nominatim format: [number], street, [neighborhood(s)...], city, state
  // Detect: first part is a street number if it's purely numeric
  const hasStreetNum = /^\d+$/.test(filtered[0]);
  const street = hasStreetNum ? filtered.slice(0, 2).join(' ') : filtered[0];
  // State is always last, city is second-to-last
  const state = filtered[filtered.length - 1] || '';
  const city = filtered[filtered.length - 2] || '';
  return `${street}, ${city}, ${state}${zip ? ' ' + zip : ''}`.replace(/\s+/g, ' ').trim();
}

async function lookupProperty(address) {
  address = cleanAddress(address);
  const cacheKey = `lookup:${address.toLowerCase().trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };
  // Check persistent SQLite cache (survives redeploys)
  const dbCached = dbCacheGet(cacheKey);
  if (dbCached) {
    cacheSet(cacheKey, dbCached); // warm in-memory
    return { ...dbCached, cached: true };
  }

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

    // Source 2: RapidAPI Realty-in-US — auto-complete → v3/detail
    if (!result && RAPIDAPI_KEY) {
      try {
        // Step 1: auto-complete to find property_id
        const autoData = await realtorApiGet('/locations/v2/auto-complete', { input: address });
        const match = autoData?.autocomplete?.find(r => r.mpr_id) || autoData?.autocomplete?.[0];
        if (match?.mpr_id) {
          // Step 2: get full property detail
          const detailData = await realtorApiGet('/properties/v3/detail', { property_id: match.mpr_id });
          const prop = detailData?.data?.home;
          if (prop) {
            const addr = prop.location?.address || {};
            const desc = prop.description || {};
            const taxEntry = prop.tax_history?.[0];
            result = {
              source: 'realtor',
              property: {
                address: addr.line || address,
                city: addr.city || null,
                state: addr.state_code || addr.state || null,
                zipCode: addr.postal_code || null,
                propertyType: desc.type || null,
                bedrooms: desc.beds ?? null,
                bathrooms: desc.baths ?? null,
                squareFootage: desc.sqft ?? null,
                lotSize: desc.lot_sqft ?? null,
                yearBuilt: desc.year_built ?? null,
                lastSalePrice: prop.last_sold_price ?? null,
                lastSaleDate: prop.last_sold_date ?? null,
                taxAssessment: taxEntry?.assessment?.total ?? null,
                latitude: addr.coordinate?.lat ?? null,
                longitude: addr.coordinate?.lon ?? null,
                price: prop.list_price ?? null,
                zestimate: prop.estimate?.estimate ?? null,
                imgSrc: prop.photos?.[0]?.href ?? prop.primary_photo?.href ?? null,
                href: prop.href ?? null,
                daysOnMarket: prop.days_on_market ?? null,
                mortgage: prop.mortgage?.estimate ? {
                  monthlyPayment: prop.mortgage.estimate.monthly_payment,
                  downPayment: prop.mortgage.estimate.down_payment,
                  rate: prop.mortgage.estimate.average_rate?.rate,
                  loanAmount: prop.mortgage.estimate.loan_amount,
                } : null,
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
    dbCacheSet(cacheKey, result, '24 hours');
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
  const dbCached = dbCacheGet(cacheKey);
  if (dbCached) {
    cacheSet(cacheKey, dbCached);
    return { ...dbCached, cached: true };
  }

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

  // Source 2: RapidAPI Realty-in-US (Realtor.com) — v3/list
  if (!result && RAPIDAPI_KEY) {
    try {
      const body = {
        limit: lim || 25,
        offset: 0,
        status: ['for_sale'],
        sort: { direction: 'desc', field: 'list_date' },
      };
      if (zipCode) {
        body.postal_code = zipCode;
      } else if (city && state) {
        body.city = city;
        body.state_code = state;
      } else {
        // Free-text: use search_location with radius
        body.search_location = { location: loc, radius: 10 };
      }
      if (minPrice || maxPrice) {
        body.list_price = {};
        if (minPrice) body.list_price.min = Number(minPrice);
        if (maxPrice) body.list_price.max = Number(maxPrice);
      }
      if (beds) body.beds = { min: Number(beds) };
      if (baths) body.baths = { min: Number(baths) };

      const data = await realtorApiPost('/properties/v3/list', body);
      const props = data?.data?.home_search?.results || [];
      if (Array.isArray(props) && props.length > 0) {
        result = {
          source: 'realtor',
          listings: props.map(p => {
            const addr = p.location?.address || {};
            const desc = p.description || {};
            return {
              address: addr.line || '--', city: addr.city || null,
              state: addr.state_code || null, zipCode: addr.postal_code || null,
              price: p.list_price ?? 0,
              bedrooms: desc.beds ?? null,
              bathrooms: desc.baths ?? null,
              squareFootage: desc.sqft ?? null,
              propertyType: desc.type || null, yearBuilt: desc.year_built ?? null,
              daysOnMarket: null, latitude: addr.coordinate?.lat ?? null, longitude: addr.coordinate?.lon ?? null,
              status: p.status || 'for_sale', imgSrc: p.primary_photo?.href ?? null,
              zestimate: p.estimate?.estimate ?? null,
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
  dbCacheSet(cacheKey, response, '24 hours');
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
// School Ratings — SchoolDigger API (primary) → Census education (fallback)
// ---------------------------------------------------------------------------

/**
 * Fetch school ratings via SchoolDigger API (free dev/test: 20 calls/day).
 * Returns nearby schools with 0-5 star rankings, test scores, and state rank.
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {string} state - Two-letter state code (e.g. 'MN')
 * @param {string} zipCode - ZIP code for Census fallback
 * @returns {{ avgRating, schoolCount, topSchool, topRating, source, schools }}
 */
async function fetchSchoolRatings(lat, lon, state, zipCode) {
  const cacheKey = `schools:${lat.toFixed(3)},${lon.toFixed(3)}`;

  // Check in-memory cache first (fast)
  const memCached = cacheGet(cacheKey);
  if (memCached) return memCached;

  // Check persistent SQLite cache (survives redeploys)
  const dbCached = dbCacheGet(cacheKey);
  if (dbCached) {
    cacheSet(cacheKey, dbCached); // warm in-memory cache
    return dbCached;
  }

  // Try SchoolDigger first (richest data)
  if (SCHOOLDIGGER_APP_ID && SCHOOLDIGGER_API_KEY) {
    try {
      const result = await fetchSchoolDigger(lat, lon, state);
      if (result) {
        cacheSet(cacheKey, result);
        dbCacheSet(cacheKey, result, '7 days'); // persist to SQLite
        return result;
      }
    } catch (err) {
      console.log('SchoolDigger error:', err.message);
    }
  }

  // Try GreatSchools as second option
  if (GREATSCHOOLS_KEY) {
    try {
      const result = await fetchGreatSchools(lat, lon);
      if (result) {
        cacheSet(cacheKey, result);
        dbCacheSet(cacheKey, result, '7 days');
        return result;
      }
    } catch (err) {
      console.log('GreatSchools error:', err.message);
    }
  }

  // Free fallback: Census education attainment
  if (zipCode) {
    try {
      const result = await fetchCensusEducation(zipCode);
      if (result) {
        cacheSet(cacheKey, result);
        dbCacheSet(cacheKey, result, '30 days'); // Census data changes yearly
        return result;
      }
    } catch (err) {
      console.log('Census education error:', err.message);
    }
  }

  return null;
}

/**
 * SchoolDigger API — search nearby schools by lat/lon + state.
 * Free tier: 20 calls/day, 1/min, no credit card.
 * Docs: https://developer.schooldigger.com/docs
 */
async function fetchSchoolDigger(lat, lon, state) {
  if (!state) return null;
  const url = `https://api.schooldigger.com/v2.3/schools?st=${state}&nearLatitude=${lat}&nearLongitude=${lon}&nearMiles=5&perPage=10&sortBy=distance&appID=${SCHOOLDIGGER_APP_ID}&appKey=${SCHOOLDIGGER_API_KEY}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!r.ok) {
    if (r.status === 429) console.log('SchoolDigger rate limited (20/day free tier)');
    return null;
  }
  const data = await r.json();
  const schoolList = (data.schoolList || []).filter(s => s.rankHistory?.length > 0);
  if (!schoolList.length) return null;

  // SchoolDigger uses 0-5 star ranking
  const schools = schoolList.map(s => {
    const latestRank = s.rankHistory[0] || {};
    return {
      name: s.schoolName,
      level: s.schoolLevel || null,
      rating: latestRank.rankStars ?? null,
      stateRank: latestRank.rank ?? null,
      stateRankOf: latestRank.rankOf ?? null,
      rankPct: latestRank.rankOf ? Math.round((1 - latestRank.rank / latestRank.rankOf) * 100) : null,
      distance: s.distance ?? null,
    };
  }).filter(s => s.rating != null);

  if (!schools.length) return null;

  const avgRating = schools.reduce((sum, s) => sum + s.rating, 0) / schools.length;
  const topSchool = schools.sort((a, b) => b.rating - a.rating)[0];

  return {
    avgRating: +avgRating.toFixed(1),
    schoolCount: schools.length,
    topSchool: topSchool.name,
    topRating: topSchool.rating,
    topRankPct: topSchool.rankPct,
    source: 'SchoolDigger',
    schools,
  };
}

/**
 * GreatSchools API — nearby schools with 1-10 rating.
 * Requires paid API key ($52.50/mo minimum).
 */
async function fetchGreatSchools(lat, lon) {
  const url = `https://gs-api.greatschools.org/nearby-schools?lat=${lat}&lon=${lon}&limit=10&radius=5`;
  const r = await fetch(url, {
    headers: { 'X-API-Key': GREATSCHOOLS_KEY, 'User-Agent': 'PropScout/1.0' },
  });
  if (!r.ok) return null;
  const data = await r.json();
  const schools = (data.schools || []).filter(s => s.rating != null);
  if (!schools.length) return null;

  const avgRating = schools.reduce((s, sc) => s + sc.rating, 0) / schools.length;
  const sorted = [...schools].sort((a, b) => b.rating - a.rating);
  return {
    avgRating: +avgRating.toFixed(1),
    schoolCount: schools.length,
    topSchool: sorted[0]?.name || null,
    topRating: sorted[0]?.rating || null,
    source: 'GreatSchools',
  };
}

/**
 * Census ACS education attainment — free, no API key needed.
 * Fetches Bachelor's+ rate for a ZIP code as a proxy for school quality.
 * B15003_001E = total pop 25+, B15003_022E-025E = Bachelor's through Doctorate
 */
async function fetchCensusEducation(zipCode) {
  const vars = 'B15003_001E,B15003_022E,B15003_023E,B15003_024E,B15003_025E';
  const url = `https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=zip%20code%20tabulation%20area:${zipCode}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!r.ok) return null;
  const data = await r.json();
  if (!data || data.length < 2) return null;

  const row = data[1];
  const totalPop25 = parseInt(row[0]) || 0;
  const bachelors = parseInt(row[1]) || 0;
  const masters = parseInt(row[2]) || 0;
  const professional = parseInt(row[3]) || 0;
  const doctorate = parseInt(row[4]) || 0;

  if (totalPop25 === 0) return null;

  const collegeTotal = bachelors + masters + professional + doctorate;
  const collegeRate = +(collegeTotal / totalPop25 * 100).toFixed(1);
  // Convert to 0-5 star equivalent: national avg ~33%, map 0-66%+ → 0-5 stars
  const starEquivalent = +Math.min(5, (collegeRate / 66) * 5).toFixed(1);

  return {
    avgRating: starEquivalent,
    schoolCount: 0,
    topSchool: null,
    topRating: null,
    collegeRate,
    source: 'Census Education',
  };
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
 * FBI/BJS crime data by state — embedded from official NIBRS Estimation Program.
 * Source: "Crime Known to Law Enforcement, 2023" (BJS, Nov 2025, NCJ 310188)
 * Tables 3 & 4: offense rates per 100,000 U.S. residents, 2022–2023.
 * National rates: violent 407.3→387.8 (2022→2023), property 2085.6→2015.2
 * States marked null had statistically unreliable estimates (AK, AZ, HI).
 */
const STATE_CRIME_DATA = {
  // { violent2022, violent2023, property2022, property2023 } — rates per 100K
  AL: { violent2022: 453.3, violent2023: 430.6, property2022: 2288.1, property2023: 2077.6 },
  AK: { violent2022: null,  violent2023: null,  property2022: null,  property2023: null  },
  AZ: { violent2022: null,  violent2023: null,  property2022: null,  property2023: null  },
  AR: { violent2022: 622.3, violent2023: 579.4, property2022: 2288.4, property2023: 2288.9 },
  CA: { violent2022: 499.5, violent2023: 466.1, property2022: 2662.7, property2023: 2578.8 },
  CO: { violent2022: 492.4, violent2023: 477.1, property2022: 3127.9, property2023: 2818.3 },
  CT: { violent2022: 181.7, violent2023: 136.0, property2022: 1330.2, property2023: 1135.2 },
  DE: { violent2022: 383.4, violent2023: 378.6, property2022: 1963.9, property2023: 2024.2 },
  FL: { violent2022: 382.3, violent2023: 387.1, property2022: 1918.9, property2023: 1946.7 },
  GA: { violent2022: 380.0, violent2023: 355.6, property2022: 1849.5, property2023: null  },
  HI: { violent2022: null,  violent2023: null,  property2022: null,  property2023: null  },
  ID: { violent2022: 226.9, violent2023: 243.2, property2022: 851.8,  property2023: 1001.3 },
  IL: { violent2022: 416.1, violent2023: 379.3, property2022: 1745.7, property2023: 1702.3 },
  IN: { violent2022: 382.1, violent2023: 335.2, property2022: 1831.7, property2023: 1596.7 },
  IA: { violent2022: 304.4, violent2023: 284.6, property2022: 1527.2, property2023: 1527.9 },
  KS: { violent2022: 396.8, violent2023: 356.3, property2022: 2171.2, property2023: 1911.7 },
  KY: { violent2022: 247.4, violent2023: 231.3, property2022: 1399.8, property2023: 1312.0 },
  LA: { violent2022: 564.0, violent2023: 519.8, property2022: 2472.2, property2023: 2506.5 },
  ME: { violent2022: 108.8, violent2023: 103.7, property2022: 1258.7, property2023: 1148.3 },
  MD: { violent2022: 474.7, violent2023: 421.1, property2022: 2196.0, property2023: 2044.7 },
  MA: { violent2022: 269.1, violent2023: 249.7, property2022: 1179.8, property2023: 1025.7 },
  MI: { violent2022: 446.5, violent2023: 438.7, property2022: 1534.4, property2023: 1463.8 },
  MN: { violent2022: 255.4, violent2023: 261, violent2024: 259, property2022: 1937.1, property2023: 1730, property2024: 1634 },
  MS: { violent2022: null,  violent2023: 359.5, property2022: null,  property2023: 1390.0 },
  MO: { violent2022: 492.4, violent2023: 454.3, property2022: 2520.5, property2023: 2122.6 },
  MT: { violent2022: 380.6, violent2023: 343.9, property2022: 2087.7, property2023: 1903.4 },
  NE: { violent2022: 283.2, violent2023: 237.5, property2022: 1710.3, property2023: 1419.2 },
  NV: { violent2022: 368.3, violent2023: 359.5, property2022: 2013.0, property2023: 2160.7 },
  NH: { violent2022: 146.2, violent2023: 110.1, property2022: 907.1,  property2023: 948.5  },
  NJ: { violent2022: 201.5, violent2023: 191.2, property2022: 1288.0, property2023: 1087.6 },
  NM: { violent2022: 753.3, violent2023: 766.7, property2022: 3135.7, property2023: 3082.7 },
  NY: { violent2022: 363.4, violent2023: 348.2, property2022: 1512.5, property2023: 1412.7 },
  NC: { violent2022: 406.9, violent2023: 373.2, property2022: 2296.4, property2023: 2089.5 },
  ND: { violent2022: 288.2, violent2023: 266.3, property2022: 2047.2, property2023: 1893.9 },
  OH: { violent2022: 325.0, violent2023: 308.1, property2022: 1860.1, property2023: 1742.2 },
  OK: { violent2022: 412.4, violent2023: 380.5, property2022: 2533.3, property2023: 2426.2 },
  OR: { violent2022: 323.6, violent2023: 321.9, property2022: 2468.7, property2023: 2404.0 },
  PA: { violent2022: 346.2, violent2023: 318.3, property2022: 1310.3, property2023: 1187.4 },
  RI: { violent2022: 172.7, violent2023: 153.6, property2022: 1175.0, property2023: 1090.3 },
  SC: { violent2022: 530.5, violent2023: 495.3, property2022: 2490.4, property2023: 2341.2 },
  SD: { violent2022: 389.3, violent2023: 304.3, property2022: 1654.1, property2023: 1456.5 },
  TN: { violent2022: 620.5, violent2023: 592.3, property2022: 2536.1, property2023: 2384.1 },
  TX: { violent2022: 434.2, violent2023: 406.4, property2022: 2548.3, property2023: 2402.6 },
  UT: { violent2022: 233.4, violent2023: 230.3, property2022: 2116.2, property2023: 1883.5 },
  VT: { violent2022: 172.6, violent2023: 188.1, property2022: 1660.7, property2023: 1858.3 },
  VA: { violent2022: 208.3, violent2023: 207.7, property2022: 1370.5, property2023: 1291.3 },
  WA: { violent2022: 385.3, violent2023: 367.2, property2022: 3254.5, property2023: 3088.2 },
  WV: { violent2022: 319.5, violent2023: 291.9, property2022: 1247.5, property2023: 1073.1 },
  WI: { violent2022: 292.2, violent2023: 285.6, property2022: 1322.3, property2023: 1311.4 },
  WY: { violent2022: 192.2, violent2023: 203.4, property2022: 1350.9, property2023: 1284.3 },
  DC: { violent2022: null,  violent2023: null,  property2022: null,  property2023: null  },
};

/**
 * Look up FBI/BJS crime data by state abbreviation from embedded dataset.
 * Returns violent + property crime rates per 100K with 2022→2023 trend.
 * Source: BJS "Crime Known to Law Enforcement, 2023" (NCJ 310188, Nov 2025).
 */
function crimeDataLookup(stateAbbr) {
  if (!stateAbbr) return null;
  const abbr = stateAbbr.toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(abbr)) return null;

  const d = STATE_CRIME_DATA[abbr];
  if (!d) return null;

  // Use most recent year available (2024 if present, else 2023)
  const has2024 = d.violent2024 != null;
  const latestViolent = has2024 ? d.violent2024 : d.violent2023;
  const latestProperty = has2024 ? d.property2024 : d.property2023;
  const latestYear = has2024 ? 2024 : 2023;
  if (latestViolent == null) return null;

  // Build multi-year trend from all available data points
  const yearlyRates = [];
  if (d.violent2022 != null) {
    yearlyRates.push({ year: 2022, rate: Math.round(d.violent2022), propertyRate: d.property2022 ? Math.round(d.property2022) : null });
  }
  if (d.violent2023 != null) {
    yearlyRates.push({ year: 2023, rate: Math.round(d.violent2023), propertyRate: d.property2023 ? Math.round(d.property2023) : null });
  }
  if (d.violent2024 != null) {
    yearlyRates.push({ year: 2024, rate: Math.round(d.violent2024), propertyRate: d.property2024 ? Math.round(d.property2024) : null });
  }

  return {
    violentCrimeRate: Math.round(latestViolent),
    propertyCrimeRate: latestProperty ? Math.round(latestProperty) : null,
    year: latestYear,
    yearlyRates,
  };
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
 * @param {object|null} schools - School ratings (SchoolDigger, GreatSchools, or Census)
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

  // === 6. Schools (10%) + Walkability (5%) — or Walkability alone (10%) ===
  if (schools?.avgRating != null) {
    // Normalize to 0-100: SchoolDigger is 0-5 stars, GreatSchools is 1-10, Census is 0-5
    const maxScale = schools.source === 'GreatSchools' ? 10 : 5;
    const schoolScore = Math.min(100, Math.round((schools.avgRating / maxScale) * 100));
    let schoolDetail;
    if (schools.source === 'SchoolDigger') {
      schoolDetail = `${schools.avgRating}/5 stars (${schools.schoolCount} nearby)`;
      if (schools.topSchool && schools.topRankPct) {
        schoolDetail += ` • Top: ${schools.topSchool} (top ${100 - schools.topRankPct}%)`;
      }
    } else if (schools.source === 'Census Education') {
      schoolDetail = `${schools.collegeRate}% college-educated (Census)`;
    } else {
      schoolDetail = `${schools.avgRating}/10 avg (${schools.schoolCount} nearby)`;
    }
    factors.push({
      name: 'Schools', score: schoolScore, weight: 0.10,
      detail: schoolDetail,
    });
    dataSources.push(schools.source || 'Schools');
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
      Promise.resolve(state ? crimeDataLookup(state) : null),
      latF && lonF ? fetchSchoolRatings(latF, lonF, state, zipCode) : Promise.resolve(null),
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

// ===========================================================================
// MULTI-CITY NEARBY CRIME — Scalable Registry (ArcGIS + Socrata, free, no key)
// ===========================================================================

/** Each city entry defines its bbox, API type, endpoint, field mappings, and offense categorization. */
const CITY_CRIME_REGISTRY = [
  // ---------- MINNEAPOLIS (ArcGIS unified Crime_Data — all years, NIBRS, 16K limit) ----------
  {
    id: 'minneapolis',
    name: 'Minneapolis',
    state: 'MN',
    source: 'Minneapolis Police Department',
    type: 'arcgis',
    bbox: { minLat: 44.85, maxLat: 45.10, minLon: -93.45, maxLon: -93.15 },
    hasSpatialQuery: true,
    buildUrl: () =>
      'https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/Crime_Data/FeatureServer/0/query',
    buildParams: (lat, lon, radiusM, year) => ({
      where: `Reported_Date >= '${year}-01-01' AND Reported_Date <= '${year}-12-31'`,
      geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryPoint',
      spatialRel: 'esriSpatialRelIntersects',
      distance: radiusM,
      units: 'esriSRUnit_Meter',
      inSR: 4326,
      outFields: 'Offense_Category,Offense,Reported_Date,Neighborhood,Latitude,Longitude,NIBRS_Crime_Against',
      resultRecordCount: 2000,
      orderByFields: 'Reported_Date DESC',
      f: 'json',
    }),
    parseFeatures: (data) => (data.features || []).map(f => f.attributes),
    normalizeIncident: (inc) => ({
      offenseCode: (inc.Offense_Category || '').toUpperCase().trim(),
      description: inc.Offense || inc.Offense_Category || '',
      date: inc.Reported_Date ? new Date(inc.Reported_Date).toLocaleDateString() : null,
      neighborhood: inc.Neighborhood || null,
      lat: inc.Latitude, lon: inc.Longitude,
      nibrs: inc.NIBRS_Crime_Against || null,
    }),
    categorizeOffense: (code, inc) => {
      // Use NIBRS_Crime_Against for authoritative categorization when available
      const nibrs = (inc?.nibrs || '').toLowerCase().trim();
      if (nibrs === 'person') return 'violent';
      if (nibrs === 'property') return 'property';
      if (nibrs === 'society' || nibrs === 'not a crime' || nibrs === 'non nibrs data') return 'other';
      // Fallback to offense category keyword matching
      if (/ASSAULT|HOMICIDE|ROBBERY|RAPE|SEX|KIDNAP|ARSON|MURDER/.test(code)) return 'violent';
      if (/THEFT|BURGLARY|MOTOR VEHICLE|VANDAL|FRAUD|FORG/.test(code)) return 'property';
      return 'other';
    },
  },

  // ---------- ST. PAUL (ArcGIS table, no geometry — date-filtered, neighborhood-level) ----------
  {
    id: 'stpaul',
    name: 'St. Paul',
    state: 'MN',
    source: 'St. Paul Police Department',
    type: 'arcgis',
    bbox: { minLat: 44.88, maxLat: 44.99, minLon: -93.20, maxLon: -93.00 },
    hasSpatialQuery: false, // table with no geometry — date + neighborhood filtering
    buildUrl: () =>
      'https://services1.arcgis.com/9meaaHE3uiba0zr8/arcgis/rest/services/Crime_Incident_Report_-_Dataset/FeatureServer/0/query',
    buildParams: (_lat, _lon, _radiusM, year) => ({
      where: `DATE >= '${year}-01-01' AND DATE <= '${year}-12-31' AND INCIDENT NOT LIKE '%Proactive Police Visit%' AND INCIDENT NOT LIKE '%Community Engagement%'`,
      outFields: 'INCIDENT,INCIDENT_TYPE,DATE,NEIGHBORHOOD_NAME,BLOCK',
      resultRecordCount: 2000,
      orderByFields: 'DATE DESC',
      f: 'json',
    }),
    parseFeatures: (data) => (data.features || []).map(f => f.attributes),
    normalizeIncident: (inc) => ({
      offenseCode: (inc.INCIDENT || '').toUpperCase(),
      description: inc.INCIDENT_TYPE || inc.INCIDENT || '',
      date: inc.DATE ? new Date(inc.DATE).toLocaleDateString() : null,
      neighborhood: inc.NEIGHBORHOOD_NAME || null,
      lat: null, lon: null,
    }),
    categorizeOffense: (code) => {
      if (/MURDER|HOMICIDE|RAPE|ROBBERY|ASSAULT|CSC|KIDNAP|DOMESTIC|WEAPON/.test(code)) return 'violent';
      if (/BURGLARY|THEFT|AUTO THEFT|ARSON|VANDAL|FORG|FRAUD|SHOPLIFT|DAMAGE/.test(code)) return 'property';
      return 'other';
    },
  },

  // ---------- CHICAGO (Socrata) ----------
  {
    id: 'chicago',
    name: 'Chicago',
    state: 'IL',
    source: 'Chicago Police Department',
    type: 'socrata',
    bbox: { minLat: 41.64, maxLat: 42.03, minLon: -87.94, maxLon: -87.52 },
    hasSpatialQuery: true,
    endpoint: 'https://data.cityofchicago.org/resource/ijzp-q8t2.json',
    buildSocrataQuery: (lat, lon, radiusM, year) =>
      `$where=within_circle(location,${lat},${lon},${radiusM}) AND year='${year}'&$order=date DESC&$limit=500`,
    normalizeIncident: (r) => ({
      offenseCode: (r.primary_type || '').toUpperCase(),
      description: `${r.primary_type || ''} - ${r.description || ''}`.trim(),
      date: r.date ? new Date(r.date).toLocaleDateString() : null,
      neighborhood: r.block || null,
      lat: parseFloat(r.latitude) || null,
      lon: parseFloat(r.longitude) || null,
    }),
    categorizeOffense: (code) => {
      if (/HOMICIDE|ASSAULT|BATTERY|ROBBERY|SEX OFFENSE|CRIM SEXUAL|KIDNAPPING|HUMAN TRAFFICKING/.test(code)) return 'violent';
      if (/BURGLARY|THEFT|MOTOR VEHICLE|ARSON|CRIMINAL DAMAGE|DECEPTIVE/.test(code)) return 'property';
      return 'other';
    },
  },

  // ---------- SAN FRANCISCO (Socrata) ----------
  {
    id: 'sf',
    name: 'San Francisco',
    state: 'CA',
    source: 'SF Police Department',
    type: 'socrata',
    bbox: { minLat: 37.70, maxLat: 37.84, minLon: -122.52, maxLon: -122.35 },
    hasSpatialQuery: true,
    endpoint: 'https://data.sfgov.org/resource/wg3w-h783.json',
    buildSocrataQuery: (lat, lon, radiusM, year) =>
      `$where=within_circle(point,${lat},${lon},${radiusM}) AND incident_year='${year}'&$order=incident_date DESC&$limit=500`,
    normalizeIncident: (r) => ({
      offenseCode: (r.incident_category || '').toUpperCase(),
      description: r.incident_subcategory || r.incident_category || '',
      date: r.incident_date ? new Date(r.incident_date).toLocaleDateString() : null,
      neighborhood: r.analysis_neighborhood || null,
      lat: parseFloat(r.latitude) || null,
      lon: parseFloat(r.longitude) || null,
    }),
    categorizeOffense: (code) => {
      if (/ASSAULT|HOMICIDE|ROBBERY|SEX OFFENSE|RAPE|HUMAN TRAFFICKING|KIDNAPPING|WEAPONS/.test(code)) return 'violent';
      if (/BURGLARY|LARCENY|THEFT|MOTOR VEHICLE|ARSON|VANDALISM|FRAUD|FORGERY/.test(code)) return 'property';
      return 'other';
    },
  },

  // ---------- NEW YORK CITY (Socrata) ----------
  {
    id: 'nyc',
    name: 'New York City',
    state: 'NY',
    source: 'NYPD',
    type: 'socrata',
    bbox: { minLat: 40.49, maxLat: 40.92, minLon: -74.26, maxLon: -73.70 },
    hasSpatialQuery: true,
    endpoint: 'https://data.cityofnewyork.us/resource/5uac-w243.json',
    buildSocrataQuery: (lat, lon, radiusM, year) =>
      `$where=within_circle(lat_lon,${lat},${lon},${radiusM}) AND cmplnt_fr_dt>='${year}-01-01T00:00:00'&$order=cmplnt_fr_dt DESC&$limit=500`,
    normalizeIncident: (r) => ({
      offenseCode: (r.ofns_desc || '').toUpperCase(),
      description: r.ofns_desc || r.pd_desc || '',
      date: r.cmplnt_fr_dt ? new Date(r.cmplnt_fr_dt).toLocaleDateString() : null,
      neighborhood: r.boro_nm || null,
      lat: parseFloat(r.latitude) || null,
      lon: parseFloat(r.longitude) || null,
    }),
    categorizeOffense: (code) => {
      if (/MURDER|FELONY ASSAULT|ROBBERY|RAPE|SEX CRIMES|KIDNAPPING/.test(code)) return 'violent';
      if (/BURGLARY|LARCENY|THEFT|VEHICLE|ARSON|CRIMINAL MISCHIEF|FRAUD|FORGERY/.test(code)) return 'property';
      return 'other';
    },
  },

  // ---------- LOS ANGELES (Socrata) ----------
  {
    id: 'la',
    name: 'Los Angeles',
    state: 'CA',
    source: 'LAPD',
    type: 'socrata',
    bbox: { minLat: 33.70, maxLat: 34.34, minLon: -118.67, maxLon: -118.15 },
    hasSpatialQuery: true,
    endpoint: 'https://data.lacity.org/resource/2nrs-mtv8.json',
    buildSocrataQuery: (lat, lon, radiusM, year) => {
      // LA has separate lat/lon columns (no Socrata point column for within_circle)
      const degOffset = (radiusM / 1609.34) / 69; // rough miles → degrees
      const minLat = (lat - degOffset).toFixed(4);
      const maxLat = (lat + degOffset).toFixed(4);
      const minLon = (lon - degOffset).toFixed(4);
      const maxLon = (lon + degOffset).toFixed(4);
      return `$where=date_extract_y(date_occ)=${year} AND lat BETWEEN ${minLat} AND ${maxLat} AND lon BETWEEN ${minLon} AND ${maxLon}&$order=date_occ DESC&$limit=500`;
    },
    normalizeIncident: (r) => ({
      offenseCode: (r.crm_cd_desc || '').toUpperCase(),
      description: r.crm_cd_desc || '',
      date: r.date_occ ? new Date(r.date_occ).toLocaleDateString() : null,
      neighborhood: r.area_name || null,
      lat: parseFloat(r.lat) || null,
      lon: parseFloat(r.lon) || null,
    }),
    categorizeOffense: (code) => {
      if (/MURDER|ASSAULT|ROBBERY|RAPE|SEX|KIDNAP|BATTERY|MANSLAUGHTER|HOMICIDE/.test(code)) return 'violent';
      if (/BURGLARY|THEFT|STOLEN|VEHICLE|ARSON|VANDAL|FORGERY|FRAUD|SHOPLIFTING/.test(code)) return 'property';
      return 'other';
    },
  },
];

/** Find which city (if any) covers the given coordinates. */
function findCityForCoords(lat, lon) {
  return CITY_CRIME_REGISTRY.find(c =>
    lat >= c.bbox.minLat && lat <= c.bbox.maxLat &&
    lon >= c.bbox.minLon && lon <= c.bbox.maxLon
  ) || null;
}

/** Fetch incidents from an ArcGIS city config for a given year. */
async function fetchArcGISCrime(city, lat, lon, radiusM, year) {
  const url = city.buildUrl(year, lat, lon, radiusM);
  const params = new URLSearchParams(city.buildParams(lat, lon, radiusM, year));
  const res = await fetch(`${url}?${params}`, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!res.ok) return [];
  const data = await res.json();
  return city.parseFeatures(data);
}

/** Fetch incidents from a Socrata city config for a given year. */
async function fetchSocrataCrime(city, lat, lon, radiusM, year) {
  const qs = city.buildSocrataQuery(lat, lon, radiusM, year);
  const res = await fetch(`${city.endpoint}?${qs}`, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!res.ok) return [];
  return res.json();
}

/** Generic: fetch raw incidents from any supported city. */
async function fetchCityIncidents(city, lat, lon, radiusM, year) {
  if (city.type === 'arcgis') return fetchArcGISCrime(city, lat, lon, radiusM, year);
  if (city.type === 'socrata') return fetchSocrataCrime(city, lat, lon, radiusM, year);
  return [];
}

/** Categorize and summarize incidents using city-specific mappings. */
function summarizeIncidents(city, rawIncidents) {
  const cats = { violent: 0, property: 0, other: 0 };
  const offenseCounts = {};
  const normalized = [];

  for (const raw of rawIncidents) {
    const inc = city.normalizeIncident(raw);
    const cat = city.categorizeOffense(inc.offenseCode, inc);
    cats[cat]++;
    offenseCounts[inc.description] = (offenseCounts[inc.description] || 0) + 1;
    normalized.push(inc);
  }

  return { cats, offenseCounts, normalized };
}

// ---------------------------------------------------------------------------
// MN Statewide Crime Data (BCA Crime Data Explorer, 2025)
// 263 city police depts + 86 county sheriffs — covers ALL of Minnesota.
// Format: [name, county, population, crimeRate per 100K, pctCleared, lat, lon, priorYearRate]
// Source: https://cde.state.mn.us/DownloadData/CrimeRateAndClearanceByAgencyDownload
// Geocoded via OpenStreetMap Nominatim.
// Statewide 2025 split: ~14% violent, ~86% property (from BCA UCR).
// ---------------------------------------------------------------------------
const MN_CDE_CITIES = [
  ['Ada','Norman',1683,118,0.0,47.2997,-96.5153,177],
  ['Adrian','Nobles',1199,583,0.0,43.6349,-95.9334,594],
  ['Aitkin','Aitkin',2175,4045,54.5,46.5334,-93.7097,3769],
  ['Akeley','Hubbard',422,1421,50.0,47.0042,-94.727,2083],
  ['Albany','Stearns',2897,448,15.4,45.63,-94.57,1264],
  ['Albert Lea','Freeborn',18074,4481,50.4,43.648,-93.3683,4111],
  ['Alden','Freeborn',573,174,100.0,43.6703,-93.5762,null],
  ['Alexandria','Douglas',15043,2226,73.1,45.8835,-95.3745,3660],
  ['Annandale','Wright',3524,1560,38.2,45.2627,-94.1244,1448],
  ['Anoka','Anoka',18110,3268,42.2,45.1977,-93.3872,3767],
  ['Apple Valley','Dakota',55025,3362,27.1,44.7319,-93.2177,3736],
  ['Appleton','Swift',1344,520,85.7,45.1969,-96.0198,662],
  ['Arlington','Sibley',2334,728,58.8,44.6083,-94.0805,859],
  ['Atwater','Kandiyohi',1093,274,33.3,45.1363,-94.781,372],
  ['Audubon','Becker',570,877,60.0,46.8633,-95.9817,1247],
  ['Austin','Mower',26812,3931,43.4,43.668,-92.9746,4560],
  ['Avon','Stearns',1770,1355,8.3,45.6091,-94.4517,1634],
  ['Babbitt','St. Louis',1364,1612,45.5,47.7087,-91.9441,1605],
  ['Bagley','Clearwater',1309,763,100.0,47.5216,-95.3983,1983],
  ['Barnesville','Clay',2766,650,0.0,46.6522,-96.4198,939],
  ['Battle Lake','Otter Tail',929,968,55.6,46.2811,-95.714,753],
  ['Baxter','Crow Wing',9317,3799,63.0,46.3433,-94.2867,5362],
  ['Bayport','Washington',3727,804,56.7,45.0213,-92.7813,969],
  ['Becker','Sherburne',5344,1889,52.5,45.3932,-93.8769,1363],
  ['Belgrade Brooten','Stearns',1395,358,40.0,45.5021,-95.13,942],
  ['Belle Plaine','Scott',7463,1152,69.8,44.6227,-93.7686,1816],
  ['Bemidji','Beltrami',15815,11723,44.2,47.4723,-94.8833,11631],
  ['Benson','Swift',3398,882,96.7,45.315,-95.6,992],
  ['Big Lake','Sherburne',13141,1727,39.6,45.3325,-93.7461,1472],
  ['Blackduck','Beltrami',808,1485,50.0,47.7333,-94.5482,1481],
  ['Blaine','Anoka',76398,2412,48.4,45.1608,-93.2349,2886],
  ['Blooming Prairie','Steele',1931,1087,52.4,43.8668,-93.0553,1027],
  ['Bloomington','Hennepin',87974,5386,54.2,44.8322,-93.3205,6432],
  ['Blue Earth','Faribault',3157,1362,88.4,43.6375,-94.1022,1455],
  ['Braham','Isanti',1771,282,20.0,45.7247,-93.1706,223],
  ['Brainerd','Crow Wing',14407,7024,43.0,46.358,-94.2008,7608],
  ['Breckenridge','Wilkin',3281,1615,92.5,46.2652,-96.5816,3150],
  ['Breezy Point','Crow Wing',2793,429,100.0,46.6166,-94.2169,852],
  ['Breitung Township','St. Louis',528,2651,14.3,47.856,-92.2337,3422],
  ['Brooklyn Center','Hennepin',31297,6093,29.6,45.0749,-93.3296,6764],
  ['Brooklyn Park','Hennepin',82087,5428,24.8,45.1005,-93.3444,6096],
  ['Brownton','McLeod',702,854,33.3,44.7319,-94.3503,988],
  ['Buffalo','Wright',16851,872,64.6,45.1719,-93.8747,860],
  ['Buffalo Lake','Renville',639,312,100.0,44.7372,-94.6169,793],
  ['Burnsville','Dakota',64952,3000,31.6,44.7671,-93.2774,3638],
  ['Callaway','Becker',181,4972,77.8,46.9825,-95.9098,4371],
  ['Cambridge','Isanti',11325,1783,34.7,45.5727,-93.2244,2980],
  ['Canby','Yellow Medicine',1658,1266,9.5,44.7089,-96.2764,1070],
  ['Cannon Falls','Goodhue',4197,2668,45.5,44.5068,-92.9062,2955],
  ['Centennial Lakes','Anoka',12212,1613,37.6,45.1698,-93.1272,1653],
  ['Champlin','Hennepin',22848,2236,52.1,45.1889,-93.3975,2516],
  ['Chaska','Carver',30771,1592,47.3,44.7894,-93.6022,1719],
  ['Chatfield','Fillmore',3028,99,100.0,43.8446,-92.1881,100],
  ['Chisholm','St. Louis',4643,3489,36.4,47.4899,-92.8835,3688],
  ['Cleveland','Le Sueur',776,128,100.0,44.3255,-93.8377,129],
  ['Cloquet','Carlton',12452,1533,66.0,46.7217,-92.4614,1909],
  ['Cold Spring / Richmond','Stearns',5895,1391,50.0,45.4558,-94.4286,2052],
  ['Coleraine','Itasca',1993,702,71.4,47.2888,-93.4277,403],
  ['Columbia Heights','Anoka',23420,3125,20.2,45.046,-93.2518,4417],
  ['Coon Rapids','Anoka',63860,2958,39.4,45.1729,-93.3024,3367],
  ['Corcoran','Hennepin',9010,477,27.9,45.0951,-93.5476,845],
  ['Cottage Grove','Washington',43759,1540,50.6,44.8277,-92.9438,1620],
  ['Crookston','Polk',7216,3339,49.0,47.774,-96.6081,4760],
  ['Crosby','Crow Wing',2321,775,72.2,46.4822,-93.9578,1062],
  ['Crosslake','Crow Wing',2415,1739,26.2,46.6594,-94.1139,1228],
  ['Crystal','Hennepin',21801,4330,52.8,45.0318,-93.3606,4674],
  ['Dawson','Lac qui Parle',1563,639,10.0,44.9327,-96.0545,1662],
  ['Dayton','Hennepin',11784,992,15.4,45.2439,-93.515,1029],
  ['Deephaven','Hennepin',3734,589,40.9,44.9297,-93.5225,1164],
  ['Deer River','Itasca',935,3208,26.7,47.3328,-93.7928,2547],
  ['Deerwood','Crow Wing',569,527,100.0,46.4736,-93.8989,2249],
  ['Detroit Lakes','Becker',10032,3129,41.4,46.8172,-95.8453,2979],
  ['Dilworth','Clay',4864,7648,60.2,46.8766,-96.7034,9879],
  ['Duluth','St. Louis',88307,5694,33.7,46.7838,-92.1053,5705],
  ['Dundas','Rice',1831,2239,24.4,44.4294,-93.2021,2536],
  ['Eagan','Dakota',66870,2489,27.6,44.8182,-93.1659,3149],
  ['East Grand Forks','Polk',8858,1253,40.5,47.9317,-97.0176,1490],
  ['East Range','St. Louis',3627,165,33.3,47.5451,-92.3185,110],
  ['Eden Prairie','Hennepin',62593,2366,39.3,44.8547,-93.4708,2708],
  ['Eden Valley','Meeker',1078,278,0.0,45.325,-94.5476,1305],
  ['Edina','Hennepin',53617,2700,49.7,44.8897,-93.3501,2841],
  ['Elk River','Sherburne',28039,2336,38.2,45.3039,-93.5672,2885],
  ['Elko New Market','Scott',5290,37,100.0,44.5658,-93.3388,39],
  ['Ely','St. Louis',3202,3060,25.5,47.9016,-91.8572,2366],
  ['Eveleth','St. Louis',3398,6356,32.9,47.4628,-92.5388,5853],
  ['Fairfax','Renville',1210,1735,28.6,44.5291,-94.7208,2163],
  ['Fairmont','Martin',10110,4371,50.2,43.6522,-94.4611,4344],
  ['Faribault','Rice',25117,2711,34.1,44.295,-93.2688,3059],
  ['Farmington','Dakota',24671,1284,24.3,44.6402,-93.1435,1479],
  ['Fergus Falls','Otter Tail',14294,4967,33.7,46.283,-96.0776,5005],
  ['Floodwood','St. Louis',516,581,33.3,46.9291,-92.9196,1353],
  ['Foley','Benton',2726,3081,4.8,45.6635,-93.9137,2950],
  ['Forest Lake','Washington',20700,2806,30.1,45.2791,-92.9852,3442],
  ['Fosston','Polk',1366,5417,20.3,47.5763,-95.7514,5116],
  ['Frazee','Becker',1305,306,0.0,46.7278,-95.7001,538],
  ['Fridley','Anoka',30963,5613,50.1,45.0838,-93.259,5570],
  ['Fulda','Murray',1317,531,0.0,43.8705,-95.6003,1285],
  ['Gaylord','Sibley',2346,2941,78.3,44.553,-94.2206,3972],
  ['Gibbon','Sibley',789,1520,8.3,44.5339,-94.5264,1395],
  ['Gilbert','St. Louis',1647,4553,30.7,47.4889,-92.4652,6219],
  ['Glencoe','McLeod',5641,2889,27.6,44.7692,-94.1516,2689],
  ['Glenwood','Pope',2658,1091,31.0,45.6502,-95.3898,2281],
  ['Glyndon','Clay',1384,650,55.6,46.8752,-96.579,1380],
  ['Golden Valley','Hennepin',20970,1707,15.6,44.9861,-93.3785,1634],
  ['Goodview','Winona',4081,147,50.0,44.062,-91.6954,294],
  ['Grand Rapids','Itasca',11284,1542,18.4,47.2372,-93.5302,1782],
  ['Granite Falls','Yellow Medicine',2664,1051,85.7,44.81,-95.5456,2022],
  ['Hallock','Kittson',843,118,100.0,48.7744,-96.9464,347],
  ['Hastings','Dakota',22591,2518,42.9,44.7427,-92.8519,2690],
  ['Hawley','Clay',2284,350,0.0,46.8808,-96.3167,1000],
  ['Hector','Renville',988,202,50.0,44.7439,-94.7155,1732],
  ['Henning','Otter Tail',858,349,33.3,46.3216,-95.4453,465],
  ['Hermantown','St. Louis',10276,3230,58.1,46.8069,-92.2382,3893],
  ['Hibbing','St. Louis',15881,881,83.6,47.4272,-92.9377,1118],
  ['Hill City','Aitkin',616,2759,23.5,46.9933,-93.5986,1315],
  ['Hopkins','Hennepin',19584,3676,44.6,44.9244,-93.4114,4112],
  ['Houston','Houston',963,726,0.0,43.7633,-91.5685,1329],
  ['Howard Lake','Wright',2289,742,11.8,45.0608,-94.0733,720],
  ['Hutchinson','McLeod',14734,2769,46.3,44.8877,-94.3697,3306],
  ['International Falls','Koochiching',5430,2762,28.0,48.601,-93.4106,3644],
  ['Inver Grove Heights','Dakota',36327,2664,25.1,44.8479,-93.0428,3344],
  ['Isanti','Isanti',7655,613,36.2,45.4902,-93.2477,1883],
  ['Isle','Mille Lacs',832,7331,39.3,46.138,-93.4708,10000],
  ['Janesville','Waseca',2465,2190,33.3,44.1161,-93.708,2173],
  ['Jordan','Scott',6873,1396,51.0,44.6663,-93.6262,1754],
  ['Kasson','Dodge',7288,1948,45.8,44.0297,-92.7503,1581],
  ['Keewatin','Itasca',965,1243,58.3,47.3973,-93.0779,3305],
  ['La Crescent','Houston',5236,744,51.3,43.828,-91.304,1079],
  ['Lake City','Wabasha',5320,1710,51.6,44.4478,-92.2679,2380],
  ['Lake Crystal','Blue Earth',2471,1780,27.3,44.1058,-94.2188,1487],
  ['Lake Park','Becker',711,1265,0.0,46.8856,-96.0957,1117],
  ['Lake Shore','Cass',1137,439,0.0,46.4855,-94.3606,877],
  ['Lakefield','Jackson',1704,234,25.0,43.6775,-95.1717,175],
  ['Lakes Area','Chisago',11047,1321,26.7,45.3896,-92.8495,1947],
  ['Lakeville','Dakota',80095,1237,25.3,44.6501,-93.2433,1463],
  ['Lamberton','Redwood',777,1673,7.7,44.2311,-95.2642,1925],
  ['Le Center','Le Sueur',2533,197,100.0,44.3894,-93.7302,277],
  ['Le Sueur','Le Sueur',4237,684,93.1,44.4612,-93.9154,804],
  ['Lino Lakes','Anoka',23111,1176,39.7,45.1602,-93.0888,1415],
  ['Litchfield','Meeker',6487,2605,21.3,45.1272,-94.528,2564],
  ['Little Falls','Morrison',9228,3933,52.1,45.9764,-94.3625,4170],
  ['Long Prairie','Todd',3724,2067,41.6,45.9741,-94.8653,3062],
  ['Lonsdale','Rice',5159,639,0.0,44.4802,-93.4286,837],
  ['Madelia','Watonwan',2438,1599,25.6,44.0507,-94.4183,1056],
  ['Madison Lake','Blue Earth',1330,902,33.3,44.2044,-93.8155,1593],
  ['Mankato','Blue Earth',46927,5689,51.9,44.1659,-94.0028,6463],
  ['Maple Grove','Hennepin',73363,2696,34.2,45.0985,-93.4419,3113],
  ['Mapleton','Blue Earth',2133,2859,49.2,43.9289,-93.9561,1305],
  ['Maplewood','Ramsey',39828,5917,30.2,45.0082,-93.0457,6289],
  ['Marshall','Lyon',14033,2914,74.3,44.447,-95.7887,2556],
  ['Medina','Hennepin',7302,616,17.8,45.0151,-93.5744,1295],
  ['Melrose','Stearns',3993,676,37.0,45.6747,-94.8076,692],
  ['Menahga','Wadena',1370,510,85.7,46.7539,-95.0977,519],
  ['Mendota Heights','Dakota',11489,1975,22.0,44.8836,-93.1383,2617],
  ['Milaca','Mille Lacs',3073,2766,42.4,45.7558,-93.6544,3620],
  ['Minneapolis','Hennepin',428057,10325,16.2,44.9773,-93.2655,11077],
  ['Minnesota Lake','Faribault',660,757,100.0,43.841,-93.8327,456],
  ['Minnetonka','Hennepin',52294,2375,31.9,44.9405,-93.4639,2922],
  ['Minnetrista','Hennepin',11431,638,37.0,44.9236,-93.7187,903],
  ['Montgomery','Le Sueur',3609,193,85.7,44.4389,-93.5813,389],
  ['Moorhead','Clay',46027,3619,34.4,46.8739,-96.7539,4143],
  ['Motley','Morrison',688,3779,11.5,46.3366,-94.6461,3328],
  ['Mounds View','Ramsey',12779,2410,25.0,45.1069,-93.2076,2977],
  ['Mountain Lake','Cottonwood',1931,2692,23.1,43.9393,-94.9309,1347],
  ['Nashwauk','Itasca',958,104,100.0,47.3775,-93.1664,1047],
  ['New Brighton','Ramsey',22189,2411,28.4,45.0629,-93.2061,2765],
  ['New Hope','Hennepin',20465,4197,16.6,45.0347,-93.3861,4911],
  ['New Prague','Scott',8255,2265,25.1,44.5436,-93.5159,2020],
  ['New Richland','Waseca',1180,3559,35.7,43.8938,-93.4938,4789],
  ['New Ulm','Brown',13931,2225,60.0,44.314,-94.4614,2518],
  ['New York Mills','Otter Tail',1516,1055,43.8,46.518,-95.3763,737],
  ['Nisswa','Crow Wing',2205,1632,16.7,46.5205,-94.2886,2160],
  ['North Branch','Chisago',12637,838,37.7,45.5114,-92.9802,758],
  ['North Mankato','Nicollet',14103,2786,38.2,44.1733,-94.0338,3138],
  ['North St Paul','Ramsey',12766,4582,16.6,45.0123,-92.9923,3149],
  ['Northfield','Rice',21442,2205,38.5,44.4582,-93.1612,2748],
  ['Oak Park Heights','Washington',4633,4360,40.1,45.0314,-92.793,5102],
  ['Oakdale','Washington',31027,3271,25.9,44.9856,-92.9646,4086],
  ['Olivia','Renville',2295,1742,52.5,44.7764,-94.9897,2555],
  ['Onamia','Mille Lacs',844,6990,32.2,46.0705,-93.6677,7058],
  ['Orono','Hennepin',19315,1113,39.5,44.9714,-93.6044,1472],
  ['Osakis','Douglas',1741,976,29.4,45.8669,-95.1524,1831],
  ['Osseo','Hennepin',2490,1807,26.7,45.1194,-93.4025,3155],
  ['Owatonna','Steele',26680,2155,33.9,44.084,-93.2261,2291],
  ['Park Rapids','Hubbard',4437,3786,63.1,46.9222,-95.0586,4990],
  ['Parkers Prairie','Otter Tail',1032,872,22.2,46.153,-95.3289,581],
  ['Paynesville','Stearns',2636,1062,10.7,45.3805,-94.7119,726],
  ['Pelican Rapids','Otter Tail',2594,385,100.0,46.5708,-96.0831,615],
  ['Perham','Otter Tail',3758,292,72.7,46.5944,-95.5725,645],
  ['Pierz','Morrison',1471,2923,4.7,45.9772,-94.1035,3801],
  ['Pine River','Cass',927,2373,9.1,46.718,-94.4042,3315],
  ['Plainview','Wabasha',3503,570,85.0,44.1647,-92.1718,734],
  ['Plymouth','Hennepin',77963,1932,27.1,45.0065,-93.4665,2170],
  ['Preston','Fillmore',1315,2585,17.6,43.6702,-92.0832,1055],
  ['Princeton','Mille Lacs',5412,2087,87.6,45.5698,-93.5803,3414],
  ['Prior Lake','Scott',28117,2578,41.9,44.7133,-93.4227,2712],
  ['Proctor','St. Louis',3067,2673,43.9,46.7472,-92.2255,1981],
  ['Ramsey','Anoka',29304,1245,30.4,45.2321,-93.4605,1534],
  ['Red Wing','Goodhue',16828,4849,51.8,44.5625,-92.5338,5446],
  ['Redwood Falls','Redwood',5021,3345,54.2,44.5394,-95.1164,4004],
  ['Renville','Renville',1709,2633,15.6,44.7891,-95.2117,3269],
  ['Rice','Benton',2268,264,0.0,45.7537,-94.2206,666],
  ['Richfield','Hennepin',36384,4721,53.0,44.8766,-93.2878,5244],
  ['Robbinsdale','Hennepin',13850,3920,37.4,45.0313,-93.3396,4233],
  ['Rochester','Olmsted',124142,3243,40.6,44.0234,-92.463,3591],
  ['Rogers','Hennepin',14805,4991,46.8,45.1889,-93.5525,4017],
  ['Roseau','Roseau',2688,3683,27.3,48.8458,-95.7613,2054],
  ['Rosemount','Dakota',31932,1525,31.2,44.7392,-93.1261,1534],
  ['Roseville','Ramsey',35618,10887,49.5,45.0061,-93.1566,12549],
  ['Royalton','Morrison',1279,2814,30.6,45.8299,-94.2937,4222],
  ['Sartell','Stearns',20133,1942,29.4,45.6216,-94.2069,2015],
  ['Sauk Centre','Stearns',4711,1400,66.7,45.7375,-94.9525,2075],
  ['Sauk Rapids','Benton',13816,2330,44.7,45.5913,-94.1674,2307],
  ['Savage','Scott',32977,1916,43.5,44.7779,-93.3356,2275],
  ['Shakopee','Scott',49549,2873,45.9,44.798,-93.5269,3082],
  ['Sherburn Welcome','Martin',1047,2101,72.7,43.6623,-94.7323,2387],
  ['Silver Bay','Lake',1756,455,75.0,47.2943,-91.2574,668],
  ['Slayton','Murray',1955,1176,21.7,43.9877,-95.7558,1984],
  ['Sleepy Eye','Brown',3501,771,37.0,44.2972,-94.7242,629],
  ['South Lake Minnetonka','Hennepin',12057,829,22.0,44.892,-93.4414,735],
  ['South St Paul','Dakota',20560,3516,35.7,44.8907,-93.0373,4324],
  ['Spring Lake Park','Anoka',7059,3824,19.3,45.1154,-93.2493,3567],
  ['Springfield','Brown',1986,453,22.2,44.2386,-94.9758,1616],
  ['St Anthony','Hennepin',12595,5788,32.2,45.0283,-93.2187,4384],
  ['St Charles','Winona',4065,1008,19.5,43.9694,-92.066,1731],
  ['St Cloud','Stearns',72794,5705,39.1,45.5616,-94.1642,6424],
  ['St Francis','Anoka',8613,1695,24.0,45.3864,-93.3597,2367],
  ['St James','Watonwan',4737,2849,57.8,43.9825,-94.6269,2291],
  ['St Joseph','Stearns',6974,1706,42.9,45.5645,-94.3181,2000],
  ['St Louis Park','Hennepin',49870,5506,26.1,44.9476,-93.3569,6081],
  ['St Paul','Ramsey',307657,6436,18.4,44.9497,-93.0931,6935],
  ['St Paul Park','Washington',5341,1759,36.2,44.8479,-92.9981,2351],
  ['St Peter','Nicollet',12552,1641,61.2,44.3238,-93.9585,2127],
  ['Staples','Todd',3090,2815,55.2,46.355,-94.7933,3780],
  ['Starbuck','Pope',1432,1466,42.9,45.6145,-95.5311,563],
  ['Stillwater','Washington',19382,1914,39.4,45.0559,-92.8076,2053],
  ['Thief River Falls','Pennington',8764,3217,19.1,48.1172,-96.1771,3754],
  ['Trimont','Martin',684,730,60.0,43.7622,-94.7072,1598],
  ['Two Harbors','Lake',3414,1347,34.8,47.0257,-91.6731,1743],
  ['Tyler','Lincoln',1094,274,0.0,44.2783,-96.1348,274],
  ['Verndale','Wadena',512,195,0.0,46.3983,-95.0147,196],
  ['Virginia','St. Louis',8231,5212,63.6,47.5233,-92.5366,5719],
  ['Wabasha','Wabasha',2606,2570,67.2,44.3839,-92.032,3264],
  ['Wadena','Wadena',4378,2558,62.5,46.4425,-95.1361,2703],
  ['Waite Park','Stearns',8545,6167,57.1,45.5537,-94.2335,6180],
  ['Walker','Cass',983,1831,33.3,47.1016,-94.5798,1829],
  ['Waseca','Waseca',9030,2524,52.6,44.0777,-93.5076,2690],
  ['Wayzata','Hennepin',6275,2103,22.0,44.9708,-93.5119,2647],
  ['Wells','Faribault',2400,333,37.5,43.7441,-93.7256,876],
  ['West Concord','Dodge',837,716,33.3,44.1534,-92.8992,719],
  ['West Hennepin','Hennepin',5327,1520,32.1,44.9719,-93.2463,1148],
  ['West St Paul','Dakota',22278,7110,41.5,44.9102,-93.0802,7515],
  ['White Bear Lake','Ramsey',23245,2662,20.0,45.0838,-93.0069,2960],
  ['Willmar','Kandiyohi',22110,3559,60.4,45.1219,-95.0435,4133],
  ['Windom','Cottonwood',4794,2565,48.8,43.8663,-95.1169,2670],
  ['Winnebago Public Safety','Faribault',1379,2393,51.5,43.7694,-94.1661,null],
  ['Winona','Winona',26221,3821,53.6,44.05,-91.6392,4231],
  ['Winsted Lester Prairie','McLeod',4111,1556,43.8,44.9636,-94.0489,null],
  ['Winthrop','Sibley',1333,2175,79.3,44.543,-94.3664,903],
  ['Woodbury','Washington',81929,2363,42.9,44.9199,-92.9339,2454],
  ['Worthington','Nobles',13721,2747,63.4,43.6205,-95.5956,3150],
  ['Wyoming','Chisago',8208,1352,23.4,45.3364,-92.9972,1510],
  ['Zumbrota','Goodhue',4086,930,21.1,44.294,-92.6689,1121],
];
// County sheriff data: [county, population, crimeRate, pctCleared, priorYearRate]
const MN_CDE_COUNTIES = [
  ['Aitkin',13370,2206,31.9,2639],['Anoka',88166,1110,30.8,1315],['Becker',22801,1517,35.8,1614],
  ['Beltrami',30396,1858,31.3,2128],['Benton',13959,1074,38.7,1052],['Big Stone',5058,2866,20.0,2886],
  ['Blue Earth',18412,1330,37.1,1654],['Brown',6312,1093,18.8,1234],['Carlton',24534,1312,34.2,1332],
  ['Carver',83537,1402,50.5,1566],['Cass',28262,1765,31.7,1867],['Chippewa',6078,16,100.0,33],
  ['Chisago',27988,1221,51.8,1193],['Clay',10083,1705,36.6,1606],['Clearwater',6892,275,78.9,689],
  ['Cook',5580,1827,27.5,1912],['Cottonwood',3871,309,58.3,308],['Crow Wing',32593,908,34.5,1138],
  ['Dakota',19599,1816,39.9,1258],['Dodge',13264,1485,32.5,1438],['Douglas',23612,1185,46.4,1691],
  ['Faribault',6332,1405,73.0,1848],['Fillmore',16595,102,47.1,196],['Freeborn',11606,1912,40.5,1769],
  ['Goodhue',20329,2164,32.3,2286],['Grant',6131,782,95.8,886],['Hennepin',10082,7805,80.1,5484],
  ['Houston',8888,1012,47.8,1481],['Hubbard',17420,2129,61.5,2694],['Isanti',23650,1568,17.8,2099],
  ['Itasca',28721,1744,44.9,1630],['Jackson',8152,1140,33.3,1837],['Kanabec',16794,1429,36.2,1660],
  ['Kandiyohi',21834,1822,45.2,1928],['Kittson',3112,642,65.0,974],['Koochiching',6088,689,42.9,740],
  ['Lac qui Parle',5075,709,30.6,824],['Lake',5505,999,20.0,675],['Le Sueur',13263,655,60.9,692],
  ['Lincoln',4466,671,33.3,788],['Lyon',8261,1053,33.3,1296],['Mahnomen',5287,2742,29.0,3479],
  ['Marshall',8728,481,26.2,488],['Martin',7667,795,47.5,816],['McLeod',11699,1812,66.0,2071],
  ['Meeker',16521,1216,30.8,1576],['Mille Lacs',18042,2932,41.8,3315],['Morrison',22096,2086,20.2,2254],
  ['Mower',14413,2303,41.0,2863],['Murray',4764,419,35.0,689],['Nicollet',7926,126,90.0,472],
  ['Nobles',7049,595,54.8,1136],['Norman',4581,283,100.0,322],['Olmsted',42432,1251,40.9,1314],
  ['Otter Tail',36163,1003,32.8,1229],['Pennington',4852,1339,29.2,2007],['Pine',30771,2044,33.9,2493],
  ['Pipestone',9047,1215,62.7,1468],['Polk',12890,1745,33.3,1500],['Pope',7478,601,24.4,817],
  ['Ramsey',80782,3017,39.5,3153],['Red Lake',3877,335,100.0,635],['Redwood',7851,1502,89.0,1789],
  ['Renville',7593,3200,33.3,2867],['Rice',17401,482,66.7,769],['Rock',9511,725,36.2,333],
  ['Roseau',10581,387,73.2,562],['Scott',24170,868,18.6,668],['Sherburne',50096,824,58.4,1065],
  ['Sibley',7538,451,73.5,809],['St. Louis',56832,1940,37.7,1826],['Stearns',50824,456,58.6,858],
  ['Steele',8938,1499,30.6,1737],['Stevens',9885,1982,30.1,2188],['Swift',4913,81,75.0,80],
  ['Todd',20144,1866,51.1,1606],['Traverse',3088,712,27.3,905],['Wabasha',11154,349,35.9,352],
  ['Wadena',6748,948,76.6,776],['Waseca',5993,1968,15.3,2410],['Washington',77899,1439,29.6,1787],
  ['Watonwan',4051,1308,49.1,2160],['Wilkin',2952,643,78.9,467],['Winona',14236,1236,22.2,1338],
  ['Wright',135626,884,64.6,1171],['Yellow Medicine',5955,369,50.0,757],
];

// MN statewide violent/property split ratio (from BCA UCR)
const MN_VIOLENT_RATIO = 0.14;

/** Find nearest MN city or county for given coordinates. */
function findMNCityForCoords(lat, lon) {
  // Quick bounds check: Minnesota lat ~43.5–49.4, lon ~-97.2–-89.5
  if (lat < 43.3 || lat > 49.5 || lon < -97.5 || lon > -89.0) return null;

  let closest = null;
  let minDist = Infinity;
  for (const row of MN_CDE_CITIES) {
    // [name, county, pop, rate, cleared, lat, lon]
    if (row[2] === 0) continue; // skip zero-pop entries
    const dlat = lat - row[5];
    const dlon = lon - row[6];
    const dist = dlat * dlat + dlon * dlon;
    if (dist < minDist) { minDist = dist; closest = row; }
  }

  // ~0.08 deg ≈ 5.5 miles — match to nearest city within this radius
  if (closest && minDist < 0.0064) { // 0.08^2
    const totalRate = closest[3];
    const priorRate = closest[7]; // 2024 rate (null if new agency)
    const yoyChange = priorRate != null ? Math.round(((totalRate - priorRate) / priorRate) * 1000) / 10 : null;
    return {
      type: 'city',
      name: closest[0],
      county: closest[1],
      pop: closest[2],
      totalRate,
      violentRate: Math.round(totalRate * MN_VIOLENT_RATIO),
      propertyRate: Math.round(totalRate * (1 - MN_VIOLENT_RATIO)),
      pctCleared: closest[4],
      priorYear: 2024,
      priorRate,
      priorViolentRate: priorRate != null ? Math.round(priorRate * MN_VIOLENT_RATIO) : null,
      priorPropertyRate: priorRate != null ? Math.round(priorRate * (1 - MN_VIOLENT_RATIO)) : null,
      yoyChange,
    };
  }

  // Fallback: find county by matching nearest city's county (even if > 5.5 mi)
  if (closest && minDist < 0.25) { // ~35 miles — still in same general area
    const countyName = closest[1];
    const countyRow = MN_CDE_COUNTIES.find(c => c[0] === countyName);
    if (countyRow) {
      const totalRate = countyRow[2];
      const priorRate = countyRow[4]; // 2024 rate
      const yoyChange = priorRate != null ? Math.round(((totalRate - priorRate) / priorRate) * 1000) / 10 : null;
      return {
        type: 'county',
        name: countyName + ' County',
        county: countyName,
        pop: countyRow[1],
        totalRate,
        violentRate: Math.round(totalRate * MN_VIOLENT_RATIO),
        propertyRate: Math.round(totalRate * (1 - MN_VIOLENT_RATIO)),
        pctCleared: countyRow[3],
        priorYear: 2024,
        priorRate,
        priorViolentRate: priorRate != null ? Math.round(priorRate * MN_VIOLENT_RATIO) : null,
        priorPropertyRate: priorRate != null ? Math.round(priorRate * (1 - MN_VIOLENT_RATIO)) : null,
        yoyChange,
      };
    }
  }

  return null;
}

app.get('/api/crime/nearby', async (req, res) => {
  try {
    const { lat, lon, radius } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

    const latF = parseFloat(lat);
    const lonF = parseFloat(lon);
    const radiusMiles = parseFloat(radius) || 0.5;
    const radiusMeters = Math.min(radiusMiles, 2) * 1609.34;

    const city = findCityForCoords(latF, lonF);

    // If no incident-level city match, try MN statewide BCA data (274 cities + 86 counties)
    if (!city) {
      const mnMatch = findMNCityForCoords(latF, lonF);
      if (mnMatch) {
        const safeLevel = mnMatch.violentRate < 100 ? 'Low' : mnMatch.violentRate < 300 ? 'Moderate' : mnMatch.violentRate < 600 ? 'Elevated' : 'High';
        return res.json({
          available: true,
          dataType: 'aggregate',
          cityId: mnMatch.name.toLowerCase().replace(/[\s/.]+/g, '-'),
          cityName: mnMatch.name,
          county: mnMatch.county,
          matchType: mnMatch.type, // 'city' or 'county'
          source: 'MN Bureau of Criminal Apprehension (BCA Crime Data Explorer)',
          year: 2025,
          population: mnMatch.pop,
          violentRate: mnMatch.violentRate,
          propertyRate: mnMatch.propertyRate,
          totalRate: mnMatch.totalRate,
          pctCleared: mnMatch.pctCleared,
          safetyLevel: safeLevel,
          hasSpatialQuery: false,
          priorYear: mnMatch.priorYear,
          priorRate: mnMatch.priorRate,
          priorViolentRate: mnMatch.priorViolentRate,
          priorPropertyRate: mnMatch.priorPropertyRate,
          yoyChange: mnMatch.yoyChange,
          note: mnMatch.type === 'county'
            ? `County-level crime rates per 100,000 residents. ${mnMatch.county} County sheriff jurisdiction.`
            : 'City-level crime rates per 100,000 residents from BCA Crime Data Explorer. Violent/property split estimated from statewide ratio.',
        });
      }
      return res.json({ available: false, reason: 'No crime data coverage for this location' });
    }

    const cacheKey = `crime:${city.id}:${latF.toFixed(3)},${lonF.toFixed(3)},${radiusMiles}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    let currentYear = new Date().getFullYear();
    let priorYear = currentYear - 1;

    // Fetch current + prior year in parallel
    let [currentRaw, priorRaw] = await Promise.all([
      fetchCityIncidents(city, latF, lonF, radiusMeters, currentYear).catch(() => []),
      fetchCityIncidents(city, latF, lonF, radiusMeters, priorYear).catch(() => []),
    ]);

    // If current year has no data, try progressively older years (max 2 fallbacks)
    for (let fallback = 0; fallback < 2 && currentRaw.length === 0; fallback++) {
      currentYear = priorYear;
      priorYear = currentYear - 1;
      currentRaw = priorRaw.length > 0 ? priorRaw :
        await fetchCityIncidents(city, latF, lonF, radiusMeters, currentYear).catch(() => []);
      priorRaw = currentRaw.length > 0
        ? await fetchCityIncidents(city, latF, lonF, radiusMeters, priorYear).catch(() => [])
        : [];
    }

    const current = summarizeIncidents(city, currentRaw);
    const prior = summarizeIncidents(city, priorRaw);

    // Top offenses
    const topOffenses = Object.entries(current.offenseCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    // Recent incidents (last 10)
    const recentIncidents = current.normalized.slice(0, 10).map(inc => ({
      offense: inc.description,
      date: inc.date,
      neighborhood: inc.neighborhood,
      lat: inc.lat,
      lon: inc.lon,
    }));

    // Year-over-year trend (annualize partial year)
    const now = new Date();
    const monthsElapsed = now.getMonth() + (now.getDate() / 30);
    const isPartialYear = currentYear === now.getFullYear() && monthsElapsed < 11;
    const annualizedCurrent = isPartialYear && monthsElapsed > 0
      ? Math.round(currentRaw.length * (12 / monthsElapsed))
      : currentRaw.length;
    // Don't compute YoY if either side likely hit a query limit (comparison is meaningless)
    const resultsCapped = currentRaw.length >= 500 && currentRaw.length % 500 === 0 ||
      priorRaw.length >= 500 && priorRaw.length % 500 === 0;
    const changePercent = priorRaw.length > 0 && !resultsCapped
      ? Math.round(((annualizedCurrent - priorRaw.length) / priorRaw.length) * 100)
      : null;

    const result = {
      available: true,
      dataType: 'incident',
      cityId: city.id,
      cityName: city.name,
      lat: latF,
      lon: lonF,
      radiusMiles,
      hasSpatialQuery: city.hasSpatialQuery,
      currentYear,
      priorYear,
      totalCurrent: currentRaw.length,
      totalPrior: priorRaw.length,
      annualizedCurrent,
      changePercent,
      resultsCapped,
      categories: current.cats,
      topOffenses,
      recentIncidents,
      source: `${city.source} (${city.type === 'socrata' ? 'Socrata' : 'ArcGIS'})`,
    };

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** List supported cities for the crime nearby feature. */
app.get('/api/crime/cities', (_req, res) => {
  res.json(CITY_CRIME_REGISTRY.map(c => ({
    id: c.id, name: c.name, state: c.state,
    bbox: c.bbox, hasSpatialQuery: c.hasSpatialQuery,
  })));
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

  const vars = 'B19013_001E,B25077_001E,B01003_001E,B25002_003E,B25002_001E,B25064_001E';
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
    medianRent: parseInt(row[5]) || null,
    state: row[6],
    county: row[7],
    tract: row[8],
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
        case 'rental-yield':
          if (tractData.medianRent && tractData.medianHomeValue && tractData.medianHomeValue > 0) {
            rawValue = (tractData.medianRent * 12) / tractData.medianHomeValue * 100;
          }
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
  sources.schools = SCHOOLDIGGER_APP_ID ? 'active (SchoolDigger)' : GREATSCHOOLS_KEY ? 'active (GreatSchools)' : 'active (Census education fallback)';
  sources.crime = 'active (embedded BJS/FBI NIBRS 2022-2023 data)';
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
  let reportCount = 0;
  try { reportCount = db.prepare('SELECT COUNT(*) as c FROM reports').get().c; } catch (e) {}
  let clientCount = 0;
  try { clientCount = db.prepare('SELECT COUNT(*) as c FROM clients').get().c; } catch (e) {}
  let aiCacheCount = 0;
  try { aiCacheCount = db.prepare('SELECT COUNT(*) as c FROM ai_cache').get().c; } catch (e) {}

  res.json({
    status: 'ok',
    sources,
    cache: { entries: cache.size },
    database: { zhviZips: zhviCount, listingSnapshots: snapshotCount, marketContextZips: marketCacheCount, savedProperties: savedCount, portfolios: portfolioCount, savedSearches: searchCount, unreadAlerts: alertCount, reports: reportCount, clients: clientCount, aiCache: aiCacheCount },
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

  // 4. Follow-up intelligence — portfolios shared but not viewed after 7 days
  try {
    const stalePortfolios = db.prepare(`
      SELECT p.id, p.client_id, c.name as client_name
      FROM portfolios p
      JOIN clients c ON c.id = p.client_id
      WHERE p.last_viewed_at IS NULL
      AND p.created_at < datetime('now', '-7 days')
    `).all();
    for (const sp of stalePortfolios) {
      const existing = db.prepare("SELECT id FROM alerts WHERE type = 'follow_up' AND property_address = ? AND created_at > datetime('now', '-7 days')").get(`portfolio-${sp.id}`);
      if (!existing) {
        insertAlert.run('follow_up', null, `portfolio-${sp.id}`, JSON.stringify({
          clientName: sp.client_name, portfolioId: sp.id,
          message: `Portfolio shared with ${sp.client_name} 7+ days ago — not viewed`,
        }));
      }
    }
  } catch { /* skip */ }

  console.log('[AlertScanner] Scan complete');
}

// ===========================================================================
// CLIENTS — lightweight CRM
// ===========================================================================
app.get('/api/clients', (req, res) => {
  try {
    const clients = db.prepare('SELECT * FROM clients ORDER BY updated_at DESC').all();
    res.json(clients);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients', (req, res) => {
  try {
    const { name, email, phone, clientType, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const r = db.prepare('INSERT INTO clients (name, email, phone, client_type, notes) VALUES (?, ?, ?, ?, ?)')
      .run(name, email || '', phone || '', clientType || 'buyer', notes || '');
    res.json({ id: r.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/clients/:id', (req, res) => {
  try {
    const { name, email, phone, clientType, notes } = req.body;
    const existing = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Client not found' });
    db.prepare("UPDATE clients SET name = ?, email = ?, phone = ?, client_type = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name || '', email || '', phone || '', clientType || 'buyer', notes || '', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clients/:id/activity', (req, res) => {
  try {
    const activities = db.prepare('SELECT * FROM client_activity WHERE client_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id);
    activities.forEach(a => { try { a.data = JSON.parse(a.data_json || '{}'); } catch { a.data = {}; } });
    res.json(activities);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Portfolio tracking pixel — 1x1 transparent GIF
const TRACKING_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

app.get('/api/portfolios/:id/track', (req, res) => {
  try {
    const portfolio = db.prepare('SELECT id, client_id FROM portfolios WHERE id = ?').get(req.params.id);
    if (portfolio) {
      db.prepare("UPDATE portfolios SET view_count = COALESCE(view_count, 0) + 1, last_viewed_at = datetime('now') WHERE id = ?").run(req.params.id);
      if (portfolio.client_id) {
        db.prepare('INSERT INTO client_activity (client_id, event_type, portfolio_id, data_json) VALUES (?, ?, ?, ?)')
          .run(portfolio.client_id, 'portfolio_view', req.params.id, JSON.stringify({ ip: req.ip, ua: req.headers['user-agent'] }));
      }
    }
  } catch { /* tracking should never error */ }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store', 'Content-Length': TRACKING_GIF.length });
  res.end(TRACKING_GIF);
});

// Link portfolio to client
app.post('/api/portfolios/:id/link-client', (req, res) => {
  try {
    const { clientId } = req.body;
    db.prepare('UPDATE portfolios SET client_id = ? WHERE id = ?').run(clientId || null, req.params.id);
    if (clientId) {
      db.prepare('INSERT INTO client_activity (client_id, event_type, portfolio_id, data_json) VALUES (?, ?, ?, ?)')
        .run(clientId, 'portfolio_shared', req.params.id, JSON.stringify({ sharedAt: new Date().toISOString() }));
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================================================================
// RENTAL COMPS — nearby rental comparables via RentCast
// ===========================================================================
app.get('/api/rental-comps', async (req, res) => {
  try {
    const { address, lat, lon, zipCode, bedrooms } = req.query;
    if (!address && !zipCode) return res.status(400).json({ error: 'Provide address or zipCode' });

    const cacheKey = `rental-comps:${address || zipCode}:${bedrooms || 'any'}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    if (RENTCAST_KEY) {
      const params = new URLSearchParams();
      if (address) params.set('address', address);
      else if (zipCode) params.set('zipCode', zipCode);
      if (bedrooms) params.set('bedrooms', bedrooms);
      params.set('limit', '10');

      const r = await fetch(`${RENTCAST_BASE}/rentals?${params}`, {
        headers: { 'X-Api-Key': RENTCAST_KEY, Accept: 'application/json' },
      });
      if (r.ok) {
        const data = await r.json();
        const result = {
          rentals: (data || []).map(c => ({
            address: c.formattedAddress || c.addressLine1 || '',
            rent: c.price || c.lastSeenPrice || null,
            bedrooms: c.bedrooms, bathrooms: c.bathrooms,
            sqft: c.squareFootage, distance: c.distance,
            propertyType: c.propertyType,
          })),
          source: 'rentcast',
        };
        cacheSet(cacheKey, result);
        return res.json(result);
      }
    }

    // Demo fallback
    const demoRentals = Array.from({ length: 5 }, (_, i) => ({
      address: `${100 + i * 100} Rental Ave, ${zipCode || 'Unknown'}`,
      rent: 1200 + Math.floor(Math.random() * 800),
      bedrooms: (bedrooms ? parseInt(bedrooms) : 3),
      bathrooms: 2,
      sqft: 900 + Math.floor(Math.random() * 600),
      distance: +(0.3 + i * 0.4).toFixed(1),
      propertyType: 'Apartment',
    }));
    res.json({ rentals: demoRentals, source: 'demo' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// INVESTMENT SCENARIOS — 3-scenario (conservative/moderate/aggressive)
// ===========================================================================
app.post('/api/investment/scenarios', (req, res) => {
  try {
    const { purchasePrice, monthlyRent, downPaymentPct, interestRate, loanTermYears } = req.body;
    if (!purchasePrice || !monthlyRent) return res.status(400).json({ error: 'purchasePrice and monthlyRent required' });

    const price = Number(purchasePrice);
    const rent = Number(monthlyRent);
    const dpPct = Number(downPaymentPct || 20) / 100;
    const rate = Number(interestRate || 6.5) / 100 / 12;
    const term = Number(loanTermYears || 30) * 12;
    const downPayment = price * dpPct;
    const loanAmt = price - downPayment;
    const monthlyMortgage = rate > 0 ? loanAmt * rate * Math.pow(1 + rate, term) / (Math.pow(1 + rate, term) - 1) : loanAmt / term;

    const scenarios = [
      { name: 'Conservative', vacancy: 0.12, expenses: 0.45, appreciation: 0.02, rentGrowth: 0.015 },
      { name: 'Moderate', vacancy: 0.08, expenses: 0.38, appreciation: 0.035, rentGrowth: 0.025 },
      { name: 'Aggressive', vacancy: 0.05, expenses: 0.30, appreciation: 0.05, rentGrowth: 0.04 },
    ];

    const results = scenarios.map(s => {
      const projections = [];
      let currentRent = rent;
      let currentValue = price;
      let totalEquity = downPayment;
      let principalPaid = 0;
      let balance = loanAmt;

      for (let year = 1; year <= 5; year++) {
        currentRent *= (1 + s.rentGrowth);
        currentValue *= (1 + s.appreciation);
        const annualRent = currentRent * 12 * (1 - s.vacancy);
        const annualExpenses = annualRent * s.expenses;
        const annualMortgage = monthlyMortgage * 12;

        // Principal paid this year (approximate)
        const yearlyInterest = balance * (Number(interestRate || 6.5) / 100);
        const yearlyPrincipal = annualMortgage - yearlyInterest;
        balance -= yearlyPrincipal;
        principalPaid += yearlyPrincipal;

        const cashFlow = annualRent - annualExpenses - annualMortgage;
        totalEquity = (currentValue - balance);

        projections.push({
          year,
          monthlyRent: Math.round(currentRent),
          annualCashFlow: Math.round(cashFlow),
          propertyValue: Math.round(currentValue),
          equity: Math.round(totalEquity),
          totalReturn: Math.round(totalEquity - downPayment + cashFlow * year),
        });
      }

      // Break-even rent
      const annualExpenseRate = s.expenses;
      const annualMortgage = monthlyMortgage * 12;
      const breakEvenRent = Math.ceil(annualMortgage / (12 * (1 - s.vacancy) * (1 - annualExpenseRate)));

      return {
        scenario: s.name,
        assumptions: { vacancy: s.vacancy, expenses: s.expenses, appreciation: s.appreciation, rentGrowth: s.rentGrowth },
        projections,
        breakEvenRent,
        year1CashFlow: projections[0]?.annualCashFlow || 0,
        year5TotalReturn: projections[4]?.totalReturn || 0,
      };
    });

    res.json({
      purchasePrice: price, monthlyRent: rent, downPayment, monthlyMortgage: Math.round(monthlyMortgage),
      scenarios: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// AGENT PROFILE — branding for reports
// ===========================================================================
app.get('/api/agent/profile', (req, res) => {
  try {
    const profile = db.prepare('SELECT * FROM agent_profiles WHERE id = 1').get();
    res.json(profile || { id: 1, name: '', email: '', phone: '', logo_url: '', brand_color: '#5b8df9', tagline: '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/profile', (req, res) => {
  try {
    const { name, email, phone, logoUrl, brandColor, tagline } = req.body;
    const existing = db.prepare('SELECT id FROM agent_profiles WHERE id = 1').get();
    if (existing) {
      db.prepare(`UPDATE agent_profiles SET name = ?, email = ?, phone = ?, logo_url = ?, brand_color = ?, tagline = ?, updated_at = datetime('now') WHERE id = 1`)
        .run(name || '', email || '', phone || '', logoUrl || '', brandColor || '#5b8df9', tagline || '');
    } else {
      db.prepare(`INSERT INTO agent_profiles (id, name, email, phone, logo_url, brand_color, tagline) VALUES (1, ?, ?, ?, ?, ?, ?)`)
        .run(name || '', email || '', phone || '', logoUrl || '', brandColor || '#5b8df9', tagline || '');
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// AI NARRATIVE — uses shared callAI() with template fallback
// ===========================================================================
async function generateNarrative(propertyData, marketData, momentumData) {
  const prompt = `You are a real estate analyst writing a brief property report summary. Be concise (3-4 sentences).

Property: ${propertyData.address || 'Unknown'}
Type: ${propertyData.propertyType || 'Residential'}, ${propertyData.bedrooms || '?'}bd/${propertyData.bathrooms || '?'}ba, ${propertyData.squareFootage || '?'} sqft
Estimated Value: $${propertyData.estimatedValue ? Number(propertyData.estimatedValue).toLocaleString() : 'N/A'}
${propertyData.rentEstimate ? `Rent Estimate: $${Number(propertyData.rentEstimate).toLocaleString()}/mo` : ''}
${momentumData ? `Momentum Score: ${momentumData.score}/100 (${momentumData.trend || 'stable'})` : ''}
${marketData ? `Market Context: Median home value $${marketData.medianValue ? Number(marketData.medianValue).toLocaleString() : 'N/A'}, ${marketData.daysOnMarket || '?'} avg days on market` : ''}

Write a professional summary highlighting investment potential, market position, and key factors.`;

  const result = await callAI(prompt, { maxOutputTokens: 500, feature: 'narrative' });
  if (result) return result;
  return { source: 'template', text: templateNarrative(propertyData, marketData, momentumData) };
}

function templateNarrative(prop, market, momentum) {
  const parts = [];
  if (prop.address) parts.push(`This property at ${prop.address} is a ${prop.propertyType || 'residential'} home with ${prop.bedrooms || '?'} bedrooms and ${prop.bathrooms || '?'} bathrooms.`);
  if (prop.estimatedValue) {
    const val = Number(prop.estimatedValue).toLocaleString();
    parts.push(`The estimated market value is $${val}${prop.rentEstimate ? `, with a potential rental income of $${Number(prop.rentEstimate).toLocaleString()}/month` : ''}.`);
  }
  if (momentum && momentum.score != null) {
    const trend = momentum.score >= 65 ? 'strong upward momentum' : momentum.score >= 45 ? 'stable market conditions' : 'softening market conditions';
    parts.push(`The area shows ${trend} with a momentum score of ${momentum.score}/100.`);
  }
  if (market && market.medianValue) {
    parts.push(`The local market has a median home value of $${Number(market.medianValue).toLocaleString()}.`);
  }
  return parts.join(' ') || 'No data available for narrative generation.';
}

app.post('/api/ai/narrative', async (req, res) => {
  try {
    const { propertyData, marketData, momentumData } = req.body;
    if (!propertyData) return res.status(400).json({ error: 'propertyData required' });
    const narrative = await generateNarrative(propertyData, marketData, momentumData);
    res.json(narrative);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// REPORTS — generate report data bundles
// ===========================================================================
app.post('/api/reports/property/:savedId', async (req, res) => {
  try {
    const saved = db.prepare('SELECT * FROM saved_properties WHERE id = ?').get(req.params.savedId);
    if (!saved) return res.status(404).json({ error: 'Saved property not found' });

    // Gather all available data
    const address = saved.address;
    const zip = saved.zip || '';
    let propertyDetails = null;
    let valuation = null;
    let momentumData = null;
    let marketContext = null;

    // Try to look up fresh property data
    try { propertyDetails = await lookupProperty(address); } catch { /* use saved data */ }
    try {
      if (zip) {
        const snap = db.prepare('SELECT * FROM momentum_snapshots WHERE zip = ? ORDER BY created_at DESC LIMIT 1').get(zip);
        if (snap) momentumData = { score: snap.score, trend: snap.trend, factors: JSON.parse(snap.factors_json || '{}') };
      }
    } catch { /* skip */ }
    try {
      if (zip) {
        const mc = db.prepare('SELECT * FROM market_context_cache WHERE zip = ?').get(zip);
        if (mc) marketContext = JSON.parse(mc.data_json || '{}');
      }
    } catch { /* skip */ }

    // Combine saved info with fresh data
    const propertyData = {
      address,
      propertyType: saved.property_type || propertyDetails?.propertyType || '',
      bedrooms: propertyDetails?.bedrooms || saved.bedrooms || '',
      bathrooms: propertyDetails?.bathrooms || saved.bathrooms || '',
      squareFootage: propertyDetails?.squareFootage || saved.sqft || '',
      yearBuilt: propertyDetails?.yearBuilt || '',
      estimatedValue: saved.current_price || saved.saved_price || '',
      savedPrice: saved.saved_price || '',
      currentPrice: saved.current_price || '',
      rentEstimate: valuation?.rentEstimate || '',
      lotSize: propertyDetails?.lotSize || '',
      lastSaleDate: propertyDetails?.lastSaleDate || '',
      lastSalePrice: propertyDetails?.lastSalePrice || '',
    };

    // Generate AI narrative
    const narrative = await generateNarrative(propertyData, marketContext, momentumData);

    // Get agent profile
    const agentProfile = db.prepare('SELECT * FROM agent_profiles WHERE id = 1').get() || {};

    // Save report
    const reportId = crypto.randomUUID();
    const reportData = { propertyData, momentumData, marketContext, narrative, agentProfile, generatedAt: new Date().toISOString() };
    db.prepare('INSERT INTO reports (id, type, data_json) VALUES (?, ?, ?)').run(reportId, 'property', JSON.stringify(reportData));

    res.json({ reportId, ...reportData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reports/compare', async (req, res) => {
  try {
    const { zipCodes } = req.body;
    if (!zipCodes || !Array.isArray(zipCodes) || zipCodes.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 zip codes' });
    }
    if (zipCodes.length > 5) return res.status(400).json({ error: 'Maximum 5 zip codes' });

    const comparisons = [];
    for (const zip of zipCodes) {
      const snap = db.prepare('SELECT * FROM momentum_snapshots WHERE zip = ? ORDER BY created_at DESC LIMIT 1').get(zip);
      const zhvi = db.prepare('SELECT * FROM zhvi_data WHERE zip = ?').get(zip);
      const mc = db.prepare('SELECT * FROM market_context_cache WHERE zip = ?').get(zip);

      comparisons.push({
        zip,
        momentum: snap ? { score: snap.score, trend: snap.trend, factors: JSON.parse(snap.factors_json || '{}') } : null,
        zhvi: zhvi ? { currentValue: zhvi.current_value, yoyChange: zhvi.yoy_change, fiveYearChange: zhvi.five_year_change } : null,
        market: mc ? JSON.parse(mc.data_json || '{}') : null,
      });
    }

    const agentProfile = db.prepare('SELECT * FROM agent_profiles WHERE id = 1').get() || {};
    const reportId = crypto.randomUUID();
    const reportData = { zipCodes, comparisons, agentProfile, generatedAt: new Date().toISOString() };
    db.prepare('INSERT INTO reports (id, type, data_json) VALUES (?, ?, ?)').run(reportId, 'compare', JSON.stringify(reportData));

    res.json({ reportId, ...reportData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/:id', (req, res) => {
  try {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ id: report.id, type: report.type, data: JSON.parse(report.data_json || '{}'), created_at: report.created_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// AI ANALYTICS — Verdict, Market Brief, NL Search, Portfolio Advisor
// ===========================================================================

// --- Natural Language Search ---
function regexParseSearch(query) {
  const q = query.toLowerCase();
  const filters = { city: null, state: null, zipCode: null, minPrice: null, maxPrice: null, beds: null, baths: null, propertyType: null };

  const zipMatch = q.match(/\b(\d{5})\b/);
  if (zipMatch) filters.zipCode = zipMatch[1];

  const bedMatch = q.match(/(\d)\s*(?:bed|br|bedroom)/);
  if (bedMatch) filters.beds = bedMatch[1];

  const bathMatch = q.match(/(\d)\s*(?:bath|ba)\b/);
  if (bathMatch) filters.baths = bathMatch[1];

  const underMatch = q.match(/(?:under|below|max|less than|up to)\s*\$?(\d+)\s*(k|K)?/);
  if (underMatch) filters.maxPrice = parseFloat(underMatch[1]) * (underMatch[2] ? 1000 : 1);

  const overMatch = q.match(/(?:over|above|min|at least|more than)\s*\$?(\d+)\s*(k|K)?/);
  if (overMatch) filters.minPrice = parseFloat(overMatch[1]) * (overMatch[2] ? 1000 : 1);

  const rangeMatch = q.match(/\$?(\d+)\s*(k|K)?\s*[-–to]+\s*\$?(\d+)\s*(k|K)?/);
  if (rangeMatch) {
    filters.minPrice = parseFloat(rangeMatch[1]) * (rangeMatch[2] ? 1000 : 1);
    filters.maxPrice = parseFloat(rangeMatch[3]) * (rangeMatch[4] ? 1000 : 1);
  }

  if (q.includes('condo')) filters.propertyType = 'Condo';
  else if (q.includes('townhouse') || q.includes('town house')) filters.propertyType = 'Townhouse';
  else if (q.includes('multi') || q.includes('duplex')) filters.propertyType = 'Multi-Family';

  // City: "in Austin TX" or "in San Francisco"
  const inMatch = q.match(/\bin\s+([a-z][a-z\s]+?)(?:\s+(?:near|under|below|above|over|with|for|around|[a-z]{2}\b|\d|$))/);
  if (inMatch) filters.city = inMatch[1].trim().replace(/\b\w/g, c => c.toUpperCase());

  // State: 2-letter code (skip "in"/"or"/"me" if they appear as preposition/conjunction before city)
  const stateAbbrs = 'al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|ia|ks|ky|la|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy';
  const stateMatch = q.match(new RegExp(`(?:^|\\s)(${stateAbbrs})(?:\\s|$|\\b(?!\\w))`));
  if (stateMatch) filters.state = stateMatch[1].toUpperCase();
  // Also check: "in" followed by a city means it's a preposition, check for "me"/"or" similarly
  if (!filters.state) {
    const ambigStates = q.match(/\b(in|or|me)\b/g);
    if (ambigStates && !filters.city) {
      const last = ambigStates[ambigStates.length - 1];
      filters.state = last.toUpperCase();
    }
  }

  return filters;
}

function buildSearchInterpretation(f) {
  const parts = [];
  if (f.beds) parts.push(`${f.beds}+ bed`);
  if (f.baths) parts.push(`${f.baths}+ bath`);
  if (f.propertyType) parts.push(f.propertyType);
  parts.push('homes');
  if (f.minPrice && f.maxPrice) parts.push(`$${(f.minPrice/1000).toFixed(0)}K-$${(f.maxPrice/1000).toFixed(0)}K`);
  else if (f.maxPrice) parts.push(`under $${(f.maxPrice/1000).toFixed(0)}K`);
  else if (f.minPrice) parts.push(`over $${(f.minPrice/1000).toFixed(0)}K`);
  if (f.city) parts.push(`in ${f.city}`);
  if (f.state) parts.push(f.state);
  if (f.zipCode) parts.push(`(${f.zipCode})`);
  return parts.join(' ');
}

app.post('/api/ai/parse-search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || query.trim().length < 3) return res.status(400).json({ error: 'query too short' });

    const normalized = query.toLowerCase().trim();
    const cacheKey = `nl_search:${crypto.createHash('md5').update(normalized).digest('hex')}`;

    const prompt = `Parse this real estate search query into structured filters. Return ONLY valid JSON, no other text.

Query: "${query}"

Return: {"city":STRING_OR_NULL,"state":STRING_OR_NULL_TWO_LETTER,"zipCode":STRING_OR_NULL_5_DIGIT,"minPrice":NUMBER_OR_NULL,"maxPrice":NUMBER_OR_NULL,"beds":STRING_OR_NULL,"baths":STRING_OR_NULL,"propertyType":STRING_OR_NULL}

Rules:
- "under 400k" = maxPrice:400000. "400-500k" = minPrice:400000,maxPrice:500000
- State: always 2-letter abbreviation. Infer from city if possible.
- beds/baths: just the number as string ("3", "2")
- propertyType: one of "Single Family", "Condo", "Townhouse", "Multi-Family" or null
- "near schools" or "good schools" = ignore (not a filter)
- "cheap" = maxPrice:300000, "luxury" = minPrice:750000`;

    const aiResult = await callAI(prompt, { cacheKey, cacheTTL: '1 day', feature: 'nl_search', maxOutputTokens: 1024, jsonMode: true });

    if (aiResult) {
      try {
        const filters = JSON.parse(aiResult.text);
        return res.json({ filters, interpreted: buildSearchInterpretation(filters), source: aiResult.source, cached: !!aiResult.cached });
      } catch { /* AI returned bad JSON, fall through to regex */ }
    }

    const filters = regexParseSearch(query);
    res.json({ filters, interpreted: buildSearchInterpretation(filters), source: 'regex', cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AI Property Verdict ---
function buildVerdictTemplate(saved, momentum, zhvi, investment) {
  const price = saved?.current_price || saved?.saved_price || 0;
  const capRate = investment?.capRate || 0;
  const momScore = momentum?.score ?? 50;

  let recommendation = 'HOLD';
  if (capRate > 5 && momScore > 55) recommendation = 'BUY';
  else if (capRate < 3 || momScore < 30) recommendation = 'PASS';

  const confidence = (momentum && zhvi && investment) ? 'MEDIUM' : 'LOW';
  const low = Math.round(price * 0.93);
  const high = Math.round(price * 1.02);

  const risks = [];
  if (capRate < 4) risks.push('Cap rate below 4% indicates tight cash flow margins');
  if (momScore < 45) risks.push(`Neighborhood momentum is weak (${momScore}/100)`);
  if (zhvi?.yoy_change < 0) risks.push(`Home values declining ${zhvi.yoy_change.toFixed(1)}% year-over-year`);
  if (risks.length === 0) risks.push('Market conditions may shift with interest rate changes');
  while (risks.length < 3) risks.push('Conduct thorough property inspection before committing');

  const opps = [];
  if (capRate > 5) opps.push(`Strong ${capRate.toFixed(1)}% cap rate for positive cash flow`);
  if (momScore > 60) opps.push(`Rising neighborhood momentum (${momScore}/100) signals appreciation`);
  if (zhvi?.yoy_change > 3) opps.push(`Strong ${zhvi.yoy_change.toFixed(1)}% YoY appreciation trend`);
  if (opps.length === 0) opps.push('Stable market conditions for long-term hold strategy');
  while (opps.length < 3) opps.push('Potential for rent increases in growing market');

  return {
    recommendation, confidence,
    offerRange: { low, high },
    risks: risks.slice(0, 3),
    opportunities: opps.slice(0, 3),
    strategy: {
      day30: recommendation === 'BUY' ? `Submit offer at $${low.toLocaleString()} with standard contingencies` : 'Continue monitoring the property and gathering market data',
      day60: recommendation === 'BUY' ? `Negotiate within $${low.toLocaleString()}-$${high.toLocaleString()} range, request seller concessions if above midpoint` : 'Compare with alternative properties in the area for better value',
      day90: recommendation === 'BUY' ? 'Finalize financing and schedule inspections, plan renovation if applicable' : 'Re-evaluate based on updated market conditions and momentum changes',
    },
  };
}

app.post('/api/ai/verdict', async (req, res) => {
  try {
    const { address, savedPropertyId } = req.body;
    if (!address) return res.status(400).json({ error: 'address required' });

    const cacheKey = `verdict:${address.toLowerCase().trim()}`;

    // Gather saved property data
    let saved = null;
    if (savedPropertyId) {
      saved = db.prepare('SELECT * FROM saved_properties WHERE id = ?').get(savedPropertyId);
    }
    if (!saved) {
      saved = db.prepare('SELECT * FROM saved_properties WHERE address = ?').get(address);
    }

    const zip = saved?.zip || '';
    const price = saved?.current_price || saved?.saved_price || 0;
    const rent = saved?.rent_estimate || 0;

    // Fetch momentum, ZHVI, market context
    let momentum = null, zhvi = null, market = null;
    if (zip) {
      try { momentum = db.prepare('SELECT score, trend, factors FROM momentum_snapshots WHERE zip = ? ORDER BY created_at DESC LIMIT 1').get(zip); } catch {}
      zhvi = getZHVIData(zip);
      market = getMarketContext(zip);
    }

    // Calculate investment metrics
    const noi = rent * 12 * 0.6;
    const capRate = price > 0 ? (noi / price * 100) : 0;
    const monthlyMortgage = price > 0 ? (price * 0.8) * (0.07 / 12) / (1 - Math.pow(1 + 0.07 / 12, -360)) : 0;
    const monthlyCashFlow = rent - monthlyMortgage - (rent * 0.4);
    const dscr = monthlyMortgage > 0 ? (noi / (monthlyMortgage * 12)) : 0;
    const investment = { capRate: +capRate.toFixed(1), monthlyCashFlow: Math.round(monthlyCashFlow), dscr: +dscr.toFixed(2) };

    // Build AI prompt
    const prompt = `You are a real estate investment analyst. Analyze this property and return ONLY valid JSON.

Property: ${address}
Price: $${price || 'unknown'}
Rent Estimate: $${rent || 'unknown'}/mo
${momentum ? `Momentum Score: ${momentum.score}/100, trend: ${momentum.trend}` : 'No momentum data'}
${zhvi ? `ZHVI: $${Math.round(zhvi.current_value / 1000)}K, YoY: ${zhvi.yoy_change?.toFixed(1)}%` : 'No ZHVI data'}
${investment.capRate ? `Cap Rate: ${investment.capRate}%, DSCR: ${investment.dscr}, Cash Flow: $${investment.monthlyCashFlow}/mo` : ''}
${market ? `Market: Median $${market.medianPrice}, DOM: ${market.medianDom}d, Inventory: ${market.totalInventory}` : ''}

Return this exact JSON:
{"recommendation":"BUY or HOLD or PASS","confidence":"HIGH or MEDIUM or LOW","offerRange":{"low":NUMBER,"high":NUMBER},"risks":["risk1","risk2","risk3"],"opportunities":["opp1","opp2","opp3"],"strategy":{"day30":"action","day60":"action","day90":"action"}}`;

    const aiResult = await callAI(prompt, { cacheKey, cacheTTL: '7 days', feature: 'verdict', maxOutputTokens: 2048, jsonMode: true });

    if (aiResult) {
      try {
        const verdict = JSON.parse(aiResult.text);
        return res.json({ verdict, source: aiResult.source, cached: !!aiResult.cached });
      } catch { /* bad JSON, fall through */ }
    }

    const verdict = buildVerdictTemplate(saved, momentum, zhvi, investment);
    res.json({ verdict, source: 'template', cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AI Market Brief ---
function buildMarketBriefTemplate(momentum, zhvi, market) {
  const momScore = momentum?.score ?? 50;
  const yoy = zhvi?.yoy_change ?? 0;

  let outlook = 'STABLE';
  if (momScore > 60 && yoy > 3) outlook = 'HEATING';
  else if (momScore < 35 || yoy < -2) outlook = 'COOLING';

  const factors = momentum?.factors ? JSON.parse(momentum.factors) : [];
  const topDriver = factors[0]?.name || 'market conditions';

  return {
    outlook,
    thesis: outlook === 'HEATING'
      ? `Strong ${topDriver.toLowerCase()} driving appreciation. Market fundamentals support continued growth.`
      : outlook === 'COOLING'
        ? `Weakening ${topDriver.toLowerCase()} signals caution. Consider waiting for better entry points.`
        : `Balanced market conditions with steady ${topDriver.toLowerCase()}. Good for long-term holds.`,
    keyMetrics: {
      medianHomeValue: zhvi ? `$${Math.round(zhvi.current_value / 1000)}K` : 'N/A',
      yoyAppreciation: zhvi ? `${yoy > 0 ? '+' : ''}${yoy.toFixed(1)}%` : 'N/A',
      inventory: market?.totalInventory ? String(market.totalInventory) : 'N/A',
      avgDOM: market?.medianDom ? `${market.medianDom} days` : 'N/A',
      momentumScore: `${momScore}/100`,
    },
    bestPropertyType: momScore > 60 ? 'Single-family homes with rental potential for dual income strategy' : 'Value-add properties below median price for maximum upside',
    forecast: outlook === 'HEATING'
      ? 'Expect continued appreciation with increasing competition. Act quickly on underpriced listings.'
      : outlook === 'COOLING'
        ? 'Prices may soften 2-5% over 6 months. Negotiate aggressively and target motivated sellers.'
        : 'Steady conditions expected. Focus on cash-flow positive deals rather than speculative appreciation.',
  };
}

app.post('/api/ai/market-brief', async (req, res) => {
  try {
    const { zipCode } = req.body;
    if (!zipCode) return res.status(400).json({ error: 'zipCode required' });

    const cacheKey = `market_brief:${zipCode}`;

    // Gather data
    let momentum = null;
    try { momentum = db.prepare('SELECT score, trend, factors FROM momentum_snapshots WHERE zip = ? ORDER BY created_at DESC LIMIT 1').get(zipCode); } catch {}
    const zhvi = getZHVIData(zipCode);
    const market = getMarketContext(zipCode);

    const prompt = `You are a real estate market analyst. Provide a market brief for zip code ${zipCode}. Return ONLY valid JSON.

Data:
${zhvi ? `ZHVI: $${Math.round(zhvi.current_value / 1000)}K, YoY: ${zhvi.yoy_change?.toFixed(1)}%` : 'No ZHVI data'}
${momentum ? `Momentum Score: ${momentum.score}/100, Trend: ${momentum.trend}` : 'No momentum data'}
${momentum?.factors ? `Factors: ${momentum.factors}` : ''}
${market ? `Market: DOM ${market.medianDom}d, Inventory ${market.totalInventory}, Median $${market.medianPrice}` : 'No market data'}

Return this JSON:
{"outlook":"HEATING or COOLING or STABLE","thesis":"2-3 sentences on market direction","keyMetrics":{"medianHomeValue":"$NNK","yoyAppreciation":"+N.N%","inventory":"NNN","avgDOM":"NN days","momentumScore":"NN/100"},"bestPropertyType":"recommendation","forecast":"2-3 sentences on 6-month outlook"}`;

    const aiResult = await callAI(prompt, { cacheKey, cacheTTL: '3 days', feature: 'market_brief', maxOutputTokens: 2048, jsonMode: true });

    if (aiResult) {
      try {
        const brief = JSON.parse(aiResult.text);
        return res.json({ brief, source: aiResult.source, cached: !!aiResult.cached });
      } catch { /* bad JSON, fall through */ }
    }

    const brief = buildMarketBriefTemplate(momentum, zhvi, market);
    res.json({ brief, source: 'template', cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AI Portfolio Advisor ---
function buildPortfolioTemplate(properties) {
  const zips = [...new Set(properties.map(p => p.zip).filter(Boolean))];
  const avgCap = properties.reduce((s, p) => s + (p.capRate || 0), 0) / properties.length;
  const avgMom = properties.filter(p => p.momentum != null).reduce((s, p) => s + p.momentum, 0) / (properties.filter(p => p.momentum != null).length || 1);
  const negCashFlow = properties.filter(p => p.monthlyCashFlow < 0);

  const healthScore = Math.round(Math.min(100, (avgCap / 8 * 40) + (avgMom / 100 * 30) + (Math.min(zips.length, 3) / 3 * 30)));

  const diversification = zips.length >= 3
    ? `Good geographic spread across ${zips.length} zip codes.`
    : zips.length === 1
      ? `All properties concentrated in zip ${zips[0]}. Consider diversifying into adjacent areas.`
      : `Limited spread across ${zips.length} zip codes. Adding a third market would reduce risk.`;

  const riskExposure = negCashFlow.length > 0
    ? `${negCashFlow.length} of ${properties.length} properties have negative cash flow. Portfolio average cap rate: ${avgCap.toFixed(1)}%.`
    : `All properties cash-flow positive. Portfolio average cap rate: ${avgCap.toFixed(1)}%.`;

  const recommendations = properties.map(p => {
    let action = 'HOLD';
    let reason = 'Stable asset — continue monitoring.';
    if ((p.capRate || 0) > 5 && (p.momentum || 50) > 50) {
      action = 'HOLD';
      reason = `Strong ${p.capRate?.toFixed(1)}% cap rate with positive momentum (${p.momentum}/100).`;
    } else if ((p.capRate || 0) < 2 || (p.momentum || 50) < 30) {
      action = 'SELL';
      reason = `Weak fundamentals — ${p.capRate?.toFixed(1)}% cap rate, momentum ${p.momentum ?? 'unknown'}/100. Capital may be better deployed elsewhere.`;
    }
    return { address: p.address, action, reason };
  });

  return {
    healthScore,
    diversification,
    riskExposure,
    recommendations,
    buyNext: zips.length < 3
      ? 'Expand into a new zip code to improve geographic diversification and reduce single-market risk.'
      : 'Look for high-momentum areas with cap rates above 5% to strengthen overall portfolio returns.',
  };
}

app.post('/api/ai/portfolio-advisor', async (req, res) => {
  try {
    const { propertyIds } = req.body;

    let properties;
    if (propertyIds?.length) {
      const placeholders = propertyIds.map(() => '?').join(',');
      properties = db.prepare(`SELECT * FROM saved_properties WHERE id IN (${placeholders})`).all(...propertyIds);
    } else {
      properties = db.prepare('SELECT * FROM saved_properties ORDER BY created_at').all();
    }

    if (properties.length < 2) return res.status(400).json({ error: 'Need at least 2 saved properties for portfolio analysis' });

    // Enrich each property
    const enriched = properties.map(p => {
      const zip = p.zip || '';
      let momentum = null;
      try { momentum = db.prepare('SELECT score FROM momentum_snapshots WHERE zip = ? ORDER BY created_at DESC LIMIT 1').get(zip); } catch {}

      const price = p.current_price || p.saved_price || 0;
      const rent = p.rent_estimate || 0;
      const noi = rent * 12 * 0.6;
      const capRate = price > 0 ? +(noi / price * 100).toFixed(1) : 0;
      const monthlyMortgage = price > 0 ? (price * 0.8) * (0.07 / 12) / (1 - Math.pow(1 + 0.07 / 12, -360)) : 0;
      const monthlyCashFlow = Math.round(rent - monthlyMortgage - (rent * 0.4));
      const zhvi = zip ? getZHVIData(zip) : null;

      return {
        address: p.address, zip, price, rent, capRate,
        monthlyCashFlow, momentum: momentum?.score ?? null,
        yoy: zhvi?.yoy_change ?? null,
      };
    });

    const addrKey = enriched.map(p => p.address).sort().join('|');
    const cacheKey = `portfolio_advisor:${crypto.createHash('md5').update(addrKey).digest('hex')}`;

    const propLines = enriched.map((p, i) =>
      `${i + 1}. ${p.address} | ZIP: ${p.zip} | Price: $${p.price} | Rent: $${p.rent}/mo | Cap: ${p.capRate}% | Cash Flow: $${p.monthlyCashFlow}/mo | Momentum: ${p.momentum ?? 'N/A'}/100 | YoY: ${p.yoy != null ? p.yoy.toFixed(1) + '%' : 'N/A'}`
    ).join('\n');

    const prompt = `You are a real estate portfolio analyst. Analyze this investment portfolio and return ONLY valid JSON.

Portfolio (${enriched.length} properties):
${propLines}

Return this JSON:
{"healthScore":NUMBER_0_100,"diversification":"text about geographic and type diversity","riskExposure":"text about key risk factors","recommendations":[{"address":"exact address from above","action":"HOLD or SELL or BUY_MORE","reason":"1-2 sentences"}],"buyNext":"what to acquire next to strengthen the portfolio"}`;

    const aiResult = await callAI(prompt, { cacheKey, cacheTTL: '3 days', feature: 'portfolio_advisor', maxOutputTokens: 2048, jsonMode: true });

    if (aiResult) {
      try {
        const analysis = JSON.parse(aiResult.text);
        return res.json({ analysis, source: aiResult.source, cached: !!aiResult.cached });
      } catch { /* bad JSON, fall through */ }
    }

    const analysis = buildPortfolioTemplate(enriched);
    res.json({ analysis, source: 'template', cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\nPropScout running at http://localhost:${PORT}\n`);
  console.log('Data sources:');
  if (RAPIDAPI_KEY) {
    console.log('  Zillow (RapidAPI): ACTIVE');
    console.log('  Realty-in-US (RapidAPI): ACTIVE');
  } else {
    console.log('  Zillow (RapidAPI): not configured — add RAPIDAPI_KEY to .env');
    console.log('  Realty-in-US (RapidAPI): not configured — add RAPIDAPI_KEY to .env');
  }
  if (RENTCAST_KEY) console.log('  RentCast: ACTIVE');
  else console.log('  RentCast: not configured — add RENTCAST_API_KEY to .env');
  console.log('  Census ACS (free): multi-year Y-o-Y comparison');
  console.log('  FBI/BJS Crime Data: ACTIVE (embedded NIBRS 2022-2023, 47 states)');
  if (WALKSCORE_KEY) console.log('  Walk Score: ACTIVE');
  if (SCHOOLDIGGER_APP_ID) console.log('  Schools: SchoolDigger ACTIVE (free tier: 20/day)');
  else if (GREATSCHOOLS_KEY) console.log('  Schools: GreatSchools ACTIVE');
  else console.log('  Schools: Census education fallback (free)');
  if (ANTHROPIC_API_KEY) console.log('  AI Narrative (Claude): ACTIVE');
  else if (OPENAI_API_KEY) console.log('  AI Narrative (OpenAI): ACTIVE');
  else if (GEMINI_API_KEY) console.log('  AI Narrative (Gemini Free): ACTIVE');
  else if (GROQ_API_KEY) console.log('  AI Narrative (Groq Free): ACTIVE');
  else console.log('  AI Narrative: template fallback (add GROQ_API_KEY for free AI)');
  console.log(`  SQLite: ${path.join(DATA_DIR, 'propscout.db')}`);
  console.log('  Cache: 24-hour TTL\n');

  // Download Zillow ZHVI data in background (non-blocking)
  downloadAndParseZHVI();

  // Background alert scanner — every 6 hours
  setInterval(() => { runAlertScanner().catch(err => console.error('[AlertScanner] Error:', err)); }, 6 * 60 * 60 * 1000);
  // Initial scan after 5 minutes (let ZHVI + cache warm up first)
  setTimeout(() => { runAlertScanner().catch(err => console.error('[AlertScanner] Error:', err)); }, 5 * 60 * 1000);
});
