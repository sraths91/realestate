require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RENTCAST_KEY = process.env.RENTCAST_API_KEY;
const WALKSCORE_KEY = process.env.WALKSCORE_API_KEY;
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

    // Enrich listings with Deal Pulse metrics
    if (result.listings) {
      result.listings = enrichWithDealPulse(result.listings);
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
// MOMENTUM SCORE — Census + Walk Score + FBI Crime → composite 0-100
// ===========================================================================

/**
 * Fetch Census ACS data by zip code (ZCTA). Free, no key required.
 * Returns median income, median home value, population, vacancy rate.
 */
async function censusApiFetch(zipCode) {
  const cacheKey = `census:${zipCode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // ACS 5-year estimates: B19013_001E = median income, B25077_001E = median home value,
  // B01003_001E = population, B25002_003E = vacant units, B25002_001E = total units
  const vars = 'B19013_001E,B25077_001E,B01003_001E,B25002_003E,B25002_001E';
  const url = `https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=zip%20code%20tabulation%20area:${zipCode}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!r.ok) throw new Error(`Census API ${r.status}`);
  const data = await r.json();
  // Response: [[header], [values, ..., zipCode]]
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
 * Returns violent + property crime rates per 100k.
 */
async function crimeApiFetch(stateAbbr) {
  if (!stateAbbr) return null;
  const cacheKey = `crime:${stateAbbr.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // FBI CDE API — state-level crime estimates
  const url = `https://api.usa.gov/crime/fbi/cde/estimate/state/${stateAbbr.toLowerCase()}?from=2020&to=2022&API_KEY=iiHnOKfno2Mgkt5AynpvPpUQTEyxE77jo1RU8PIv`;
  const r = await fetch(url, { headers: { 'User-Agent': 'PropScout/1.0' } });
  if (!r.ok) throw new Error(`FBI Crime API ${r.status}`);
  const data = await r.json();

  // Get the most recent year's data
  const results = data.results || [];
  const latest = results[results.length - 1] || {};
  const pop = latest.population || 1;
  const result = {
    violentCrimeRate: latest.violent_crime ? Math.round((latest.violent_crime / pop) * 100000) : null,
    propertyCrimeRate: latest.property_crime ? Math.round((latest.property_crime / pop) * 100000) : null,
    year: latest.year || null,
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Compute composite momentum score (0-100).
 * Weights: priceTrend 25%, walkability 15%, safety 20%, income 15%, affordability 25%
 */
function computeMomentumScore(census, walkScore, crime) {
  const factors = [];

  // 1. Affordability (25%) — income-to-price ratio
  //    National median: ~$75k income, ~$300k home → ratio ~0.25
  //    Higher ratio = more affordable = better score
  let affordabilityScore = 50;
  if (census?.medianIncome && census?.medianHomeValue && census.medianHomeValue > 0) {
    const ratio = census.medianIncome / census.medianHomeValue;
    // ratio 0.4+ = excellent (100), 0.25 = average (50), 0.1 = poor (10)
    affordabilityScore = Math.min(100, Math.max(0, Math.round(ratio * 250)));
  }
  factors.push({ name: 'Affordability', score: affordabilityScore, weight: 0.25, detail: census?.medianHomeValue ? `Median home $${(census.medianHomeValue / 1000).toFixed(0)}K vs income $${(census.medianIncome / 1000).toFixed(0)}K` : 'No data available' });

  // 2. Price Trend (25%) — based on vacancy rate as proxy
  //    Lower vacancy = higher demand = positive trend
  let priceTrendScore = 50;
  if (census?.vacantUnits != null && census?.totalUnits > 0) {
    const vacancyRate = census.vacantUnits / census.totalUnits;
    // 2% vacancy = hot market (90), 10% = average (50), 20%+ = cold (10)
    priceTrendScore = Math.min(100, Math.max(0, Math.round(100 - vacancyRate * 500)));
  }
  factors.push({ name: 'Price Trend', score: priceTrendScore, weight: 0.25, detail: census?.totalUnits ? `${((census.vacantUnits / census.totalUnits) * 100).toFixed(1)}% vacancy rate` : 'Based on market indicators' });

  // 3. Safety (20%) — inverse of crime rate
  //    National avg violent crime: ~380 per 100k
  let safetyScore = 50;
  if (crime?.violentCrimeRate != null) {
    // 100/100k = very safe (95), 380/100k = average (50), 800+ = poor (10)
    safetyScore = Math.min(100, Math.max(0, Math.round(100 - (crime.violentCrimeRate / 8))));
  }
  factors.push({ name: 'Safety', score: safetyScore, weight: 0.20, detail: crime?.violentCrimeRate ? `${crime.violentCrimeRate} violent crimes per 100K` : 'State-level estimate' });

  // 4. Walkability (15%)
  let walkabilityScore = 50;
  if (walkScore?.walkscore != null) {
    walkabilityScore = walkScore.walkscore;
  }
  factors.push({ name: 'Walkability', score: walkabilityScore, weight: 0.15, detail: walkScore?.description || (WALKSCORE_KEY ? 'Score unavailable' : 'Add WALKSCORE_API_KEY for data') });

  // 5. Income (15%) — median income relative to national ($75k)
  let incomeScore = 50;
  if (census?.medianIncome) {
    // $50k = 33, $75k = 50, $100k = 67, $150k = 100
    incomeScore = Math.min(100, Math.max(0, Math.round((census.medianIncome / 150000) * 100)));
  }
  factors.push({ name: 'Income', score: incomeScore, weight: 0.15, detail: census?.medianIncome ? `$${(census.medianIncome / 1000).toFixed(0)}K median household` : 'No data available' });

  // Weighted average
  const overall = Math.round(factors.reduce((sum, f) => sum + f.score * f.weight, 0));

  // Trend direction
  let trend = 'stable';
  if (overall >= 65) trend = 'up';
  else if (overall <= 35) trend = 'down';

  return { overallScore: overall, trend, factors };
}

app.get('/api/momentum', async (req, res) => {
  try {
    const { zipCode, lat, lon, state } = req.query;
    if (!zipCode) return res.status(400).json({ error: 'Missing zipCode parameter' });

    const cacheKey = `momentum:${zipCode}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    let census = null, walkScore = null, crime = null;
    const errors = [];

    // Fetch all data sources in parallel
    const [censusResult, walkResult, crimeResult] = await Promise.allSettled([
      censusApiFetch(zipCode),
      lat && lon ? walkScoreFetch(parseFloat(lat), parseFloat(lon), '') : Promise.resolve(null),
      state ? crimeApiFetch(state) : Promise.resolve(null),
    ]);

    if (censusResult.status === 'fulfilled') census = censusResult.value;
    else errors.push('Census: ' + censusResult.reason?.message);

    if (walkResult.status === 'fulfilled') walkScore = walkResult.value;
    else errors.push('Walk Score: ' + walkResult.reason?.message);

    if (crimeResult.status === 'fulfilled') crime = crimeResult.value;
    else errors.push('Crime: ' + crimeResult.reason?.message);

    // If we got no data at all, return demo
    if (!census && !walkScore && !crime) {
      return res.json({
        demo: true,
        zipCode,
        ...getDemoMomentum(),
      });
    }

    const result = {
      zipCode,
      ...computeMomentumScore(census, walkScore, crime),
      rawData: { census, walkScore, crime },
      errors: errors.length ? errors : undefined,
    };

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Demo momentum data for when APIs are unavailable. */
function getDemoMomentum() {
  const scores = [
    { name: 'Affordability', score: 62, weight: 0.25, detail: 'Median home $285K vs income $72K' },
    { name: 'Price Trend', score: 71, weight: 0.25, detail: '5.8% vacancy rate — moderate demand' },
    { name: 'Safety', score: 58, weight: 0.20, detail: '335 violent crimes per 100K' },
    { name: 'Walkability', score: 45, weight: 0.15, detail: 'Car-Dependent' },
    { name: 'Income', score: 48, weight: 0.15, detail: '$72K median household' },
  ];
  const overall = Math.round(scores.reduce((s, f) => s + f.score * f.weight, 0));
  return { overallScore: overall, trend: 'up', factors: scores };
}

// ===========================================================================
// DEAL PULSE — compute deal quality metrics for listings
// ===========================================================================

/**
 * Enrich listings with Deal Pulse metrics.
 * @param {Array} listings - Array of normalized listing objects
 * @returns {Array} listings with dealPulse, priceDropProbability, offerTiming, marketPosition
 */
function enrichWithDealPulse(listings) {
  if (!listings.length) return listings;

  const withPrice = listings.filter(l => l.price > 0 && l.squareFootage > 0);
  const medianPpsf = withPrice.length
    ? withPrice.map(l => l.price / l.squareFootage).sort((a, b) => a - b)[Math.floor(withPrice.length / 2)]
    : 0;
  const avgPrice = withPrice.length
    ? withPrice.reduce((s, l) => s + l.price, 0) / withPrice.length
    : 0;

  return listings.map(listing => {
    const ppsf = listing.squareFootage > 0 ? listing.price / listing.squareFootage : 0;
    const dom = listing.daysOnMarket || 0;

    // Price drop probability (0-100%)
    let priceDropProb = 15; // baseline
    if (dom > 60) priceDropProb += 35;
    else if (dom > 30) priceDropProb += 20;
    else if (dom > 14) priceDropProb += 8;

    if (medianPpsf > 0 && ppsf > 0) {
      const priceRatio = ppsf / medianPpsf;
      if (priceRatio > 1.15) priceDropProb += 20;
      else if (priceRatio > 1.05) priceDropProb += 10;
      else if (priceRatio < 0.9) priceDropProb -= 10;
    }
    priceDropProb = Math.max(5, Math.min(85, priceDropProb));

    // Market position
    let marketPosition = 'fair';
    if (medianPpsf > 0 && ppsf > 0) {
      const ratio = ppsf / medianPpsf;
      if (ratio < 0.92) marketPosition = 'underpriced';
      else if (ratio > 1.08) marketPosition = 'overpriced';
    }

    // Offer timing
    let offerTiming = 'watch';
    if (marketPosition === 'underpriced' && dom < 14) offerTiming = 'now';
    else if (dom > 30 || priceDropProb > 45) offerTiming = 'wait';
    else if (marketPosition === 'underpriced') offerTiming = 'now';

    // Deal Pulse rating
    let dealPulse = 'cold';
    let dealScore = 50;

    // Enhanced deal score
    if (medianPpsf > 0 && ppsf > 0) {
      const ratio = ppsf / medianPpsf;
      if (ratio < 0.85) dealScore += 25;
      else if (ratio < 0.95) dealScore += 15;
      else if (ratio < 1.05) dealScore += 5;
      else if (ratio > 1.15) dealScore -= 15;
      else if (ratio > 1.05) dealScore -= 5;
    }
    if (dom > 60) dealScore += 15;
    else if (dom > 30) dealScore += 10;
    else if (dom > 14) dealScore += 5;

    if (listing.yearBuilt >= 2015) dealScore += 5;
    else if (listing.yearBuilt >= 2000) dealScore += 3;

    if (priceDropProb > 50) dealScore += 8;
    else if (priceDropProb > 30) dealScore += 4;

    dealScore = Math.max(0, Math.min(100, dealScore));

    if (dealScore >= 72) dealPulse = 'hot';
    else if (dealScore >= 55) dealPulse = 'warm';

    return {
      ...listing,
      dealPulse,
      dealScore,
      priceDropProbability: priceDropProb,
      offerTiming,
      marketPosition,
    };
  });
}

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
  sources.census = 'active (free)';
  sources.walkscore = WALKSCORE_KEY ? 'active' : 'not configured';
  sources.crime = 'active (free)';
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
