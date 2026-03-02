require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RENTCAST_KEY = process.env.RENTCAST_API_KEY;
const RENTCAST_BASE = 'https://api.rentcast.io/v1';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
app.get('/api/property-lookup', async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'Missing address' });

    const cacheKey = `lookup:${address.toLowerCase().trim()}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    let result = null;

    // Source 1: RapidAPI Zillow — property search + Zestimate
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

    if (!result) {
      return res.status(404).json({ error: 'Could not find property data from any source' });
    }

    cacheSet(cacheKey, result);
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
// LISTINGS LOOKUP — RapidAPI Zillow → Realtor → RentCast → 404
// ===========================================================================
app.get('/api/listings-lookup', async (req, res) => {
  try {
    const { location, city, state, zipCode, minPrice, maxPrice, beds, baths, limit } = req.query;
    const loc = location || (city && state ? `${city}, ${state}` : zipCode);
    if (!loc) return res.status(400).json({ error: 'Missing location/city/zipCode' });

    const cacheKey = `listings:${loc}:${JSON.stringify({ minPrice, maxPrice, beds, baths })}`.toLowerCase();
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    let result = null;

    // Source 1: RapidAPI Zillow — property search
    if (!result && RAPIDAPI_KEY) {
      try {
        const data = await zillowApiFetch('/propertyExtendedSearch', {
          location: loc,
          status_type: 'ForSale',
          home_type: 'Houses',
        });
        const props = data?.props || data?.results || [];
        if (Array.isArray(props) && props.length > 0) {
          result = {
            source: 'zillow',
            listings: props.slice(0, 25).map(p => ({
              address: p.streetAddress || p.address || '--',
              city: p.city || null,
              state: p.state || null,
              zipCode: p.zipcode || null,
              price: p.price ?? p.unformattedPrice ?? 0,
              bedrooms: p.bedrooms ?? p.beds ?? null,
              bathrooms: p.bathrooms ?? p.baths ?? null,
              squareFootage: p.livingArea ?? p.area ?? null,
              propertyType: p.propertyType || p.homeType || null,
              yearBuilt: p.yearBuilt ?? null,
              daysOnMarket: p.daysOnZillow ?? null,
              latitude: p.latitude ?? null,
              longitude: p.longitude ?? null,
              status: p.listingStatus || 'Active',
              imgSrc: p.imgSrc ?? null,
              zestimate: p.zestimate ?? null,
            })),
          };
        }
      } catch (err) {
        console.log('Zillow listings API failed:', err.message);
      }
    }

    // Source 2: RapidAPI Realtor.com — for-sale listings
    if (!result && RAPIDAPI_KEY) {
      try {
        const params = { limit: limit || 25, offset: 0, sort: 'newest' };
        // Parse location into city/state or use zipCode
        if (zipCode) {
          params.postal_code = zipCode;
        } else if (city && state) {
          params.city = city;
          params.state_code = state;
        } else {
          // Try autocomplete to resolve location
          const autoData = await realtorApiFetch('/locations/auto-complete', { input: loc });
          const match = autoData?.autocomplete?.[0];
          if (match) {
            params.city = match.city;
            params.state_code = match.state_code;
          }
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
                address: addr.line || '--',
                city: addr.city || null,
                state: addr.state_code || null,
                zipCode: addr.postal_code || null,
                price: p.list_price ?? p.price ?? 0,
                bedrooms: p.beds ?? p.description?.beds ?? null,
                bathrooms: p.baths ?? p.description?.baths ?? null,
                squareFootage: p.sqft ?? p.building_size?.size ?? null,
                propertyType: p.prop_type || null,
                yearBuilt: p.year_built ?? null,
                daysOnMarket: null,
                latitude: addr.lat ?? null,
                longitude: addr.lon ?? null,
                status: p.prop_status || 'for_sale',
                imgSrc: p.thumbnail ?? p.photos?.[0]?.href ?? null,
              };
            }),
          };
        }
      } catch (err) {
        console.log('Realtor listings API failed:', err.message);
      }
    }

    // Source 3: RentCast — listings
    if (!result && RENTCAST_KEY) {
      try {
        const data = await rentcastFetch('/listings/sale', {
          city, state, zipCode, bedrooms: beds, bathrooms: baths,
          status: 'Active', priceMin: minPrice, priceMax: maxPrice,
          limit: limit || 25,
        });
        if (Array.isArray(data) && data.length > 0) {
          result = {
            source: 'rentcast',
            listings: data.map(l => ({
              address: l.formattedAddress || l.addressLine1,
              city: l.city,
              state: l.state,
              zipCode: l.zipCode,
              price: l.price,
              bedrooms: l.bedrooms,
              bathrooms: l.bathrooms,
              squareFootage: l.squareFootage,
              propertyType: l.propertyType,
              latitude: l.latitude,
              longitude: l.longitude,
              daysOnMarket: l.daysOnMarket,
              yearBuilt: l.yearBuilt,
              status: l.status,
            })),
          };
        }
      } catch (err) {
        console.log('RentCast listings failed:', err.message);
      }
    }

    if (!result) {
      return res.status(404).json({ error: 'No listings found from any source' });
    }

    cacheSet(cacheKey, result);
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
  sources.geocoding = 'active (free)';

  res.json({
    status: 'ok',
    sources,
    cache: { entries: cache.size },
    uptime: process.uptime(),
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\nPropScout running at http://localhost:${PORT}\n`);
  console.log('Data sources (cascade order):');
  if (RAPIDAPI_KEY) {
    console.log('  1. Zillow (RapidAPI): ACTIVE');
    console.log('  2. Realtor.com (RapidAPI): ACTIVE');
  } else {
    console.log('  1. Zillow (RapidAPI): not configured — add RAPIDAPI_KEY to .env');
    console.log('  2. Realtor.com (RapidAPI): not configured — add RAPIDAPI_KEY to .env');
  }
  if (RENTCAST_KEY) console.log('  3. RentCast: ACTIVE');
  else console.log('  3. RentCast: not configured — add RENTCAST_API_KEY to .env');
  console.log('  Cache: 24-hour TTL\n');
});
