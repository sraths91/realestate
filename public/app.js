/* ===================================================================
   PropScout — Real Estate Analytics Engine
   =================================================================== */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  currentTab: 'search',
  searchMap: null,
  mainMap: null,
  mainMapMarkers: null,
  mapCenter: null,
  apiLive: false,
  demoMode: false,
  searchCache: new Map(),
  savedProperties: [],
  lastSearchProperty: null,
  lastSearchValuation: null,
  heatLayer: null,
  heatEnabled: false,
  heatMetric: 'home-value',
  alerts: [],
  unreadAlertCount: 0,
  savedSearches: [],
  clients: [],
};

// ---------------------------------------------------------------------------
// US state name → abbreviation lookup
// ---------------------------------------------------------------------------
const STATE_ABBR_MAP = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS',
  'kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD','massachusetts':'MA',
  'michigan':'MI','minnesota':'MN','mississippi':'MS','missouri':'MO','montana':'MT',
  'nebraska':'NE','nevada':'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM',
  'new york':'NY','north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK',
  'oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT',
  'virginia':'VA','washington':'WA','west virginia':'WV','wisconsin':'WI','wyoming':'WY',
  'district of columbia':'DC',
};

/** Convert full state name or abbreviation to 2-letter abbreviation */
function stateNameToAbbr(name) {
  if (!name) return '';
  const s = name.trim();
  // Already a 2-letter abbreviation
  if (/^[A-Z]{2}$/.test(s)) return s;
  return STATE_ABBR_MAP[s.toLowerCase()] || '';
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSearch();
  initScanner();
  initMap();
  initAnalytics();
  initMomentum();
  initHeatmap();
  initSaved();
  initCalculator();
  initAlerts();
  initSavedSearches();
  initAgentSettings();
  initCompare();
  initClients();
  initAIAnalytics();
  checkApiStatus();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function initTabs() {
  const btns = document.querySelectorAll('.tab-btn');
  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      btns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      document.getElementById(`tab-${tab}`).classList.add('active');
      state.currentTab = tab;
      if (tab === 'map' && state.mainMap) {
        setTimeout(() => state.mainMap.invalidateSize(), 100);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// API Status
// ---------------------------------------------------------------------------
async function checkApiStatus() {
  const el = document.getElementById('api-status');
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.status === 'ok') {
      state.apiLive = true;
      // Only count real data sources (not geocoding which is always free)
      const dataSources = ['zillow', 'realtor', 'rentcast'];
      const activeSources = dataSources.filter(s =>
        data.sources?.[s] === 'active'
      );
      if (activeSources.length > 0) {
        el.className = 'api-status live';
        el.querySelector('.status-text').textContent = activeSources.join(' + ');
      } else {
        el.className = 'api-status demo';
        el.querySelector('.status-text').textContent = 'Demo Mode — add API keys';
        state.demoMode = true;
      }
    } else {
      el.className = 'api-status demo';
      el.querySelector('.status-text').textContent = 'Demo Mode';
      state.demoMode = true;
    }
  } catch {
    el.className = 'api-status error';
    el.querySelector('.status-text').textContent = 'Offline';
    state.demoMode = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function $(id) {
  return document.getElementById(id);
}
function fmt(n) {
  if (n == null || isNaN(n)) return '--';
  return Number(n).toLocaleString('en-US');
}
function fmtCurrency(n) {
  if (n == null || isNaN(n)) return '--';
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '--';
  return (n * 100).toFixed(1) + '%';
}
function show(el) {
  if (typeof el === 'string') el = $(el);
  el.classList.remove('hidden');
}
function hide(el) {
  if (typeof el === 'string') el = $(el);
  el.classList.add('hidden');
}
function toast(msg, type = 'info') {
  const container = $('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// Demo Data (used when API key is not configured)
// Generates location-aware data based on geocoded coordinates
// ---------------------------------------------------------------------------
const STREET_NAMES = [
  'Oak Lane', 'Maple Dr', 'Elm St', 'Pine Ave', 'Birch Ct',
  'Cedar Blvd', 'Walnut Way', 'Willow Rd', 'Ash Pl', 'Cherry Ln',
  'Spruce St', 'Hickory Dr', 'Magnolia Ave', 'Poplar Ct', 'Cypress Way',
];
const PROP_TYPES = ['Single Family', 'Single Family', 'Single Family', 'Condo', 'Townhouse'];

function randBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function jitterCoord(base, spread) {
  return base + (Math.random() - 0.5) * spread;
}

function getDemoProperty(address, lat, lon, locationParts) {
  const city = locationParts?.city || 'Demo City';
  const st = locationParts?.state || 'XX';
  const zip = locationParts?.zip || '00000';
  return {
    addressLine1: address || '123 Demo Street',
    city, state: st, zipCode: zip,
    propertyType: 'Single Family',
    bedrooms: 4, bathrooms: 2.5, squareFootage: 2100, lotSize: 8500,
    yearBuilt: randBetween(1975, 2015),
    lastSaleDate: '2019-06-15', lastSalePrice: randBetween(250000, 350000),
    taxAssessment: randBetween(270000, 320000),
    latitude: lat, longitude: lon,
  };
}

function getDemoValuation(lat, lon, locationParts) {
  const city = locationParts?.city || 'Demo City';
  const st = locationParts?.state || 'XX';
  const zip = locationParts?.zip || '00000';
  const basePrice = randBetween(280000, 400000);
  return {
    price: basePrice,
    priceRangeLow: Math.round(basePrice * 0.93),
    priceRangeHigh: Math.round(basePrice * 1.07),
    pricePerSquareFoot: Math.round(basePrice / 2100),
    rentEstimate: Math.round(basePrice * 0.005),
    comparables: Array.from({ length: 5 }, (_, i) => ({
      formattedAddress: `${randBetween(100, 999)} ${STREET_NAMES[i]}, ${city}, ${st} ${zip}`,
      price: randBetween(Math.round(basePrice * 0.85), Math.round(basePrice * 1.15)),
      squareFootage: randBetween(1600, 2600),
      bedrooms: randBetween(3, 5),
      bathrooms: [2, 2, 2.5, 3, 3.5][i],
      distance: +(0.2 + i * 0.25).toFixed(1),
      propertyType: 'Single Family',
      yearBuilt: randBetween(1980, 2018),
      latitude: jitterCoord(lat, 0.012),
      longitude: jitterCoord(lon, 0.012),
    })),
  };
}

function getDemoListings(lat, lon, locationParts) {
  const city = locationParts?.city || 'Demo City';
  const st = locationParts?.state || 'XX';
  const zip = locationParts?.zip || '00000';
  const medianPpsf = 172;
  return Array.from({ length: 8 }, (_, i) => {
    const price = randBetween(180000, 550000);
    const sqft = randBetween(1100, 3400);
    const dom = randBetween(2, 65);
    const hasDropped = Math.random() > 0.6;
    const dropAmt = hasDropped ? randBetween(5000, 35000) : 0;
    const ppsf = price / sqft;

    return {
      formattedAddress: `${randBetween(100, 999)} ${STREET_NAMES[i % STREET_NAMES.length]}, ${city}, ${st} ${zip}`,
      price,
      squareFootage: sqft,
      bedrooms: randBetween(2, 5),
      bathrooms: [1, 1.5, 2, 2, 2.5, 3, 3, 3.5][i],
      propertyType: PROP_TYPES[i % PROP_TYPES.length],
      yearBuilt: randBetween(1985, 2020),
      daysOnMarket: dom,
      latitude: jitterCoord(lat, 0.015),
      longitude: jitterCoord(lon, 0.015),
      status: 'Active',
      priceHistory: {
        hasDropped,
        totalDrop: dropAmt,
        totalDropPercent: hasDropped ? ((dropAmt / (price + dropAmt)) * 100).toFixed(1) : '0',
        daysSinceFirstSeen: randBetween(0, 90),
        snapshots: [],
        priceChanges: [],
      },
      biddingWarProb: dom < 10 ? randBetween(30, 70) : randBetween(5, 25),
      daysToSellEstimate: Math.round(18 * (ppsf / medianPpsf) * (dom < 14 ? 0.7 : 1.2)),
    };
  });
}

/**
 * Generate a demo comp narrative for client-side demo mode.
 */
function getDemoCompNarrative(listings) {
  const withPrice = listings.filter(l => l.price > 0);
  const prices = withPrice.map(l => l.price).sort((a, b) => a - b);
  const fastMovers = withPrice.filter(l => l.daysOnMarket < 14);
  const dropped = withPrice.filter(l => l.priceHistory?.hasDropped);
  const lo = `$${(prices[0] / 1000).toFixed(0)}K`;
  const hi = `$${(prices[prices.length - 1] / 1000).toFixed(0)}K`;
  return {
    summary: `${withPrice.length} comparable properties range from ${lo}-${hi}${fastMovers.length > withPrice.length / 2 ? ', with the majority moving in under 2 weeks' : ''}.`,
    bullets: [
      `${fastMovers.length} of ${withPrice.length} comps listed under 14 days`,
      dropped.length > 0 ? `${dropped.length} have already reduced price` : null,
      'Market average DOM: 18 days (demo data)',
    ].filter(Boolean),
    confidence: 'medium',
  };
}

function getDemoMarket() {
  return {
    saleData: {
      medianPrice: 325000, averagePricePerSquareFoot: 158,
      totalInventory: 245, averageDaysOnMarket: 18,
      medianSquareFootage: 1950,
    },
    rentalData: {
      medianRent: 1650, averageRentPerSquareFoot: 0.95,
      totalInventory: 89, averageDaysOnMarket: 14,
    },
    history: Array.from({ length: 12 }, (_, i) => ({
      month: new Date(2025, i + 3).toISOString().slice(0, 7),
      medianPrice: 310000 + Math.round(Math.random() * 30000),
      medianRent: 1550 + Math.round(Math.random() * 200),
    })),
  };
}

/**
 * Geocode an address and generate demo data for it.
 */
async function fallbackToDemo(address) {
  let lat = 39.8283, lon = -98.5795, locationParts = {};
  try {
    const geoRes = await fetch(`/api/geocode?q=${encodeURIComponent(address)}`);
    const geoData = await geoRes.json();
    if (geoData.length) {
      lat = parseFloat(geoData[0].lat);
      lon = parseFloat(geoData[0].lon);
      const parts = geoData[0].display_name.split(', ');
      locationParts = {
        city: parts[1] || parts[0] || 'Demo City',
        state: parts[2] || 'XX',
        zip: (parts.find((p) => /^\d{5}/.test(p)) || '00000').slice(0, 5),
      };
    }
  } catch { /* fall back to defaults */ }
  return {
    prop: getDemoProperty(address, lat, lon, locationParts),
    val: getDemoValuation(lat, lon, locationParts),
    lat, lon, locationParts,
  };
}

// ---------------------------------------------------------------------------
// SEARCH TAB
// ---------------------------------------------------------------------------
function initSearch() {
  const input = $('search-input');
  const btn = $('search-btn');
  const suggestions = $('search-suggestions');

  btn.addEventListener('click', () => performSearch(input.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performSearch(input.value.trim());
  });

  // Address autocomplete via Nominatim
  const autoComplete = debounce(async (q) => {
    if (q.length < 4) {
      suggestions.classList.remove('show');
      return;
    }
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data.length) {
        suggestions.classList.remove('show');
        return;
      }
      suggestions.innerHTML = data
        .map(
          (d) =>
            `<div class="suggestion-item" data-lat="${d.lat}" data-lon="${d.lon}" data-name="${d.display_name}">${d.display_name}</div>`
        )
        .join('');
      suggestions.classList.add('show');
      suggestions.querySelectorAll('.suggestion-item').forEach((item) => {
        item.addEventListener('click', () => {
          input.value = item.dataset.name;
          suggestions.classList.remove('show');
          performSearch(item.dataset.name);
        });
      });
    } catch {
      /* ignore */
    }
  }, 350);

  input.addEventListener('input', () => autoComplete(input.value.trim()));
  document.addEventListener('click', (e) => {
    if (!suggestions.contains(e.target) && e.target !== input) {
      suggestions.classList.remove('show');
    }
  });
}

async function performSearch(address) {
  if (!address) return toast('Please enter an address', 'error');

  hide('search-results');
  hide('search-empty');
  show('search-loading');

  // If server is unreachable, fall back to demo data
  if (state.demoMode && !state.apiLive) {
    let lat = 39.8283, lon = -98.5795, locationParts = {};
    try {
      const geoRes = await fetch(`/api/geocode?q=${encodeURIComponent(address)}`);
      const geoData = await geoRes.json();
      if (geoData.length) {
        lat = parseFloat(geoData[0].lat);
        lon = parseFloat(geoData[0].lon);
        const parts = geoData[0].display_name.split(', ');
        locationParts = {
          city: parts[1] || parts[0] || 'Demo City',
          state: parts[2] || 'XX',
          zip: (parts.find((p) => /^\d{5}/.test(p)) || '00000').slice(0, 5),
        };
      }
    } catch { /* fall back to defaults */ }

    const prop = getDemoProperty(address, lat, lon, locationParts);
    const val = getDemoValuation(lat, lon, locationParts);
    renderSearchResults(prop, val);
    hide('search-loading');
    show('search-results');
    toast('Server offline — showing demo data', 'info');
    return;
  }

  try {
    const res = await fetch(`/api/property-lookup?address=${encodeURIComponent(address)}`);
    const data = await res.json();

    // If API returned an error, fall back to demo data
    if (data.error) {
      const demoResult = await fallbackToDemo(address);
      renderSearchResults(demoResult.prop, demoResult.val);
      hide('search-loading');
      show('search-results');
      toast('No API keys configured — showing demo data. Add keys to .env for real results.', 'info');
      return;
    }

    const source = data.source || 'unknown';
    const property = data.property;
    if (!property) {
      hide('search-loading');
      show('search-empty');
      return;
    }

    // Normalize into the shape renderSearchResults expects
    const prop = {
      addressLine1: property.address || address,
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
    };

    // Build valuation object from whatever source provided
    let valuation = null;
    if (source === 'zillow') {
      const estimate = property.zestimate || property.price;
      if (estimate) {
        valuation = {
          price: estimate,
          priceRangeLow: Math.round(estimate * 0.95),
          priceRangeHigh: Math.round(estimate * 1.05),
          rentEstimate: property.rentZestimate || null,
          comparables: [],
        };
      }
    } else if (data.valuation) {
      valuation = {
        price: data.valuation.price,
        priceRangeLow: data.valuation.priceRangeLow,
        priceRangeHigh: data.valuation.priceRangeHigh,
        rentEstimate: data.rentEstimate || null,
        comparables: data.valuation.comparables || [],
      };
    }

    renderSearchResults(prop, valuation);
    hide('search-loading');
    show('search-results');

    const cached = data.cached ? ' (cached)' : '';
    toast(`Data from ${source}${cached}`, 'success');
  } catch (err) {
    hide('search-loading');
    show('search-empty');
    $('search-empty-text').textContent = err.message || 'Failed to fetch property data.';
    toast(err.message, 'error');
  }
}

function renderSearchResults(property, valuation) {
  // Store for save functionality
  state.lastSearchProperty = property;
  state.lastSearchValuation = valuation;

  // Property card
  $('prop-address').textContent =
    property.addressLine1 || property.formattedAddress || '--';
  $('prop-type').textContent = property.propertyType || '--';
  $('prop-beds').textContent = fmt(property.bedrooms);
  $('prop-baths').textContent = fmt(property.bathrooms);
  $('prop-sqft').textContent = fmt(property.squareFootage);
  $('prop-lot').textContent = property.lotSize ? fmt(property.lotSize) + ' sqft' : '--';
  $('prop-year').textContent = property.yearBuilt || '--';
  $('prop-last-sale').textContent = property.lastSaleDate
    ? new Date(property.lastSaleDate).toLocaleDateString()
    : '--';
  $('prop-last-price').textContent = fmtCurrency(property.lastSalePrice);
  $('prop-tax').textContent = fmtCurrency(property.taxAssessment);

  // Valuation card
  if (valuation) {
    $('val-estimate').textContent = fmtCurrency(valuation.price);
    $('val-low').textContent = fmtCurrency(valuation.priceRangeLow);
    $('val-high').textContent = fmtCurrency(valuation.priceRangeHigh);
    const ppsf = valuation.pricePerSquareFoot ||
      (property.squareFootage ? valuation.price / property.squareFootage : null);
    $('val-ppsf').textContent = ppsf ? '$' + ppsf.toFixed(0) : '--';
    $('val-rent').textContent = valuation.rentEstimate
      ? fmtCurrency(valuation.rentEstimate) + '/mo'
      : '--';

    // Investment metrics
    if (valuation.price && valuation.rentEstimate) {
      const annualRent = valuation.rentEstimate * 12;
      const grossYield = annualRent / valuation.price;
      const noi = annualRent * 0.6; // rough 40% expense ratio
      const capRate = noi / valuation.price;
      $('val-cap').textContent = fmtPct(capRate);
      $('val-yield').textContent = fmtPct(grossYield);
    }
  }

  // Save button — add to property card header
  const existingSaveBtn = document.querySelector('#property-card .btn-save');
  if (existingSaveBtn) existingSaveBtn.remove();
  const saveBtn = document.createElement('button');
  const addr = property.addressLine1 || property.formattedAddress || '';
  const isSaved = state.savedProperties.some(s => s.address === addr);
  saveBtn.className = `btn-save${isSaved ? ' saved' : ''}`;
  saveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>${isSaved ? 'Saved' : 'Save'}`;
  saveBtn.addEventListener('click', () => toggleSaveProperty(property, valuation));
  $('property-card').querySelector('.card-header').appendChild(saveBtn);

  // AI Verdict button
  const existingVerdictBtn = document.querySelector('#property-card .btn-ai');
  if (existingVerdictBtn) existingVerdictBtn.remove();
  const verdictBtn = document.createElement('button');
  verdictBtn.className = 'btn-ai';
  verdictBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M12 6v6l4 2"/></svg> AI Verdict';
  verdictBtn.addEventListener('click', () => requestAIVerdict(addr));
  $('property-card').querySelector('.card-header').appendChild(verdictBtn);

  // Comparables
  const compsGrid = $('comps-grid');
  compsGrid.innerHTML = '';
  const comps = valuation?.comparables || [];
  comps.forEach((comp) => {
    const card = document.createElement('div');
    card.className = 'comp-card';
    card.innerHTML = `
      <div class="comp-address">${comp.formattedAddress || comp.addressLine1 || '--'}</div>
      <div class="comp-price">${fmtCurrency(comp.price || comp.lastSalePrice)}</div>
      <div class="comp-details">
        <span class="comp-detail">${comp.bedrooms || '--'} bd</span>
        <span class="comp-detail">${comp.bathrooms || '--'} ba</span>
        <span class="comp-detail">${fmt(comp.squareFootage)} sqft</span>
        <span class="comp-detail">${comp.propertyType || '--'}</span>
      </div>
      ${comp.distance != null ? `<div class="comp-distance">${comp.distance.toFixed(1)} mi away</div>` : ''}
    `;
    compsGrid.appendChild(card);
  });

  // Mini map
  renderSearchMap(property, comps);
}

function renderSearchMap(property, comps) {
  const container = $('search-map');
  if (state.searchMap) {
    state.searchMap.remove();
    state.searchMap = null;
  }

  const lat = property.latitude || 39.8283;
  const lng = property.longitude || -98.5795;
  state.searchMap = L.map(container).setView([lat, lng], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
  }).addTo(state.searchMap);

  // Subject marker
  const subjectIcon = L.divIcon({
    className: 'custom-marker subject',
    html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3L12 2z"/></svg>',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
  L.marker([lat, lng], { icon: subjectIcon })
    .addTo(state.searchMap)
    .bindPopup(
      `<div class="popup-title">${property.addressLine1 || 'Subject Property'}</div>
       <div class="popup-details">${property.bedrooms || '--'} bd | ${property.bathrooms || '--'} ba | ${fmt(property.squareFootage)} sqft</div>`
    );

  // Comp markers
  const compIcon = L.divIcon({
    className: 'custom-marker comp',
    html: 'C',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  comps.forEach((comp) => {
    if (!comp.latitude || !comp.longitude) return;
    L.marker([comp.latitude, comp.longitude], { icon: compIcon })
      .addTo(state.searchMap)
      .bindPopup(
        `<div class="popup-title">${comp.formattedAddress || comp.addressLine1 || '--'}</div>
         <div class="popup-price">${fmtCurrency(comp.price || comp.lastSalePrice)}</div>
         <div class="popup-details">${comp.bedrooms || '--'} bd | ${comp.bathrooms || '--'} ba | ${fmt(comp.squareFootage)} sqft</div>`
      );
  });

  // Fit bounds to all markers
  const points = [[lat, lng], ...comps.filter((c) => c.latitude).map((c) => [c.latitude, c.longitude])];
  if (points.length > 1) {
    state.searchMap.fitBounds(points, { padding: [30, 30] });
  }
}

// ---------------------------------------------------------------------------
// SCANNER TAB
// ---------------------------------------------------------------------------
function initScanner() {
  // Toggle button groups
  document.querySelectorAll('.btn-group').forEach((group) => {
    const btns = group.querySelectorAll('.btn-toggle');
    btns[0]?.classList.add('active'); // default "Any"
    btns.forEach((btn) => {
      btn.addEventListener('click', () => {
        btns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });

  $('scan-btn').addEventListener('click', performScan);
}

async function performScan() {
  const city = $('scan-city').value.trim();
  const stateVal = $('scan-state').value.trim();
  const zip = $('scan-zip').value.trim();

  if (!city && !zip) {
    toast('Enter a city or zip code', 'error');
    return;
  }

  const type = $('scan-type').value;
  const priceMin = $('scan-price-min').value || undefined;
  const priceMax = $('scan-price-max').value || undefined;
  const beds = document.querySelector('#scan-beds-group .btn-toggle.active')?.dataset.val || undefined;
  const baths = document.querySelector('#scan-baths-group .btn-toggle.active')?.dataset.val || undefined;

  hide('scan-empty');
  hide('scan-summary');
  show('scan-loading');
  $('scan-list').innerHTML = '';

  if (state.demoMode && !state.apiLive) {
    // Server offline — geocode and show demo data
    let lat = 39.8283, lon = -98.5795, locationParts = { city: city || 'Demo City', state: stateVal || 'XX', zip: zip || '00000' };
    try {
      const q = zip || `${city}, ${stateVal}`;
      const geoRes = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const geoData = await geoRes.json();
      if (geoData.length) {
        lat = parseFloat(geoData[0].lat);
        lon = parseFloat(geoData[0].lon);
        const parts = geoData[0].display_name.split(', ');
        locationParts.city = locationParts.city || parts[0];
        locationParts.state = locationParts.state || parts[2] || 'XX';
      }
    } catch { /* fall back */ }
    const listings = getDemoListings(lat, lon, locationParts);
    renderScanResults(listings, getDemoCompNarrative(listings));
    hide('scan-loading');
    toast('Server offline — showing demo data', 'info');
    return;
  }

  try {
    const location = zip || (city && stateVal ? `${city}, ${stateVal}` : city);
    const params = new URLSearchParams();
    params.set('location', location);
    if (city) params.set('city', city);
    if (stateVal) params.set('state', stateVal);
    if (zip) params.set('zipCode', zip);
    if (priceMin) params.set('minPrice', priceMin);
    if (priceMax) params.set('maxPrice', priceMax);
    if (beds) params.set('beds', beds);
    if (baths) params.set('baths', baths);

    const res = await fetch(`/api/listings-lookup?${params}`);
    const data = await res.json();
    if (data.error) {
      // No API keys — fall back to demo data
      let lat = 39.8283, lon = -98.5795;
      const locationParts = { city: city || 'Demo City', state: stateVal || 'XX', zip: zip || '00000' };
      try {
        const q = zip || `${city}, ${stateVal}`;
        const geoRes = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        const geoData = await geoRes.json();
        if (geoData.length) { lat = parseFloat(geoData[0].lat); lon = parseFloat(geoData[0].lon); }
      } catch { /* ignore */ }
      const demoListings = getDemoListings(lat, lon, locationParts);
      renderScanResults(demoListings, getDemoCompNarrative(demoListings));
      hide('scan-loading');
      toast('No API keys configured — showing demo data', 'info');
      return;
    }

    const listings = Array.isArray(data.listings) ? data.listings : [];
    if (!listings.length) {
      hide('scan-loading');
      $('scan-list').innerHTML =
        '<div class="empty-state"><p>No listings found matching your criteria. Try adjusting filters.</p></div>';
      return;
    }

    // Normalize listing fields for renderScanResults
    const normalized = listings.map(l => ({
      formattedAddress: l.formattedAddress || l.address || l.addressLine1 || '--',
      price: l.price || l.unformattedPrice || 0,
      squareFootage: l.squareFootage || l.area || 0,
      bedrooms: l.bedrooms || l.beds,
      bathrooms: l.bathrooms || l.baths,
      propertyType: l.propertyType,
      yearBuilt: l.yearBuilt,
      daysOnMarket: l.daysOnMarket || l.daysOnZillow,
      latitude: l.latitude,
      longitude: l.longitude,
      status: l.status || l.statusText,
      // Preserve Deal Pulse fields from server
      dealPulse: l.dealPulse,
      dealScore: l.dealScore,
      priceDropProbability: l.priceDropProbability,
      offerTiming: l.offerTiming,
      marketPosition: l.marketPosition,
      biddingWarProb: l.biddingWarProb,
      daysToSellEstimate: l.daysToSellEstimate,
      priceHistory: l.priceHistory,
    }));

    renderScanResults(normalized, data.compNarrative);
    hide('scan-loading');

    const cached = data.cached ? ' (cached)' : '';
    toast(`${normalized.length} listings from ${data.source}${cached}`, 'success');
  } catch (err) {
    hide('scan-loading');
    toast(err.message, 'error');
    $('scan-list').innerHTML =
      `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

function renderScanResults(listings, compNarrative) {
  // Calculate analytics
  const withPrice = listings.filter((l) => l.price > 0);
  const avgPrice = withPrice.reduce((s, l) => s + l.price, 0) / (withPrice.length || 1);
  const withSqft = listings.filter((l) => l.squareFootage > 0 && l.price > 0);
  const avgPpsf = withSqft.length
    ? withSqft.reduce((s, l) => s + l.price / l.squareFootage, 0) / withSqft.length
    : 0;

  // If server didn't add Deal Pulse (demo data), compute locally
  const scored = listings.map((listing) => {
    if (listing.dealPulse) return listing; // already enriched by server

    let score = 50;
    if (listing.squareFootage > 0 && avgPpsf > 0) {
      const ppsf = listing.price / listing.squareFootage;
      const ratio = ppsf / avgPpsf;
      if (ratio < 0.85) score += 25;
      else if (ratio < 0.95) score += 15;
      else if (ratio < 1.05) score += 5;
      else if (ratio > 1.15) score -= 15;
    }
    if (listing.daysOnMarket > 60) score += 15;
    else if (listing.daysOnMarket > 30) score += 10;
    else if (listing.daysOnMarket > 14) score += 5;
    if (listing.yearBuilt >= 2015) score += 5;
    else if (listing.yearBuilt >= 2000) score += 3;
    score = Math.max(0, Math.min(100, score));

    let dealPulse = 'cold';
    if (score >= 72) dealPulse = 'hot';
    else if (score >= 55) dealPulse = 'warm';

    const dom = listing.daysOnMarket || 0;
    let priceDropProbability = 15;
    if (dom > 60) priceDropProbability += 35;
    else if (dom > 30) priceDropProbability += 20;
    priceDropProbability = Math.min(85, priceDropProbability);

    let offerTiming = 'watch';
    if (score >= 65 && dom < 14) offerTiming = 'now';
    else if (dom > 30) offerTiming = 'wait';

    let marketPosition = 'fair';
    if (listing.squareFootage > 0 && avgPpsf > 0) {
      const ratio = (listing.price / listing.squareFootage) / avgPpsf;
      if (ratio < 0.92) marketPosition = 'underpriced';
      else if (ratio > 1.08) marketPosition = 'overpriced';
    }

    return { ...listing, dealScore: score, dealPulse, priceDropProbability, offerTiming, marketPosition };
  });

  // Sort by deal score descending
  scored.sort((a, b) => (b.dealScore || 0) - (a.dealScore || 0));
  const bestScore = scored[0]?.dealScore || 0;

  // Summary
  show('scan-summary');
  $('scan-count').textContent = listings.length;
  $('scan-avg-price').textContent = fmtCurrency(avgPrice);
  $('scan-avg-ppsf').textContent = avgPpsf ? '$' + avgPpsf.toFixed(0) : '--';
  $('scan-best-deal').textContent = bestScore + '/100';

  // Comp narrative
  const narrativeEl = $('scan-narrative');
  if (narrativeEl) {
    if (compNarrative && compNarrative.bullets && compNarrative.bullets.length > 0) {
      show('scan-narrative');
      $('narrative-summary').textContent = compNarrative.summary;
      const confEl = $('narrative-confidence');
      confEl.textContent = compNarrative.confidence;
      confEl.className = `narrative-confidence conf-${compNarrative.confidence}`;
      $('narrative-bullets').innerHTML = compNarrative.bullets.map(b => `<li>${b}</li>`).join('');
    } else {
      hide('scan-narrative');
    }
  }

  // Listing cards
  const list = $('scan-list');
  list.innerHTML = '';
  scored.forEach((listing, i) => {
    const ppsf =
      listing.squareFootage > 0 ? '$' + (listing.price / listing.squareFootage).toFixed(0) + '/sqft' : '';
    const isBest = i === 0 && (listing.dealScore || 0) >= 70;
    const score = listing.dealScore || 0;

    // Deal Pulse badge
    const pulseClass = `deal-pulse-${listing.dealPulse || 'cold'}`;
    const pulseLabel = (listing.dealPulse || 'cold').charAt(0).toUpperCase() + (listing.dealPulse || 'cold').slice(1);

    // Offer timing tag
    const timingMap = { now: ['Offer Now', 'deal-tag-now'], wait: ['Wait for Drop', 'deal-tag-wait'], watch: ['Watch', 'deal-tag-watch'] };
    const [timingLabel, timingClass] = timingMap[listing.offerTiming] || timingMap.watch;

    // Market position tag
    const posMap = { underpriced: ['Underpriced', 'deal-tag-under'], overpriced: ['Overpriced', 'deal-tag-over'], fair: ['Fair Value', 'deal-tag-fair'] };
    const [posLabel, posClass] = posMap[listing.marketPosition] || posMap.fair;

    const card = document.createElement('div');
    card.className = `scan-card${isBest ? ' best-deal' : ''}`;
    card.innerHTML = `
      <div class="scan-info">
        <div class="scan-address">${listing.formattedAddress || listing.addressLine1 || '--'}</div>
        <div class="scan-meta">
          <span>${listing.bedrooms || '--'} bd</span>
          <span>${listing.bathrooms || '--'} ba</span>
          <span>${fmt(listing.squareFootage)} sqft</span>
          <span>${listing.propertyType || '--'}</span>
          ${listing.daysOnMarket != null ? `<span>${listing.daysOnMarket} days</span>` : ''}
        </div>
        <div class="scan-deal-extras">
          <span class="deal-tag ${timingClass}">${timingLabel}</span>
          <span class="deal-tag ${posClass}">${posLabel}</span>
          ${listing.biddingWarProb > 50 ? '<span class="deal-tag deal-tag-bidding">Likely Bidding War</span>' : listing.biddingWarProb > 25 ? '<span class="deal-tag deal-tag-bidding-possible">Possible Bidding War</span>' : ''}
          ${listing.daysToSellEstimate ? `<span class="deal-tag deal-tag-dts">~${listing.daysToSellEstimate}d to sell</span>` : ''}
          ${listing.priceDropProbability > 25 ? `<span class="price-drop-prob">Price drop: <span class="prob-value">${listing.priceDropProbability}%</span></span>` : ''}
          ${listing.priceHistory?.hasDropped ? `<span class="price-history-tag">&#8595; $${(listing.priceHistory.totalDrop / 1000).toFixed(0)}K (-${listing.priceHistory.totalDropPercent}%)</span>` : ''}
        </div>
      </div>
      <div class="scan-pricing">
        <div class="scan-price">${fmtCurrency(listing.price)}</div>
        <div class="scan-ppsf">${ppsf}</div>
        <span class="deal-pulse-badge ${pulseClass}">${pulseLabel}</span>
        <div class="deal-score" style="font-size:0.75rem;color:var(--text-dim);margin-top:2px;">Score: ${score}/100</div>
      </div>
    `;
    list.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// MAP TAB
// ---------------------------------------------------------------------------
function initMap() {
  // Initialize map centered on US
  state.mainMap = L.map('main-map').setView([39.8283, -98.5795], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.mainMap);

  state.mainMapMarkers = L.markerClusterGroup();
  state.mainMap.addLayer(state.mainMapMarkers);

  $('map-search-btn').addEventListener('click', () => mapSearch());
  $('map-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') mapSearch();
  });
  $('map-find-similar').addEventListener('click', () => findSimilarHomes());
  $('close-sidebar').addEventListener('click', () => hide('map-sidebar'));
}

async function mapSearch() {
  const q = $('map-search-input').value.trim();
  if (!q) return;

  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!data.length) {
      toast('Address not found', 'error');
      return;
    }

    const loc = data[0];
    const lat = parseFloat(loc.lat);
    const lon = parseFloat(loc.lon);
    state.mainMap.setView([lat, lon], 15);
    state.mapCenter = { lat, lon, address: loc.display_name };

    // Add center marker
    state.mainMapMarkers.clearLayers();
    const icon = L.divIcon({
      className: 'custom-marker subject',
      html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3L12 2z"/></svg>',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
    L.marker([lat, lon], { icon })
      .addTo(state.mainMapMarkers)
      .bindPopup(`<div class="popup-title">${loc.display_name}</div>`)
      .openPopup();

    // Draw radius circle
    const radiusMiles = parseFloat($('map-radius').value);
    const radiusMeters = radiusMiles * 1609.34;
    L.circle([lat, lon], {
      radius: radiusMeters,
      color: '#5b8df9',
      fillColor: '#5b8df9',
      fillOpacity: 0.08,
      weight: 2,
    }).addTo(state.mainMapMarkers);

    $('map-find-similar').disabled = false;
    toast('Address found! Click "Find Similar Homes" to scan nearby.', 'success');
  } catch (err) {
    toast('Geocoding failed: ' + err.message, 'error');
  }
}

async function findSimilarHomes() {
  if (!state.mapCenter) return;

  $('map-find-similar').disabled = true;
  $('map-find-similar').textContent = 'Searching...';

  let listings;

  // Reverse geocode to get location info
  let locParts = { city: 'Nearby', state: '', zip: '' };
  try {
    const revRes = await fetch(`/api/reverse-geocode?lat=${state.mapCenter.lat}&lon=${state.mapCenter.lon}`);
    const revData = await revRes.json();
    locParts.city = revData.address?.city || revData.address?.town || 'Nearby';
    locParts.state = revData.address?.state || '';
    locParts.zip = revData.address?.postcode || '';
  } catch { /* ignore */ }

  if (state.demoMode && !state.apiLive) {
    await new Promise((r) => setTimeout(r, 600));
    listings = getDemoListings(state.mapCenter.lat, state.mapCenter.lon, locParts);
    toast('Server offline — showing demo data', 'info');
  } else {
    try {
      const location = locParts.zip || `${locParts.city}, ${locParts.state}`;
      if (!location || location === ', ') {
        toast('Could not determine location for this area', 'error');
        $('map-find-similar').disabled = false;
        $('map-find-similar').textContent = 'Find Similar Homes';
        return;
      }

      const res = await fetch(`/api/listings-lookup?location=${encodeURIComponent(location)}&zipCode=${locParts.zip}`);
      const data = await res.json();
      if (data.error) {
        // No API keys — fall back to demo
        listings = getDemoListings(state.mapCenter.lat, state.mapCenter.lon, locParts);
        toast('No API keys configured — showing demo data', 'info');
      } else {
        listings = (data.listings || []).map(l => ({
          formattedAddress: l.formattedAddress || l.address || l.addressLine1 || '--',
          price: l.price || l.unformattedPrice || 0,
          squareFootage: l.squareFootage || l.area || 0,
          bedrooms: l.bedrooms || l.beds,
          bathrooms: l.bathrooms || l.baths,
          propertyType: l.propertyType,
          daysOnMarket: l.daysOnMarket || l.daysOnZillow,
          latitude: l.latitude,
          longitude: l.longitude,
        }));
        const cached = data.cached ? ' (cached)' : '';
        toast(`${listings.length} nearby properties from ${data.source}${cached}`, 'success');
      }
    } catch (err) {
      // Network error — fall back to demo
      listings = getDemoListings(state.mapCenter.lat, state.mapCenter.lon, locParts);
      toast('Could not reach server — showing demo data', 'info');
    }
  }

  // Add markers for each listing
  const compIcon = L.divIcon({
    className: 'custom-marker comp',
    html: '$',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  listings.forEach((listing) => {
    if (!listing.latitude || !listing.longitude) return;
    L.marker([listing.latitude, listing.longitude], { icon: compIcon })
      .addTo(state.mainMapMarkers)
      .bindPopup(
        `<div class="popup-title">${listing.formattedAddress || listing.addressLine1 || '--'}</div>
         <div class="popup-price">${fmtCurrency(listing.price)}</div>
         <div class="popup-details">
           ${listing.bedrooms || '--'} bd | ${listing.bathrooms || '--'} ba | ${fmt(listing.squareFootage)} sqft
           ${listing.daysOnMarket != null ? `<br>${listing.daysOnMarket} days on market` : ''}
         </div>`
      );
  });

  // Show sidebar
  renderMapSidebar(listings);
  show('map-sidebar');

  $('map-find-similar').disabled = false;
  $('map-find-similar').textContent = 'Find Similar Homes';
}

function renderMapSidebar(listings) {
  const container = $('sidebar-content');
  container.innerHTML = '';

  if (!listings.length) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:20px;">No nearby listings found.</p>';
    return;
  }

  // Analytics summary
  const withPrice = listings.filter((l) => l.price > 0);
  const avgPrice = withPrice.reduce((s, l) => s + l.price, 0) / (withPrice.length || 1);
  const summary = document.createElement('div');
  summary.style.cssText =
    'padding:12px;background:var(--bg-input);border-radius:8px;margin-bottom:12px;text-align:center;';
  summary.innerHTML = `
    <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">
      ${listings.length} properties | Avg ${fmtCurrency(avgPrice)}
    </div>
  `;
  container.appendChild(summary);

  listings.forEach((listing) => {
    const el = document.createElement('div');
    el.className = 'sidebar-property';
    el.innerHTML = `
      <div class="sp-address">${listing.formattedAddress || listing.addressLine1 || '--'}</div>
      <div class="sp-price">${fmtCurrency(listing.price)}</div>
      <div class="sp-details">
        ${listing.bedrooms || '--'} bd | ${listing.bathrooms || '--'} ba | ${fmt(listing.squareFootage)} sqft
        ${listing.propertyType ? ' | ' + listing.propertyType : ''}
      </div>
    `;
    el.addEventListener('click', () => {
      if (listing.latitude && listing.longitude) {
        state.mainMap.setView([listing.latitude, listing.longitude], 17);
      }
    });
    container.appendChild(el);
  });
}

// ---------------------------------------------------------------------------
// HEATMAP OVERLAY (Census Tract Data)
// ---------------------------------------------------------------------------
function initHeatmap() {
  const toggle = $('heatmap-enabled');
  const metricSelect = $('heatmap-metric');

  toggle.addEventListener('change', () => {
    state.heatEnabled = toggle.checked;
    if (state.heatEnabled) {
      loadHeatmapData();
    } else {
      removeHeatLayer();
    }
  });

  metricSelect.addEventListener('change', () => {
    state.heatMetric = metricSelect.value;
    if (state.heatEnabled) {
      loadHeatmapData();
    }
  });

  // Auto-refresh on map move (debounced)
  const debouncedLoad = debounce(() => {
    if (state.heatEnabled && state.mainMap) {
      loadHeatmapData();
    }
  }, 800);

  // Attach map moveend listener once mainMap exists
  const waitForMap = setInterval(() => {
    if (state.mainMap) {
      clearInterval(waitForMap);
      state.mainMap.on('moveend', debouncedLoad);
    }
  }, 200);
}

async function loadHeatmapData() {
  if (!state.mainMap) return;

  const center = state.mainMap.getCenter();
  const bounds = state.mainMap.getBounds();
  // Approximate radius in miles from map bounds
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const latDiff = Math.abs(ne.lat - sw.lat);
  const radiusMiles = Math.max(1, Math.min(15, Math.round(latDiff * 69 / 2)));

  const statsEl = $('heatmap-stats');
  statsEl.textContent = 'Loading...';

  try {
    const res = await fetch(
      `/api/heatmap?lat=${center.lat.toFixed(4)}&lon=${center.lng.toFixed(4)}&radius=${radiusMiles}&metric=${state.heatMetric}`
    );
    const data = await res.json();

    if (data.points && data.points.length > 0) {
      renderHeatLayer(data.points);
      updateHeatLegend(data.stats, data.metric, data.demo);
    } else {
      removeHeatLayer();
      statsEl.textContent = 'No data for this area';
    }
  } catch (err) {
    // Fallback to demo data
    const demoData = getDemoHeatmapClient(center.lat, center.lng);
    renderHeatLayer(demoData.points);
    updateHeatLegend(demoData.stats, state.heatMetric, true);
  }
}

function renderHeatLayer(points) {
  removeHeatLayer();
  if (!state.mainMap || !points.length) return;

  state.heatLayer = L.heatLayer(points, {
    radius: 30,
    blur: 20,
    maxZoom: 15,
    minOpacity: 0.3,
    gradient: {
      0.0: '#3b82f6',
      0.3: '#34d399',
      0.6: '#fbbf24',
      1.0: '#f87171',
    },
  }).addTo(state.mainMap);
}

function removeHeatLayer() {
  if (state.heatLayer && state.mainMap) {
    state.mainMap.removeLayer(state.heatLayer);
    state.heatLayer = null;
  }
  const statsEl = $('heatmap-stats');
  if (statsEl) statsEl.textContent = '';
}

function updateHeatLegend(stats, metric, isDemo) {
  const statsEl = $('heatmap-stats');
  if (!stats) {
    statsEl.textContent = '';
    return;
  }

  const metricLabels = {
    'home-value': { label: 'Median Home Value', fmt: fmtCurrency },
    'affordability': { label: 'Income/Price Ratio', fmt: (v) => v.toFixed(3) },
    'momentum': { label: 'Momentum Score', fmt: (v) => Math.round(v) + '/100' },
    'density': { label: 'Population', fmt: fmt },
  };

  const m = metricLabels[metric] || metricLabels['home-value'];
  const demoTag = isDemo ? ' (demo)' : '';
  statsEl.innerHTML = `
    <span class="heatmap-stat-label">${m.label}${demoTag}</span>
    <span class="heatmap-stat-range">${m.fmt(stats.min)} — ${m.fmt(stats.max)}</span>
  `;
}

/** Client-side demo heatmap fallback. */
function getDemoHeatmapClient(lat, lon) {
  const points = [];
  for (let i = 0; i < 30; i++) {
    const angle = (i / 30) * Math.PI * 2;
    const dist = 0.005 + Math.random() * 0.02;
    const pLat = lat + Math.cos(angle) * dist + (Math.random() - 0.5) * 0.008;
    const pLon = lon + Math.sin(angle) * dist + (Math.random() - 0.5) * 0.008;
    points.push([pLat, pLon, +(0.15 + Math.random() * 0.85).toFixed(3)]);
  }
  return { points, stats: { min: 0.15, max: 1.0, avg: 0.55 } };
}

// ---------------------------------------------------------------------------
// ANALYTICS TAB
// ---------------------------------------------------------------------------
function initAnalytics() {
  $('analytics-btn').addEventListener('click', () =>
    performAnalytics($('analytics-zip').value.trim())
  );
  $('analytics-zip').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performAnalytics($('analytics-zip').value.trim());
  });
}

async function performAnalytics(zip) {
  if (!zip || zip.length < 5) {
    toast('Enter a valid 5-digit zip code', 'error');
    return;
  }

  hide('analytics-results');
  hide('analytics-empty');
  show('analytics-loading');

  let marketData;
  if (state.demoMode && !state.apiLive) {
    await new Promise((r) => setTimeout(r, 600));
    marketData = getDemoMarket();
    toast('Server offline — showing demo data', 'info');
  } else {
    try {
      const res = await fetch(`/api/rentcast/market?zipCode=${zip}`);
      const data = await res.json();
      if (data.error) {
        // RentCast not configured — fall back to demo
        if (data.demo) {
          marketData = getDemoMarket();
          toast('Market analytics requires RentCast API key — showing demo data', 'info');
        } else {
          throw new Error(data.error);
        }
      } else {
        marketData = Array.isArray(data) ? data[0] : data;
        toast('Market data from RentCast', 'success');
      }
    } catch (err) {
      hide('analytics-loading');
      show('analytics-empty');
      toast(err.message, 'error');
      return;
    }
  }

  renderAnalytics(marketData);
  hide('analytics-loading');
  show('analytics-results');
}

function renderAnalytics(data) {
  const sale = data.saleData || data;
  const rental = data.rentalData || {};

  $('ana-sale-price').textContent = fmtCurrency(sale.medianPrice || sale.averagePrice);
  $('ana-sale-ppsf').textContent = sale.averagePricePerSquareFoot
    ? '$' + sale.averagePricePerSquareFoot.toFixed(0)
    : '--';
  $('ana-sale-inventory').textContent = fmt(sale.totalInventory);
  $('ana-sale-dom').textContent = sale.averageDaysOnMarket
    ? sale.averageDaysOnMarket.toFixed(0) + ' days'
    : '--';
  $('ana-sale-sqft').textContent = fmt(sale.medianSquareFootage);

  $('ana-rent-price').textContent = fmtCurrency(rental.medianRent || rental.averageRent);
  $('ana-rent-ppsf').textContent = rental.averageRentPerSquareFoot
    ? '$' + rental.averageRentPerSquareFoot.toFixed(2)
    : '--';
  $('ana-rent-inventory').textContent = fmt(rental.totalInventory);
  $('ana-rent-dom').textContent = rental.averageDaysOnMarket
    ? rental.averageDaysOnMarket.toFixed(0) + ' days'
    : '--';

  // Gross yield
  const salePrice = sale.medianPrice || sale.averagePrice || 0;
  const rentPrice = (rental.medianRent || rental.averageRent || 0) * 12;
  if (salePrice > 0 && rentPrice > 0) {
    $('ana-gross-yield').textContent = fmtPct(rentPrice / salePrice);
  }

  // Chart
  renderTrendChart(data.history || []);
}

function renderTrendChart(history) {
  const canvas = $('trend-chart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const width = rect.width - 48;
  const height = 260;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  if (!history.length) {
    ctx.fillStyle = '#8b8fa3';
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No historical data available', width / 2, height / 2);
    return;
  }

  const padding = { top: 30, right: 60, bottom: 40, left: 70 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const prices = history.map((h) => h.medianPrice || h.averagePrice || 0);
  const rents = history.map((h) => h.medianRent || h.averageRent || 0);
  const maxPrice = Math.max(...prices) * 1.05;
  const minPrice = Math.min(...prices) * 0.95;
  const maxRent = Math.max(...rents) * 1.1;
  const minRent = Math.min(...rents) * 0.9;

  function xPos(i) {
    return padding.left + (i / (history.length - 1)) * chartW;
  }
  function yPrice(v) {
    return padding.top + (1 - (v - minPrice) / (maxPrice - minPrice)) * chartH;
  }
  function yRent(v) {
    return padding.top + (1 - (v - minRent) / (maxRent - minRent)) * chartH;
  }

  // Grid
  ctx.strokeStyle = '#2e3140';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    // Price labels (left)
    const pVal = maxPrice - (i / 4) * (maxPrice - minPrice);
    ctx.fillStyle = '#5b8df9';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmtCurrency(pVal), padding.left - 8, y + 4);

    // Rent labels (right)
    const rVal = maxRent - (i / 4) * (maxRent - minRent);
    ctx.fillStyle = '#34d399';
    ctx.textAlign = 'left';
    ctx.fillText(fmtCurrency(rVal), width - padding.right + 8, y + 4);
  }

  // X labels
  ctx.fillStyle = '#8b8fa3';
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'center';
  history.forEach((h, i) => {
    if (i % 2 === 0 || i === history.length - 1) {
      const label = h.month || `M${i + 1}`;
      ctx.fillText(label, xPos(i), height - 8);
    }
  });

  // Price line (blue)
  ctx.strokeStyle = '#5b8df9';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = xPos(i);
    const y = yPrice(p);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Price fill
  ctx.fillStyle = 'rgba(91,141,249,0.08)';
  ctx.beginPath();
  ctx.moveTo(xPos(0), yPrice(prices[0]));
  prices.forEach((p, i) => ctx.lineTo(xPos(i), yPrice(p)));
  ctx.lineTo(xPos(prices.length - 1), padding.top + chartH);
  ctx.lineTo(xPos(0), padding.top + chartH);
  ctx.fill();

  // Rent line (green)
  if (rents.some((r) => r > 0)) {
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    rents.forEach((r, i) => {
      const x = xPos(i);
      const y = yRent(r);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // Legend
  ctx.font = '12px Inter, sans-serif';
  ctx.fillStyle = '#5b8df9';
  ctx.fillRect(padding.left, 8, 12, 3);
  ctx.fillText('Sale Price', padding.left + 18, 13);
  ctx.fillStyle = '#34d399';
  ctx.fillRect(padding.left + 100, 8, 12, 3);
  ctx.fillText('Rent', padding.left + 118, 13);

  // Data points
  prices.forEach((p, i) => {
    ctx.fillStyle = '#5b8df9';
    ctx.beginPath();
    ctx.arc(xPos(i), yPrice(p), 3.5, 0, Math.PI * 2);
    ctx.fill();
  });
  rents.forEach((r, i) => {
    if (r > 0) {
      ctx.fillStyle = '#34d399';
      ctx.beginPath();
      ctx.arc(xPos(i), yRent(r), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

// ---------------------------------------------------------------------------
// MOMENTUM TAB
// ---------------------------------------------------------------------------
function initMomentum() {
  $('momentum-btn').addEventListener('click', () => {
    const zip = $('momentum-zip').value.trim();
    const st = $('momentum-state').value.trim();
    performMomentum(zip, st);
  });
  $('momentum-zip').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const zip = $('momentum-zip').value.trim();
      const st = $('momentum-state').value.trim();
      performMomentum(zip, st);
    }
  });
}

async function performMomentum(zipCode, stateAbbr) {
  if (!zipCode || zipCode.length < 5) {
    toast('Enter a valid 5-digit zip code', 'error');
    return;
  }

  hide('momentum-results');
  hide('momentum-empty');
  show('momentum-loading');

  // Geocode zip to get lat/lon for Walk Score
  let lat = null, lon = null;
  try {
    const geoRes = await fetch(`/api/geocode?q=${encodeURIComponent(zipCode)}`);
    const geoData = await geoRes.json();
    if (geoData.length) {
      lat = parseFloat(geoData[0].lat);
      lon = parseFloat(geoData[0].lon);
      // Auto-detect state from Nominatim display_name
      // Format: "78701, Austin, Travis County, Texas, United States"
      if (!stateAbbr) {
        const parts = geoData[0].display_name.split(', ').map(p => p.trim());
        // State is 2nd-from-last (before "United States")
        const statePart = parts[parts.length - 2] || '';
        stateAbbr = stateNameToAbbr(statePart);
      }
    }
  } catch { /* ignore */ }

  try {
    const params = new URLSearchParams({ zipCode });
    if (lat) params.set('lat', lat);
    if (lon) params.set('lon', lon);
    if (stateAbbr) params.set('state', stateAbbr);

    const res = await fetch(`/api/momentum?${params}`);
    const data = await res.json();

    if (data.error) {
      hide('momentum-loading');
      show('momentum-empty');
      toast(data.error, 'error');
      return;
    }

    renderMomentumScore(data);
    hide('momentum-loading');
    show('momentum-results');

    // Fetch Minneapolis crime data if we have coordinates
    if (lat && lon) fetchCrimeNearby(lat, lon);
    else $('crime-nearby-section')?.classList.add('hidden');

    // Show Market Brief button and store zip for it
    state.lastMomentumZip = zipCode;
    const briefBtn = $('market-brief-btn');
    if (briefBtn) briefBtn.classList.remove('hidden');

    const demoNote = data.demo ? ' (demo data)' : '';
    toast(`Momentum score for ${zipCode}${demoNote}`, 'success');
  } catch (err) {
    hide('momentum-loading');
    show('momentum-empty');
    toast(err.message, 'error');
  }
}

function renderMomentumScore(data) {
  const score = data.overallScore || 0;
  const trend = data.trend || 'stable';

  // Animate gauge
  const maxDash = 251.3;
  const dashLen = (score / 100) * maxDash;
  const gaugeFill = $('gauge-fill');
  gaugeFill.style.transition = 'none';
  gaugeFill.setAttribute('stroke-dasharray', `0 ${maxDash}`);
  requestAnimationFrame(() => {
    gaugeFill.style.transition = 'stroke-dasharray 1s ease-out';
    gaugeFill.setAttribute('stroke-dasharray', `${dashLen} ${maxDash}`);
  });

  $('gauge-score').textContent = score;

  let scoreColor = 'var(--yellow)';
  if (score >= 65) scoreColor = 'var(--green)';
  else if (score <= 35) scoreColor = 'var(--red)';
  $('gauge-score').setAttribute('fill', scoreColor);

  // Trend
  const trendArrow = $('trend-arrow');
  const trendLabel = $('trend-label');
  if (trend === 'up') {
    trendArrow.textContent = '\u2191';
    trendArrow.className = 'trend-arrow up';
    trendLabel.textContent = 'Trending Up';
  } else if (trend === 'down') {
    trendArrow.textContent = '\u2193';
    trendArrow.className = 'trend-arrow down';
    trendLabel.textContent = 'Trending Down';
  } else {
    trendArrow.textContent = '\u2192';
    trendArrow.className = 'trend-arrow stable';
    trendLabel.textContent = 'Stable';
  }

  // === Trend Drivers — the agent-ready "why" ===
  const driversEl = $('momentum-drivers');
  if (data.drivers?.length) {
    const driverItems = data.drivers.map(d => {
      const icon = d.direction === 'up' ? '\u2191' : '\u2193';
      const cls = d.direction === 'up' ? 'driver-up' : 'driver-down';
      return `<span class="driver-chip ${cls}">${icon} ${d.name}</span>`;
    }).join('');
    driversEl.innerHTML = `
      <div class="drivers-label">Driven by:</div>
      <div class="drivers-chips">${driverItems}</div>
    `;
    driversEl.classList.remove('hidden');
  } else {
    driversEl.classList.add('hidden');
  }

  // === ZHVI Price History ===
  const zhviEl = $('momentum-zhvi');
  if (data.zhvi?.currentValue) {
    const z = data.zhvi;
    const fmtK = (v) => v ? `$${Math.round(v / 1000)}K` : '--';
    const fmtPct = (v) => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '--';
    const yoyClass = z.yoyChange >= 0 ? 'zhvi-up' : 'zhvi-down';

    zhviEl.innerHTML = `
      <div class="zhvi-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
        Zillow Home Value Index
      </div>
      <div class="zhvi-grid">
        <div class="zhvi-stat">
          <span class="zhvi-value">${fmtK(z.currentValue)}</span>
          <span class="zhvi-label">Current</span>
        </div>
        <div class="zhvi-stat">
          <span class="zhvi-value ${yoyClass}">${fmtPct(z.yoyChange)}</span>
          <span class="zhvi-label">1-Year Change</span>
        </div>
        <div class="zhvi-stat">
          <span class="zhvi-value">${fmtK(z.value1YrAgo)}</span>
          <span class="zhvi-label">1 Year Ago</span>
        </div>
        <div class="zhvi-stat">
          <span class="zhvi-value">${fmtK(z.value3YrAgo)}</span>
          <span class="zhvi-label">3 Years Ago</span>
        </div>
        ${z.value5YrAgo ? `
        <div class="zhvi-stat">
          <span class="zhvi-value">${fmtK(z.value5YrAgo)}</span>
          <span class="zhvi-label">5 Years Ago</span>
        </div>` : ''}
      </div>
    `;
    zhviEl.classList.remove('hidden');
  } else {
    zhviEl.classList.add('hidden');
  }

  // === Prior Snapshot Comparison ===
  const priorEl = $('momentum-prior');
  if (data.priorSnapshot) {
    const diff = score - data.priorSnapshot.score;
    const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
    const diffClass = diff > 0 ? 'prior-up' : diff < 0 ? 'prior-down' : 'prior-same';
    const date = new Date(data.priorSnapshot.date).toLocaleDateString();
    priorEl.innerHTML = `
      <span class="prior-label">vs last check (${date}):</span>
      <span class="prior-diff ${diffClass}">${diffStr} points</span>
      <span class="prior-was">(was ${data.priorSnapshot.score}/100)</span>
    `;
    priorEl.classList.remove('hidden');
  } else {
    priorEl.classList.add('hidden');
  }

  // === Factor cards with trend indicators ===
  const grid = $('factors-grid');
  grid.innerHTML = '';
  (data.factors || []).forEach(factor => {
    const scoreClass = factor.score >= 65 ? 'high' : factor.score >= 40 ? 'mid' : 'low';
    let barColor = 'var(--yellow)';
    if (factor.score >= 65) barColor = 'var(--green)';
    else if (factor.score < 40) barColor = 'var(--red)';

    let trendIcon = '';
    if (factor.trend === 'up') trendIcon = '<span class="factor-trend factor-trend-up">\u2191</span>';
    else if (factor.trend === 'down') trendIcon = '<span class="factor-trend factor-trend-down">\u2193</span>';

    const card = document.createElement('div');
    card.className = 'factor-card';
    card.innerHTML = `
      <div class="factor-header">
        <span class="factor-name">${factor.name} ${trendIcon}</span>
        <span class="factor-score ${scoreClass}">${factor.score}</span>
      </div>
      <div class="factor-bar">
        <div class="factor-bar-fill" style="width: ${factor.score}%; background: ${barColor};"></div>
      </div>
      <div class="factor-detail">${factor.detail || ''}</div>
      <div class="factor-weight">Weight: ${Math.round(factor.weight * 100)}%</div>
    `;
    grid.appendChild(card);
  });

  // === Data sources ===
  const meta = $('momentum-meta');
  const sources = data.dataSources || [];
  if (data.rawData?.census) sources.push('Census ACS');
  if (data.rawData?.censusTrends) sources.push('Census Y-o-Y');
  if (data.rawData?.walkScore) sources.push('Walk Score');
  if (data.rawData?.crime) sources.push('FBI Crime');
  if (data.rawData?.schools) sources.push('GreatSchools');
  if (data.demo) sources.push('Demo Data');
  const uniqueSources = [...new Set(sources)];

  meta.innerHTML = `
    <strong>Data sources:</strong> ${uniqueSources.join(' &middot; ') || 'None'}
    ${data.errors?.length ? `<br><strong>Warnings:</strong> ${data.errors.join('; ')}` : ''}
    <br><em>Trend arrows indicate real year-over-year directional data, not score-based estimates.</em>
  `;
}

// ---------------------------------------------------------------------------
// MULTI-CITY CRIME NEARBY
// ---------------------------------------------------------------------------
async function fetchCrimeNearby(lat, lon) {
  const section = $('crime-nearby-section');
  const content = $('crime-nearby-content');
  if (!section || !content) return;

  try {
    const res = await fetch(`/api/crime/nearby?lat=${lat}&lon=${lon}&radius=0.5`);
    const data = await res.json();

    if (!data.available) {
      section.classList.add('hidden');
      return;
    }

    // Update section header with city name
    const title = $('crime-nearby-title');
    const subtitle = $('crime-nearby-subtitle');
    if (title) title.textContent = `${data.cityName || 'Local'} Crime — Nearby Incidents`;
    if (subtitle) {
      const spatialNote = data.hasSpatialQuery === false ? ' (city-wide, not radius-filtered)' : '';
      subtitle.textContent = `Real-time incident data from ${data.source || 'local police'}${spatialNote}`;
    }

    renderCrimeNearby(data, content);
    section.classList.remove('hidden');
  } catch {
    section.classList.add('hidden');
  }
}

function renderCrimeNearby(data, container) {
  const cats = data.categories || {};
  const total = data.totalCurrent || 0;
  const totalDisplay = data.resultsCapped ? `${total}+` : `${total}`;
  const changePct = data.changePercent;
  const changeClass = changePct > 0 ? 'crime-up' : changePct < 0 ? 'crime-down' : 'crime-flat';
  const changeStr = changePct != null
    ? `${changePct > 0 ? '+' : ''}${changePct}%`
    : 'N/A';
  const changeLabel = changePct != null
    ? `vs ${data.priorYear} (annualized)`
    : data.resultsCapped ? 'YoY unavailable (data capped)' : '';

  const radiusLabel = data.hasSpatialQuery === false ? 'city-wide' : `${data.radiusMiles || 0.5} mi`;

  // Top offenses
  const topHtml = (data.topOffenses || []).map(o =>
    `<div class="crime-offense-row">
      <span class="offense-name">${escapeHtml(o.name)}</span>
      <span class="offense-count">${o.count}</span>
    </div>`
  ).join('');

  // Recent incidents
  const recentHtml = (data.recentIncidents || []).slice(0, 8).map(inc =>
    `<div class="crime-incident">
      <span class="incident-type">${escapeHtml(inc.offense || '--')}</span>
      <span class="incident-date">${inc.date || ''}</span>
      ${inc.neighborhood ? `<span class="incident-hood">${escapeHtml(inc.neighborhood)}</span>` : ''}
    </div>`
  ).join('');

  const cachedNote = data.cached ? ' (cached)' : '';

  container.innerHTML = `
    <div class="crime-overview">
      <div class="crime-stat-card crime-total">
        <div class="crime-big-number">${totalDisplay}</div>
        <div class="crime-stat-label">Incidents in ${data.currentYear} (${radiusLabel})</div>
      </div>
      <div class="crime-stat-card crime-trend">
        <div class="crime-big-number ${changeClass}">${changeStr}</div>
        <div class="crime-stat-label">${changeLabel}</div>
      </div>
      <div class="crime-stat-card">
        <div class="crime-category-bars">
          <div class="cat-row">
            <span class="cat-label">Violent</span>
            <div class="cat-bar"><div class="cat-bar-fill violent" style="width:${total ? Math.round((cats.violent / total) * 100) : 0}%"></div></div>
            <span class="cat-count">${cats.violent || 0}</span>
          </div>
          <div class="cat-row">
            <span class="cat-label">Property</span>
            <div class="cat-bar"><div class="cat-bar-fill property" style="width:${total ? Math.round((cats.property / total) * 100) : 0}%"></div></div>
            <span class="cat-count">${cats.property || 0}</span>
          </div>
          <div class="cat-row">
            <span class="cat-label">Other</span>
            <div class="cat-bar"><div class="cat-bar-fill other" style="width:${total ? Math.round((cats.other / total) * 100) : 0}%"></div></div>
            <span class="cat-count">${cats.other || 0}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="crime-details-grid">
      <div class="crime-detail-card">
        <h4>Top Offenses</h4>
        ${topHtml || '<p class="text-muted">No data</p>'}
      </div>
      <div class="crime-detail-card">
        <h4>Recent Incidents</h4>
        ${recentHtml || '<p class="text-muted">No recent incidents</p>'}
      </div>
    </div>
    <div class="crime-source">Source: ${data.source || 'Local PD'}${cachedNote}</div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// SAVED PROPERTIES (Client Command Center)
// ---------------------------------------------------------------------------
const SAVED_KEY = 'propscout_saved';

async function initSaved() {
  // Load from server API, fall back to localStorage
  try {
    const res = await fetch('/api/saved');
    if (res.ok) {
      const rows = await res.json();
      state.savedProperties = rows.map(r => ({
        id: r.id,
        address: r.address,
        savedAt: r.created_at,
        savedPrice: r.saved_price,
        currentPrice: r.current_price,
        rentEstimate: r.rent_estimate,
        notes: r.notes,
        property: {
          city: r.city, state: r.state, zipCode: r.zip,
          bedrooms: r.bedrooms, bathrooms: r.bathrooms,
          squareFootage: r.sqft, propertyType: r.property_type,
          yearBuilt: r.year_built, imgSrc: r.img_src,
        },
      }));

      // One-time migration: if server is empty but localStorage has data, push to server
      if (!rows.length) {
        try {
          const local = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
          if (local.length) {
            for (const s of local) {
              await fetch('/api/saved', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  address: s.address, city: s.property?.city, state: s.property?.state,
                  zip: s.property?.zipCode, bedrooms: s.property?.bedrooms,
                  bathrooms: s.property?.bathrooms, sqft: s.property?.squareFootage,
                  propertyType: s.property?.propertyType, savedPrice: s.savedPrice,
                  currentPrice: s.currentPrice,
                }),
              });
            }
            // Reload from server
            const res2 = await fetch('/api/saved');
            if (res2.ok) {
              const rows2 = await res2.json();
              state.savedProperties = rows2.map(r => ({
                id: r.id, address: r.address, savedAt: r.created_at,
                savedPrice: r.saved_price, currentPrice: r.current_price,
                rentEstimate: r.rent_estimate, notes: r.notes,
                property: { city: r.city, state: r.state, zipCode: r.zip,
                  bedrooms: r.bedrooms, bathrooms: r.bathrooms,
                  squareFootage: r.sqft, propertyType: r.property_type },
              }));
            }
            toast(`Migrated ${local.length} saved properties to server`, 'success');
          }
        } catch { /* migration failed, not critical */ }
      }
    } else {
      throw new Error('API unavailable');
    }
  } catch {
    // Fallback to localStorage
    try {
      state.savedProperties = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    } catch { state.savedProperties = []; }
  }
  updateSavedCount();

  // Drawer toggle
  $('saved-toggle').addEventListener('click', () => {
    const drawer = $('saved-drawer');
    const backdrop = $('drawer-backdrop');
    if (drawer.classList.contains('hidden')) {
      drawer.classList.remove('hidden');
      backdrop.classList.remove('hidden');
      renderSavedDrawer();
    } else {
      drawer.classList.add('hidden');
      backdrop.classList.add('hidden');
    }
  });

  $('close-drawer').addEventListener('click', () => {
    $('saved-drawer').classList.add('hidden');
    $('drawer-backdrop').classList.add('hidden');
  });
  $('drawer-backdrop').addEventListener('click', () => {
    $('saved-drawer').classList.add('hidden');
    $('drawer-backdrop').classList.add('hidden');
  });

  $('refresh-saved').addEventListener('click', refreshSavedValues);
  $('share-saved').addEventListener('click', generateShareLink);

  // Check for legacy shared properties in URL
  loadSharedProperties();
}

function updateSavedCount() {
  const countEl = $('saved-count');
  const count = state.savedProperties.length;
  countEl.textContent = count;
  countEl.className = count > 0 ? 'saved-count' : 'saved-count empty';
}

function saveToDisk() {
  // Keep localStorage as offline backup
  localStorage.setItem(SAVED_KEY, JSON.stringify(state.savedProperties));
  updateSavedCount();
}

async function toggleSaveProperty(property, valuation) {
  const address = property.addressLine1 || property.formattedAddress || '';
  if (!address) return;

  const idx = state.savedProperties.findIndex(s => s.address === address);
  if (idx >= 0) {
    // Unsave — delete from server
    const saved = state.savedProperties[idx];
    if (saved.id) {
      try { await fetch(`/api/saved/${saved.id}`, { method: 'DELETE' }); } catch {}
    }
    state.savedProperties.splice(idx, 1);
    toast('Property removed from saved', 'info');
  } else {
    // Save — post to server
    const price = valuation?.price || property.lastSalePrice || property.price || null;
    const rentEstimate = valuation?.rentEstimate || null;
    const body = {
      address,
      city: property.city, state: property.state, zip: property.zipCode,
      bedrooms: property.bedrooms, bathrooms: property.bathrooms,
      sqft: property.squareFootage, propertyType: property.propertyType,
      yearBuilt: property.yearBuilt, savedPrice: price, currentPrice: price,
      rentEstimate, latitude: property.latitude, longitude: property.longitude,
      imgSrc: property.imgSrc || null,
    };

    let serverId = null;
    try {
      const res = await fetch('/api/saved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      serverId = data.id;
    } catch { /* save locally if server fails */ }

    state.savedProperties.push({
      id: serverId,
      address,
      savedAt: new Date().toISOString(),
      savedPrice: price,
      currentPrice: price,
      rentEstimate,
      property: {
        city: property.city, state: property.state, zipCode: property.zipCode,
        bedrooms: property.bedrooms, bathrooms: property.bathrooms,
        squareFootage: property.squareFootage, propertyType: property.propertyType,
        yearBuilt: property.yearBuilt, imgSrc: property.imgSrc,
      },
    });
    toast('Property saved!', 'success');
  }

  saveToDisk();
  if (state.lastSearchProperty) {
    renderSearchResults(state.lastSearchProperty, state.lastSearchValuation);
  }
}

function renderSavedDrawer() {
  const list = $('saved-list');
  const empty = $('saved-empty');

  if (!state.savedProperties.length) {
    list.innerHTML = '';
    show(empty);
    return;
  }
  hide(empty);

  // Portfolio summary card
  list.innerHTML = '';
  if (state.savedProperties.length >= 2) {
    const totalValue = state.savedProperties.reduce((s, p) => s + (p.currentPrice || p.savedPrice || 0), 0);
    const totalRent = state.savedProperties.reduce((s, p) => s + (p.property?.rentEstimate || p.rentEstimate || 0), 0);
    const avgCap = totalRent && totalValue ? ((totalRent * 12) / totalValue * 100) : 0;
    const zips = [...new Set(state.savedProperties.map(p => p.zip).filter(Boolean))];

    const summary = document.createElement('div');
    summary.className = 'saved-property';
    summary.style.borderColor = 'var(--accent)';
    summary.style.background = 'rgba(91,141,249,0.04)';
    summary.innerHTML = `
      <div style="font-weight:700;font-size:0.9rem;margin-bottom:8px;color:var(--accent)">Portfolio Summary</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.8rem">
        <div><span style="color:var(--text-muted)">Properties:</span> <strong>${state.savedProperties.length}</strong></div>
        <div><span style="color:var(--text-muted)">Total Value:</span> <strong>${fmtCurrency(totalValue)}</strong></div>
        ${totalRent ? `<div><span style="color:var(--text-muted)">Monthly Rent:</span> <strong>${fmtCurrency(totalRent)}</strong></div>` : ''}
        ${avgCap ? `<div><span style="color:var(--text-muted)">Avg Cap Rate:</span> <strong>${avgCap.toFixed(1)}%</strong></div>` : ''}
        <div style="grid-column:span 2"><span style="color:var(--text-muted)">Zip Codes:</span> ${zips.join(', ') || 'N/A'}</div>
      </div>
      <button class="btn-ai" style="margin-top:12px;width:100%;justify-content:center" id="portfolio-ai-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M12 6v6l4 2"/></svg>
        Portfolio AI Advisor
      </button>
    `;
    list.appendChild(summary);
    summary.querySelector('#portfolio-ai-btn').addEventListener('click', requestPortfolioAdvisor);
  }

  state.savedProperties.forEach((saved, i) => {
    const el = document.createElement('div');
    el.className = 'saved-property';

    const changeAmt = saved.currentPrice && saved.savedPrice
      ? saved.currentPrice - saved.savedPrice : 0;
    let changeClass = 'same', changeText = 'No change';
    if (changeAmt > 0) {
      changeClass = 'up';
      changeText = '+' + fmtCurrency(changeAmt);
    } else if (changeAmt < 0) {
      changeClass = 'down';
      changeText = '-' + fmtCurrency(Math.abs(changeAmt));
    }

    const prop = saved.property || {};
    const details = [
      prop.bedrooms ? prop.bedrooms + ' bd' : null,
      prop.bathrooms ? prop.bathrooms + ' ba' : null,
      prop.squareFootage ? fmt(prop.squareFootage) + ' sqft' : null,
    ].filter(Boolean).join(' | ');

    el.innerHTML = `
      <button class="sp-remove" data-idx="${i}" title="Remove">&times;</button>
      <div class="sp-address">${saved.address}</div>
      <div class="sp-saved-date">Saved ${new Date(saved.savedAt).toLocaleDateString()}</div>
      ${details ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">${details}</div>` : ''}
      <div class="sp-prices">
        <span class="sp-saved-price">Saved at: ${fmtCurrency(saved.savedPrice)}</span>
        <span class="sp-current-price">${fmtCurrency(saved.currentPrice)}</span>
        <span class="sp-change ${changeClass}">${changeText}</span>
      </div>
      ${saved.notes ? `<div class="sp-notes">${saved.notes}</div>` : ''}
      <div class="sp-actions">
        <button class="sp-calc-btn" data-idx="${i}" title="Investment Calculator">Calculator</button>
        ${saved.id ? `<button class="sp-report-btn" data-id="${saved.id}" title="Generate PDF Report">Report</button>` : ''}
        <button class="btn-ai sp-verdict-btn" data-address="${saved.address}" data-id="${saved.id || ''}" title="AI Property Verdict">AI Verdict</button>
      </div>
    `;
    list.appendChild(el);
  });

  // Remove buttons
  list.querySelectorAll('.sp-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const saved = state.savedProperties[idx];
      if (saved.id) {
        try { await fetch(`/api/saved/${saved.id}`, { method: 'DELETE' }); } catch {}
      }
      state.savedProperties.splice(idx, 1);
      saveToDisk();
      renderSavedDrawer();
      toast('Property removed', 'info');
    });
  });

  // Calculator buttons
  list.querySelectorAll('.sp-calc-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      openCalculator(state.savedProperties[idx]);
    });
  });

  // Report buttons
  list.querySelectorAll('.sp-report-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      generatePropertyReport(e.target.dataset.id);
    });
  });

  // AI Verdict buttons
  list.querySelectorAll('.sp-verdict-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      requestAIVerdict(e.target.dataset.address, e.target.dataset.id || null);
    });
  });
}

async function refreshSavedValues() {
  if (!state.savedProperties.length) return;
  toast('Refreshing saved property values...', 'info');

  try {
    const res = await fetch('/api/saved/refresh', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      // Reload state from server response
      state.savedProperties = data.properties.map(r => ({
        id: r.id, address: r.address, savedAt: r.created_at,
        savedPrice: r.saved_price, currentPrice: r.current_price,
        rentEstimate: r.rent_estimate, notes: r.notes,
        property: { city: r.city, state: r.state, zipCode: r.zip,
          bedrooms: r.bedrooms, bathrooms: r.bathrooms,
          squareFootage: r.sqft, propertyType: r.property_type },
      }));
      saveToDisk();
      renderSavedDrawer();
      toast(`Updated ${data.updated}/${data.total} property values`, 'success');
      return;
    }
  } catch { /* fallback below */ }

  // Fallback: individual lookups
  let updated = 0;
  for (const saved of state.savedProperties) {
    try {
      const res = await fetch(`/api/property-lookup?address=${encodeURIComponent(saved.address)}`);
      const data = await res.json();
      if (!data.error && data.property) {
        const newPrice = data.property.zestimate || data.property.price || data.valuation?.price;
        if (newPrice) { saved.currentPrice = newPrice; updated++; }
      }
    } catch { /* skip */ }
  }
  saveToDisk();
  renderSavedDrawer();
  toast(`Updated ${updated}/${state.savedProperties.length} property values`, 'success');
}

async function generateShareLink() {
  if (!state.savedProperties.length) {
    toast('No saved properties to share', 'error');
    return;
  }

  // Create portfolio on server
  const propertyIds = state.savedProperties.filter(s => s.id).map(s => s.id);
  if (propertyIds.length) {
    try {
      const res = await fetch('/api/portfolios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Property Portfolio',
          description: `${propertyIds.length} curated properties`,
          propertyIds,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const url = `${window.location.origin}${data.url}`;
        navigator.clipboard.writeText(url).then(() => {
          toast('Portfolio link copied to clipboard!', 'success');
        }).catch(() => {
          prompt('Copy this portfolio link:', url);
        });
        return;
      }
    } catch { /* fallback to legacy */ }
  }

  // Legacy fallback: base64-encoded URL
  const minimal = state.savedProperties.map(s => ({
    a: s.address, p: s.currentPrice,
    b: s.property?.bedrooms, ba: s.property?.bathrooms, sf: s.property?.squareFootage,
  }));
  const encoded = btoa(JSON.stringify(minimal));
  const url = `${window.location.origin}${window.location.pathname}?shared=${encoded}`;
  navigator.clipboard.writeText(url).then(() => {
    toast('Share link copied to clipboard!', 'success');
  }).catch(() => { prompt('Copy this share link:', url); });
}

function loadSharedProperties() {
  const params = new URLSearchParams(window.location.search);
  const shared = params.get('shared');
  if (!shared) return;

  try {
    const data = JSON.parse(atob(shared));
    if (!Array.isArray(data) || !data.length) return;
    toast(`Viewing ${data.length} shared properties`, 'info');

    if (!state.savedProperties.length) {
      data.forEach(item => {
        state.savedProperties.push({
          address: item.a, savedAt: new Date().toISOString(),
          savedPrice: item.p, currentPrice: item.p,
          property: { bedrooms: item.b, bathrooms: item.ba, squareFootage: item.sf },
        });
      });
      saveToDisk();
    }
    window.history.replaceState({}, '', window.location.pathname);
  } catch { /* invalid share link */ }
}

// ===========================================================================
// INVESTMENT CALCULATOR — mortgage + ROI analysis modal
// ===========================================================================

function openCalculator(saved) {
  const modal = $('calc-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  // Populate inputs from saved property
  const price = saved.currentPrice || saved.savedPrice || 0;
  const rent = saved.rentEstimate || Math.round(price * 0.007); // rough 0.7% rule estimate
  $('calc-price').value = price;
  $('calc-rent').value = rent;
  $('calc-down').value = 20;
  $('calc-rate').value = 6.5;
  $('calc-term').value = 30;
  $('calc-expenses').value = 40;
  $('calc-address').textContent = saved.address || 'Property';

  calculateInvestment();
}

function calculateInvestment() {
  const price = parseFloat($('calc-price').value) || 0;
  const downPct = parseFloat($('calc-down').value) || 20;
  const rate = parseFloat($('calc-rate').value) || 6.5;
  const term = parseInt($('calc-term').value) || 30;
  const rent = parseFloat($('calc-rent').value) || 0;
  const expPct = parseFloat($('calc-expenses').value) || 40;

  const downPayment = price * (downPct / 100);
  const loan = price - downPayment;
  const mr = rate / 100 / 12;
  const n = term * 12;
  let mp = 0;
  if (mr > 0 && n > 0) mp = loan * (mr * Math.pow(1 + mr, n)) / (Math.pow(1 + mr, n) - 1);

  const annualRent = rent * 12;
  const expenses = annualRent * (expPct / 100);
  const noi = annualRent - expenses;
  const annualDebt = mp * 12;
  const cashFlow = noi - annualDebt;

  const capRate = price > 0 ? (noi / price) * 100 : 0;
  const coc = downPayment > 0 ? (cashFlow / downPayment) * 100 : 0;
  const grossYield = price > 0 ? (annualRent / price) * 100 : 0;
  const dscr = annualDebt > 0 ? noi / annualDebt : 0;
  const breakEven = annualRent > 0 ? ((expenses + annualDebt) / annualRent) * 100 : 0;
  const onePercent = price > 0 && rent >= price * 0.01;

  $('calc-monthly-payment').textContent = fmtCurrency(mp);
  $('calc-down-amount').textContent = fmtCurrency(downPayment);
  $('calc-monthly-cashflow').textContent = fmtCurrency(cashFlow / 12);
  $('calc-monthly-cashflow').className = cashFlow >= 0 ? 'calc-value positive' : 'calc-value negative';
  $('calc-annual-cashflow').textContent = fmtCurrency(cashFlow);
  $('calc-annual-cashflow').className = cashFlow >= 0 ? 'calc-value positive' : 'calc-value negative';
  $('calc-cap-rate').textContent = capRate.toFixed(2) + '%';
  $('calc-coc').textContent = coc.toFixed(2) + '%';
  $('calc-coc').className = coc >= 0 ? 'calc-value positive' : 'calc-value negative';
  $('calc-gross-yield').textContent = grossYield.toFixed(2) + '%';
  $('calc-dscr').textContent = dscr.toFixed(2);
  $('calc-dscr').className = dscr >= 1.25 ? 'calc-value positive' : dscr >= 1 ? 'calc-value' : 'calc-value negative';
  $('calc-breakeven').textContent = breakEven.toFixed(1) + '%';
  $('calc-one-percent').textContent = onePercent ? 'PASS' : 'FAIL';
  $('calc-one-percent').className = onePercent ? 'calc-value positive' : 'calc-value negative';
}

function initCalculator() {
  const modal = $('calc-modal');
  if (!modal) return;

  $('calc-close').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  $('calc-print').addEventListener('click', () => window.print());

  // Recalculate on any input change
  ['calc-price', 'calc-rent', 'calc-down', 'calc-rate', 'calc-term', 'calc-expenses'].forEach(id => {
    $(id).addEventListener('input', calculateInvestment);
  });

  // Scenario tabs
  const scenarioTabs = $('scenario-tabs');
  if (scenarioTabs) {
    scenarioTabs.querySelectorAll('.btn-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        scenarioTabs.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderActiveScenario();
      });
    });
  }

  // Run scenarios button
  $('calc-run-scenarios')?.addEventListener('click', runScenarios);
}

let scenarioData = null;

async function runScenarios() {
  const price = parseFloat($('calc-price')?.value) || 0;
  const rent = parseFloat($('calc-rent')?.value) || 0;
  if (!price || !rent) {
    toast('Set purchase price and rent first', 'error');
    return;
  }

  const btn = $('calc-run-scenarios');
  btn.disabled = true;
  btn.textContent = 'Calculating...';

  try {
    const res = await fetch('/api/investment/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        purchasePrice: price,
        monthlyRent: rent,
        downPaymentPct: parseFloat($('calc-down')?.value) || 20,
        interestRate: parseFloat($('calc-rate')?.value) || 6.5,
        loanTermYears: parseFloat($('calc-term')?.value) || 30,
      }),
    });
    if (!res.ok) throw new Error('Failed');
    scenarioData = await res.json();
    renderActiveScenario();
  } catch {
    toast('Failed to run scenarios', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Scenarios';
  }
}

function renderActiveScenario() {
  if (!scenarioData) return;
  const container = $('scenario-projection');
  if (!container) return;

  const activeTab = document.querySelector('#scenario-tabs .btn-toggle.active')?.dataset.scenario || 'moderate';
  const nameMap = { conservative: 'Conservative', moderate: 'Moderate', aggressive: 'Aggressive' };
  const scenario = scenarioData.scenarios.find(s => s.scenario === nameMap[activeTab]);
  if (!scenario) return;

  let html = `<div style="margin-bottom:8px;text-align:left">
    <span style="font-size:0.75rem;color:var(--text-dim)">Assumptions: ${(scenario.assumptions.vacancy*100).toFixed(0)}% vacancy, ${(scenario.assumptions.expenses*100).toFixed(0)}% expenses, ${(scenario.assumptions.appreciation*100).toFixed(1)}% appreciation, ${(scenario.assumptions.rentGrowth*100).toFixed(1)}% rent growth</span>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:0.8rem;text-align:right">
    <thead><tr style="border-bottom:2px solid var(--border)">
      <th style="text-align:left;padding:4px 8px">Year</th>
      <th style="padding:4px 8px">Rent/mo</th>
      <th style="padding:4px 8px">Cash Flow</th>
      <th style="padding:4px 8px">Value</th>
      <th style="padding:4px 8px">Equity</th>
    </tr></thead><tbody>`;

  for (const p of scenario.projections) {
    const cfColor = p.annualCashFlow >= 0 ? 'var(--green)' : 'var(--red)';
    html += `<tr style="border-bottom:1px solid var(--border)">
      <td style="text-align:left;padding:4px 8px">${p.year}</td>
      <td style="padding:4px 8px">${fmtCurrency(p.monthlyRent)}</td>
      <td style="padding:4px 8px;color:${cfColor}">${fmtCurrency(p.annualCashFlow)}</td>
      <td style="padding:4px 8px">${fmtCurrency(p.propertyValue)}</td>
      <td style="padding:4px 8px">${fmtCurrency(p.equity)}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  html += `<div style="margin-top:8px;text-align:left;font-size:0.8rem">
    <span style="color:var(--yellow);font-weight:600">Break-even rent: ${fmtCurrency(scenario.breakEvenRent)}/mo</span>
  </div>`;

  container.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
function initAlerts() {
  const toggle = $('alert-toggle');
  const drawer = $('alert-drawer');
  if (!toggle || !drawer) return;

  toggle.addEventListener('click', toggleAlertDrawer);
  $('close-alert-drawer')?.addEventListener('click', () => hide(drawer));
  $('mark-all-read')?.addEventListener('click', markAllAlertsRead);

  // Poll unread count every 60s
  fetchAlertCount();
  setInterval(fetchAlertCount, 60000);
}

async function fetchAlertCount() {
  try {
    const res = await fetch('/api/alerts/count');
    if (!res.ok) return;
    const data = await res.json();
    state.unreadAlertCount = data.unread || 0;
    updateAlertBadge();
  } catch { /* offline */ }
}

function updateAlertBadge() {
  const badge = $('alert-badge');
  if (!badge) return;
  if (state.unreadAlertCount > 0) {
    badge.textContent = state.unreadAlertCount > 99 ? '99+' : state.unreadAlertCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function toggleAlertDrawer() {
  const drawer = $('alert-drawer');
  if (drawer.classList.contains('hidden')) {
    show(drawer);
    loadAlerts();
  } else {
    hide(drawer);
  }
}

async function loadAlerts() {
  try {
    const res = await fetch('/api/alerts?limit=50');
    if (!res.ok) return;
    state.alerts = await res.json();
    renderAlertDrawer();
  } catch { /* offline */ }
}

function renderAlertDrawer() {
  const list = $('alert-list');
  const empty = $('alert-empty');
  if (!list) return;

  if (!state.alerts.length) {
    list.innerHTML = '';
    show(empty);
    return;
  }
  hide(empty);

  const iconMap = {
    new_listing: { cls: 'new-listing', icon: '🏠' },
    price_drop: { cls: 'price-drop', icon: '📉' },
    price_increase: { cls: 'price-increase', icon: '📈' },
    momentum_change: { cls: 'momentum-change', icon: '📊' },
  };

  list.innerHTML = state.alerts.map(a => {
    const info = iconMap[a.type] || { cls: 'new-listing', icon: '🔔' };
    const data = typeof a.data === 'string' ? JSON.parse(a.data || '{}') : (a.data || {});
    let detail = '';
    if (a.type === 'price_drop') {
      detail = data.oldPrice && data.newPrice
        ? `${fmtCurrency(data.oldPrice)} → ${fmtCurrency(data.newPrice)}`
        : 'Price decreased';
    } else if (a.type === 'price_increase') {
      detail = data.oldPrice && data.newPrice
        ? `${fmtCurrency(data.oldPrice)} → ${fmtCurrency(data.newPrice)}`
        : 'Price increased';
    } else if (a.type === 'new_listing') {
      detail = data.price ? fmtCurrency(data.price) : 'New listing found';
    } else if (a.type === 'momentum_change') {
      detail = data.oldScore != null && data.newScore != null
        ? `Score: ${data.oldScore} → ${data.newScore}`
        : 'Momentum shifted';
    }
    const typeName = a.type.replace(/_/g, ' ');
    return `<div class="alert-item ${a.read ? '' : 'unread'}" data-id="${a.id}">
      <div class="alert-icon ${info.cls}">${info.icon}</div>
      <div class="alert-body">
        <div class="alert-type">${typeName}</div>
        <div class="alert-address">${a.property_address || 'Saved search match'}</div>
        <div class="alert-detail">${detail}</div>
        <div class="alert-time">${formatTimeAgo(a.created_at)}</div>
      </div>
    </div>`;
  }).join('');

  // Mark as read on click
  list.querySelectorAll('.alert-item.unread').forEach(el => {
    el.addEventListener('click', () => markAlertRead(el.dataset.id));
  });
}

async function markAlertRead(id) {
  try {
    await fetch(`/api/alerts/${id}/read`, { method: 'PUT' });
    const alert = state.alerts.find(a => a.id === Number(id));
    if (alert) alert.read = 1;
    state.unreadAlertCount = Math.max(0, state.unreadAlertCount - 1);
    updateAlertBadge();
    const el = document.querySelector(`.alert-item[data-id="${id}"]`);
    if (el) el.classList.remove('unread');
  } catch { /* offline */ }
}

async function markAllAlertsRead() {
  try {
    await fetch('/api/alerts/read-all', { method: 'POST' });
    state.alerts.forEach(a => a.read = 1);
    state.unreadAlertCount = 0;
    updateAlertBadge();
    document.querySelectorAll('.alert-item.unread').forEach(el => el.classList.remove('unread'));
    toast('All alerts marked as read', 'success');
  } catch { /* offline */ }
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z')).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Saved Searches
// ---------------------------------------------------------------------------
function initSavedSearches() {
  const saveBtn = $('save-search-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveCurrentSearch);
  }
  loadSavedSearches();
}

async function loadSavedSearches() {
  try {
    const res = await fetch('/api/saved-searches');
    if (!res.ok) return;
    state.savedSearches = await res.json();
    renderSavedSearches();
  } catch { /* offline */ }
}

function saveCurrentSearch() {
  const city = $('scan-city')?.value.trim() || '';
  const st = $('scan-state')?.value.trim() || '';
  const zip = $('scan-zip')?.value.trim() || '';

  if (!city && !zip) {
    toast('Enter a city or zip code first', 'error');
    return;
  }

  const type = $('scan-type')?.value || '';
  const priceMin = $('scan-price-min')?.value || '';
  const priceMax = $('scan-price-max')?.value || '';
  const beds = document.querySelector('#scan-beds-group .btn-toggle.active')?.dataset.val || '';
  const baths = document.querySelector('#scan-baths-group .btn-toggle.active')?.dataset.val || '';

  const parts = [];
  if (city) parts.push(city);
  if (st) parts.push(st);
  if (zip) parts.push(zip);
  const name = parts.join(', ');

  const filters = { city, state: st, zipCode: zip, type, priceMin, priceMax, beds, baths };

  doSaveSearch(name, filters);
}

async function doSaveSearch(name, filters) {
  try {
    const res = await fetch('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, filters }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'Failed to save search', 'error');
      return;
    }
    toast('Search saved! You\'ll get alerts for new matches.', 'success');
    loadSavedSearches();
  } catch {
    toast('Failed to save search', 'error');
  }
}

function renderSavedSearches() {
  const container = $('saved-searches-list');
  if (!container) return;

  if (!state.savedSearches.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = state.savedSearches.map(ss => {
    const f = typeof ss.filters === 'string' ? JSON.parse(ss.filters) : ss.filters;
    const parts = [];
    if (f.city) parts.push(f.city);
    if (f.state) parts.push(f.state);
    if (f.zipCode) parts.push(f.zipCode);
    if (f.priceMin || f.priceMax) parts.push(`$${f.priceMin || '0'}-$${f.priceMax || '∞'}`);
    const summary = parts.slice(1).join(' · ') || '';

    return `<div class="saved-search-item" data-id="${ss.id}">
      <span class="ss-name">${ss.name}</span>
      <span class="ss-summary">${summary}</span>
      <div class="ss-actions">
        <button class="ss-run" title="Run search" onclick="runSavedSearch(${ss.id})">▶</button>
        <button class="ss-delete" title="Delete" onclick="deleteSavedSearch(${ss.id})">✕</button>
      </div>
    </div>`;
  }).join('');
}

async function runSavedSearch(id) {
  const ss = state.savedSearches.find(s => s.id === id);
  if (!ss) return;

  const f = typeof ss.filters === 'string' ? JSON.parse(ss.filters) : ss.filters;

  // Populate scanner filters
  if ($('scan-city')) $('scan-city').value = f.city || '';
  if ($('scan-state')) $('scan-state').value = f.state || '';
  if ($('scan-zip')) $('scan-zip').value = f.zipCode || '';
  if ($('scan-type')) $('scan-type').value = f.type || '';
  if ($('scan-price-min')) $('scan-price-min').value = f.priceMin || '';
  if ($('scan-price-max')) $('scan-price-max').value = f.priceMax || '';

  // Activate correct bed/bath toggles
  setToggleActive('scan-beds-group', f.beds);
  setToggleActive('scan-baths-group', f.baths);

  // Switch to scanner tab
  document.querySelector('.tab-btn[data-tab="scanner"]')?.click();

  // Run the scan
  performScan();
}

function setToggleActive(groupId, val) {
  const group = $(groupId);
  if (!group) return;
  const btns = group.querySelectorAll('.btn-toggle');
  btns.forEach(b => b.classList.remove('active'));
  if (val) {
    const match = Array.from(btns).find(b => b.dataset.val === val);
    if (match) match.classList.add('active');
    else btns[0]?.classList.add('active');
  } else {
    btns[0]?.classList.add('active');
  }
}

async function deleteSavedSearch(id) {
  try {
    const res = await fetch(`/api/saved-searches/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast('Failed to delete search', 'error');
      return;
    }
    state.savedSearches = state.savedSearches.filter(s => s.id !== id);
    renderSavedSearches();
    toast('Search deleted', 'success');
  } catch {
    toast('Failed to delete search', 'error');
  }
}

// ---------------------------------------------------------------------------
// Agent Settings
// ---------------------------------------------------------------------------
function initAgentSettings() {
  const btn = $('agent-settings-btn');
  const modal = $('agent-modal');
  if (!btn || !modal) return;

  btn.addEventListener('click', openAgentSettings);
  $('agent-modal-close')?.addEventListener('click', () => hide(modal));
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(modal); });
  $('agent-save')?.addEventListener('click', saveAgentProfile);
}

async function openAgentSettings() {
  const modal = $('agent-modal');
  show(modal);
  try {
    const res = await fetch('/api/agent/profile');
    if (res.ok) {
      const p = await res.json();
      $('agent-name').value = p.name || '';
      $('agent-email').value = p.email || '';
      $('agent-phone').value = p.phone || '';
      $('agent-brand-color').value = p.brand_color || '#5b8df9';
      $('agent-tagline').value = p.tagline || '';
    }
  } catch { /* use defaults */ }
}

async function saveAgentProfile() {
  try {
    const res = await fetch('/api/agent/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('agent-name').value.trim(),
        email: $('agent-email').value.trim(),
        phone: $('agent-phone').value.trim(),
        brandColor: $('agent-brand-color').value.trim(),
        tagline: $('agent-tagline').value.trim(),
      }),
    });
    if (res.ok) {
      toast('Profile saved!', 'success');
      hide($('agent-modal'));
    } else {
      toast('Failed to save profile', 'error');
    }
  } catch {
    toast('Failed to save profile', 'error');
  }
}

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------
async function generatePropertyReport(savedId) {
  toast('Generating report...', 'info');
  try {
    const res = await fetch(`/api/reports/property/${savedId}`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'Failed to generate report', 'error');
      return;
    }
    const data = await res.json();
    window.open(`/report.html?id=${data.reportId}`, '_blank');
  } catch {
    toast('Failed to generate report', 'error');
  }
}

// ---------------------------------------------------------------------------
// Compare Neighborhoods
// ---------------------------------------------------------------------------
function initCompare() {
  const btn = $('compare-neighborhoods-btn');
  const modal = $('compare-modal');
  if (!btn || !modal) return;

  btn.addEventListener('click', () => show(modal));
  $('compare-modal-close')?.addEventListener('click', () => hide(modal));
  modal.addEventListener('click', (e) => { if (e.target === modal) hide(modal); });
  $('compare-generate')?.addEventListener('click', generateComparisonReport);
}

async function generateComparisonReport() {
  const input = $('compare-zips')?.value.trim();
  if (!input) {
    toast('Enter at least 2 zip codes', 'error');
    return;
  }
  const zipCodes = input.split(',').map(z => z.trim()).filter(z => /^\d{5}$/.test(z));
  if (zipCodes.length < 2) {
    toast('Enter at least 2 valid 5-digit zip codes', 'error');
    return;
  }

  toast('Generating comparison report...', 'info');
  try {
    const res = await fetch('/api/reports/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zipCodes }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'Failed to generate report', 'error');
      return;
    }
    const data = await res.json();
    hide($('compare-modal'));
    window.open(`/report.html?id=${data.reportId}`, '_blank');
  } catch {
    toast('Failed to generate report', 'error');
  }
}

// ---------------------------------------------------------------------------
// Client CRM
// ---------------------------------------------------------------------------
function initClients() {
  const addBtn = $('add-client-btn');
  const form = $('client-form');
  if (!addBtn || !form) return;

  addBtn.addEventListener('click', () => {
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) $('client-name-input')?.focus();
  });
  $('client-cancel-btn')?.addEventListener('click', () => {
    hide(form);
    clearClientForm();
  });
  $('client-save-btn')?.addEventListener('click', saveClient);

  loadClients();
}

function clearClientForm() {
  if ($('client-name-input')) $('client-name-input').value = '';
  if ($('client-email-input')) $('client-email-input').value = '';
  if ($('client-phone-input')) $('client-phone-input').value = '';
  if ($('client-type-input')) $('client-type-input').value = 'buyer';
}

async function loadClients() {
  try {
    const res = await fetch('/api/clients');
    if (!res.ok) return;
    state.clients = await res.json();
    renderClients();
  } catch { /* offline */ }
}

async function saveClient() {
  const name = $('client-name-input')?.value.trim();
  if (!name) { toast('Enter a client name', 'error'); return; }

  try {
    const res = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        email: $('client-email-input')?.value.trim() || '',
        phone: $('client-phone-input')?.value.trim() || '',
        clientType: $('client-type-input')?.value || 'buyer',
      }),
    });
    if (!res.ok) { toast('Failed to add client', 'error'); return; }
    toast('Client added', 'success');
    hide($('client-form'));
    clearClientForm();
    loadClients();
  } catch { toast('Failed to add client', 'error'); }
}

function renderClients() {
  const list = $('client-list');
  if (!list) return;

  if (!state.clients.length) {
    list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-dim);font-size:0.8rem">No clients yet</div>';
    return;
  }

  list.innerHTML = state.clients.map(c => {
    const initials = c.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    return `<div class="client-card" data-id="${c.id}">
      <div class="client-avatar ${c.client_type}">${initials}</div>
      <div class="client-info">
        <div class="client-name">${c.name}</div>
        <div class="client-meta">${c.email || c.phone || 'No contact info'}</div>
      </div>
      <span class="client-type-badge ${c.client_type}">${c.client_type}</span>
      <div class="client-actions">
        <button class="client-delete" title="Delete" onclick="deleteClient(${c.id})">✕</button>
      </div>
    </div>`;
  }).join('');
}

async function deleteClient(id) {
  try {
    const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' });
    if (!res.ok) { toast('Failed to delete client', 'error'); return; }
    state.clients = state.clients.filter(c => c.id !== id);
    renderClients();
    toast('Client removed', 'success');
  } catch { toast('Failed to delete client', 'error'); }
}

// ===========================================================================
// AI ANALYTICS — NL Search, Verdict, Market Brief, Portfolio Advisor
// ===========================================================================

function initAIAnalytics() {
  // NL Search
  const nlBtn = $('nl-search-btn');
  const nlInput = $('nl-search-input');
  if (nlBtn) nlBtn.addEventListener('click', performNLSearch);
  if (nlInput) nlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') performNLSearch(); });

  // Market Brief
  const briefBtn = $('market-brief-btn');
  if (briefBtn) briefBtn.addEventListener('click', requestMarketBrief);

  // Verdict modal close
  const verdictClose = $('verdict-close');
  if (verdictClose) verdictClose.addEventListener('click', () => hide('verdict-modal'));
  const verdictModal = $('verdict-modal');
  if (verdictModal) verdictModal.addEventListener('click', (e) => { if (e.target === verdictModal) hide('verdict-modal'); });

  // Portfolio AI modal close
  const portfolioClose = $('portfolio-ai-close');
  if (portfolioClose) portfolioClose.addEventListener('click', () => hide('portfolio-ai-modal'));
  const portfolioModal = $('portfolio-ai-modal');
  if (portfolioModal) portfolioModal.addEventListener('click', (e) => { if (e.target === portfolioModal) hide('portfolio-ai-modal'); });
}

// --- Natural Language Search ---
async function performNLSearch() {
  const input = $('nl-search-input');
  const query = input?.value?.trim();
  if (!query) { toast('Type a search query', 'error'); return; }

  toast('Parsing search...', 'info');
  try {
    const res = await fetch('/api/ai/parse-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (data.error) { toast(data.error, 'error'); return; }

    const f = data.filters;
    if (f.city) $('scan-city').value = f.city;
    if (f.state) $('scan-state').value = f.state;
    if (f.zipCode) $('scan-zip').value = f.zipCode;
    if (f.minPrice) $('scan-price-min').value = f.minPrice;
    if (f.maxPrice) $('scan-price-max').value = f.maxPrice;

    // Set bed/bath toggles
    if (f.beds) setToggleActive('scan-beds-group', f.beds);
    if (f.baths) setToggleActive('scan-baths-group', f.baths);

    toast(`Parsed: ${data.interpreted} (${data.source})`, 'success');

    // Auto-trigger scan
    const scanBtn = $('scan-btn');
    if (scanBtn) scanBtn.click();
  } catch (err) {
    toast('Failed to parse search', 'error');
  }
}

function setToggleActive(groupId, val) {
  const group = $(groupId);
  if (!group) return;
  group.querySelectorAll('.btn-toggle').forEach(b => {
    b.classList.remove('active');
    if (b.dataset.val === val || b.textContent.trim() === val) b.classList.add('active');
  });
}

// --- AI Property Verdict ---
async function requestAIVerdict(address, savedPropertyId) {
  if (!address) { toast('No address provided', 'error'); return; }

  $('verdict-body').innerHTML = '<p class="text-muted">Loading AI analysis...</p>';
  show('verdict-modal');

  try {
    const body = { address };
    if (savedPropertyId) body.savedPropertyId = parseInt(savedPropertyId);

    const res = await fetch('/api/ai/verdict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) { $('verdict-body').innerHTML = `<p style="color:var(--red)">${data.error}</p>`; return; }

    renderVerdictModal(data.verdict, data.source, data.cached, address);
  } catch (err) {
    $('verdict-body').innerHTML = `<p style="color:var(--red)">Failed to get verdict: ${err.message}</p>`;
  }
}

function renderVerdictModal(v, source, cached, address) {
  const rec = (v.recommendation || 'HOLD').toUpperCase();
  const recClass = rec === 'BUY' ? 'buy' : rec === 'PASS' ? 'pass' : 'hold';
  const confidence = v.confidence || 'MEDIUM';

  const offerHtml = v.offerRange ? `
    <div class="verdict-offer-range">
      <div><div class="label">Low Offer</div><div class="value">$${Number(v.offerRange.low).toLocaleString()}</div></div>
      <div style="color:var(--text-muted)">—</div>
      <div><div class="label">High Offer</div><div class="value">$${Number(v.offerRange.high).toLocaleString()}</div></div>
    </div>` : '';

  const risksHtml = (v.risks || []).map(r => `<li>${r}</li>`).join('');
  const oppsHtml = (v.opportunities || []).map(o => `<li>${o}</li>`).join('');

  const stratHtml = v.strategy ? `
    <div class="verdict-strategy">
      <div class="strategy-step"><div class="step-label">30 Days</div><div class="step-text">${v.strategy.day30 || ''}</div></div>
      <div class="strategy-step"><div class="step-label">60 Days</div><div class="step-text">${v.strategy.day60 || ''}</div></div>
      <div class="strategy-step"><div class="step-label">90 Days</div><div class="step-text">${v.strategy.day90 || ''}</div></div>
    </div>` : '';

  $('verdict-body').innerHTML = `
    <div style="margin-bottom:8px;font-size:0.85rem;color:var(--text-muted)">${address}</div>
    <span class="verdict-recommendation ${recClass}">${rec}</span>
    <span class="verdict-confidence">Confidence: ${confidence}</span>
    ${offerHtml}
    <div class="verdict-section">
      <h4>Risks</h4>
      <ul class="verdict-list">${risksHtml || '<li>No risks identified</li>'}</ul>
    </div>
    <div class="verdict-section">
      <h4>Opportunities</h4>
      <ul class="verdict-list">${oppsHtml || '<li>No opportunities identified</li>'}</ul>
    </div>
    <div class="verdict-section">
      <h4>Strategy</h4>
      ${stratHtml}
    </div>
    <div class="verdict-source">Source: ${source}${cached ? ' (cached)' : ''}</div>
  `;
}

// --- AI Market Brief ---
async function requestMarketBrief() {
  const zip = state.lastMomentumZip;
  if (!zip) { toast('Run momentum analysis first', 'error'); return; }

  const container = $('market-brief-results');
  container.innerHTML = '<div class="market-brief-card"><p class="text-muted">Loading AI market brief...</p></div>';
  container.classList.remove('hidden');

  try {
    const res = await fetch('/api/ai/market-brief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zipCode: zip }),
    });
    const data = await res.json();
    if (data.error) { container.innerHTML = `<div class="market-brief-card"><p style="color:var(--red)">${data.error}</p></div>`; return; }

    renderMarketBrief(data.brief, data.source, data.cached, zip);
  } catch (err) {
    container.innerHTML = `<div class="market-brief-card"><p style="color:var(--red)">Failed: ${err.message}</p></div>`;
  }
}

function renderMarketBrief(b, source, cached, zip) {
  const outlook = (b.outlook || 'STABLE').toUpperCase();
  const outlookClass = outlook === 'HEATING' ? 'heating' : outlook === 'COOLING' ? 'cooling' : 'stable';
  const km = b.keyMetrics || {};

  const metricsHtml = Object.entries(km).map(([key, val]) => {
    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
    return `<div class="brief-metric"><div class="metric-value">${val || 'N/A'}</div><div class="metric-label">${label}</div></div>`;
  }).join('');

  $('market-brief-results').innerHTML = `
    <div class="market-brief-card">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <span class="brief-outlook ${outlookClass}">${outlook}</span>
        <span style="font-size:0.85rem;color:var(--text-muted)">Market Brief — ${zip}</span>
        <span style="margin-left:auto;font-size:0.75rem;color:var(--text-muted)">Source: ${source}${cached ? ' (cached)' : ''}</span>
      </div>
      <div class="brief-thesis">${b.thesis || ''}</div>
      <div class="brief-metrics">${metricsHtml}</div>
      ${b.bestPropertyType ? `<div class="brief-property-type"><strong>Best Target:</strong> ${b.bestPropertyType}</div>` : ''}
      ${b.forecast ? `<div class="brief-forecast"><strong>6-Month Forecast:</strong> ${b.forecast}</div>` : ''}
    </div>
  `;
}

// --- AI Portfolio Advisor ---
async function requestPortfolioAdvisor() {
  if (state.savedProperties.length < 2) { toast('Need at least 2 saved properties', 'error'); return; }

  $('portfolio-ai-body').innerHTML = '<p class="text-muted">Analyzing portfolio...</p>';
  show('portfolio-ai-modal');

  try {
    const ids = state.savedProperties.map(p => p.id).filter(Boolean);
    const res = await fetch('/api/ai/portfolio-advisor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids.length ? { propertyIds: ids } : {}),
    });
    const data = await res.json();
    if (data.error) { $('portfolio-ai-body').innerHTML = `<p style="color:var(--red)">${data.error}</p>`; return; }

    renderPortfolioAdvisor(data.analysis, data.source, data.cached);
  } catch (err) {
    $('portfolio-ai-body').innerHTML = `<p style="color:var(--red)">Failed: ${err.message}</p>`;
  }
}

function renderPortfolioAdvisor(a, source, cached) {
  const score = a.healthScore || 0;
  const scoreClass = score >= 65 ? 'good' : score >= 40 ? 'fair' : 'poor';

  const recsHtml = (a.recommendations || []).map(r => {
    const action = (r.action || 'HOLD').toUpperCase();
    const badgeClass = action === 'SELL' ? 'sell' : action === 'BUY_MORE' ? 'buy_more' : 'hold';
    return `
      <div class="portfolio-rec">
        <span class="action-badge ${badgeClass}">${action.replace('_', ' ')}</span>
        <div class="rec-text">
          <div class="rec-address">${r.address || ''}</div>
          <div>${r.reason || ''}</div>
        </div>
      </div>`;
  }).join('');

  $('portfolio-ai-body').innerHTML = `
    <div class="portfolio-health">
      <div class="score ${scoreClass}">${score}</div>
      <div class="label">Portfolio Health Score</div>
    </div>
    <div class="portfolio-section">
      <h4>Diversification</h4>
      <p style="font-size:0.9rem;line-height:1.5">${a.diversification || 'N/A'}</p>
    </div>
    <div class="portfolio-section">
      <h4>Risk Exposure</h4>
      <p style="font-size:0.9rem;line-height:1.5">${a.riskExposure || 'N/A'}</p>
    </div>
    <div class="portfolio-section">
      <h4>Recommendations</h4>
      ${recsHtml || '<p style="font-size:0.9rem">No recommendations available</p>'}
    </div>
    ${a.buyNext ? `<div class="portfolio-buynext"><strong>Next Acquisition:</strong> ${a.buyNext}</div>` : ''}
    <div style="font-size:0.75rem;color:var(--text-muted);margin-top:16px;text-align:right">Source: ${source}${cached ? ' (cached)' : ''}</div>
  `;
}
