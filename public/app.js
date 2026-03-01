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
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSearch();
  initScanner();
  initMap();
  initAnalytics();
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
    if (data.apiConfigured) {
      el.className = 'api-status live';
      el.querySelector('.status-text').textContent = 'API Connected';
      state.apiLive = true;
    } else {
      el.className = 'api-status demo';
      el.querySelector('.status-text').textContent = 'Demo Mode';
      state.demoMode = true;
    }
  } catch {
    el.className = 'api-status error';
    el.querySelector('.status-text').textContent = 'Offline';
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
// ---------------------------------------------------------------------------
function getDemoProperty() {
  return {
    addressLine1: '742 Evergreen Terrace',
    city: 'Springfield',
    state: 'IL',
    zipCode: '62704',
    propertyType: 'Single Family',
    bedrooms: 4,
    bathrooms: 2.5,
    squareFootage: 2100,
    lotSize: 8500,
    yearBuilt: 1989,
    lastSaleDate: '2019-06-15',
    lastSalePrice: 285000,
    taxAssessment: 295000,
    latitude: 39.7817,
    longitude: -89.6501,
  };
}

function getDemoValuation() {
  return {
    price: 342000,
    priceRangeLow: 318000,
    priceRangeHigh: 366000,
    pricePerSquareFoot: 162.86,
    rentEstimate: 1850,
    comparables: [
      {
        formattedAddress: '128 Oak Lane, Springfield, IL 62704',
        price: 335000,
        squareFootage: 2050,
        bedrooms: 4,
        bathrooms: 2,
        distance: 0.3,
        propertyType: 'Single Family',
        yearBuilt: 1992,
        latitude: 39.783,
        longitude: -89.652,
      },
      {
        formattedAddress: '456 Maple Dr, Springfield, IL 62704',
        price: 349000,
        squareFootage: 2200,
        bedrooms: 4,
        bathrooms: 2.5,
        distance: 0.5,
        propertyType: 'Single Family',
        yearBuilt: 1985,
        latitude: 39.785,
        longitude: -89.648,
      },
      {
        formattedAddress: '789 Elm St, Springfield, IL 62704',
        price: 328000,
        squareFootage: 1980,
        bedrooms: 3,
        bathrooms: 2,
        distance: 0.7,
        propertyType: 'Single Family',
        yearBuilt: 1990,
        latitude: 39.779,
        longitude: -89.654,
      },
      {
        formattedAddress: '321 Pine Ave, Springfield, IL 62704',
        price: 355000,
        squareFootage: 2300,
        bedrooms: 4,
        bathrooms: 3,
        distance: 0.9,
        propertyType: 'Single Family',
        yearBuilt: 1988,
        latitude: 39.776,
        longitude: -89.645,
      },
      {
        formattedAddress: '654 Birch Ct, Springfield, IL 62704',
        price: 310000,
        squareFootage: 1850,
        bedrooms: 3,
        bathrooms: 2,
        distance: 1.1,
        propertyType: 'Single Family',
        yearBuilt: 1995,
        latitude: 39.788,
        longitude: -89.656,
      },
    ],
  };
}

function getDemoListings() {
  const base = [
    {
      formattedAddress: '100 Main St, Springfield, IL 62704',
      price: 275000, squareFootage: 1800, bedrooms: 3, bathrooms: 2,
      propertyType: 'Single Family', yearBuilt: 1998, daysOnMarket: 12,
      latitude: 39.782, longitude: -89.651, status: 'Active',
    },
    {
      formattedAddress: '222 River Rd, Springfield, IL 62704',
      price: 425000, squareFootage: 2800, bedrooms: 5, bathrooms: 3,
      propertyType: 'Single Family', yearBuilt: 2005, daysOnMarket: 5,
      latitude: 39.786, longitude: -89.643, status: 'Active',
    },
    {
      formattedAddress: '333 College Ave, Springfield, IL 62704',
      price: 195000, squareFootage: 1200, bedrooms: 2, bathrooms: 1,
      propertyType: 'Condo', yearBuilt: 2010, daysOnMarket: 30,
      latitude: 39.778, longitude: -89.649, status: 'Active',
    },
    {
      formattedAddress: '444 Park Blvd, Springfield, IL 62704',
      price: 520000, squareFootage: 3200, bedrooms: 5, bathrooms: 4,
      propertyType: 'Single Family', yearBuilt: 2015, daysOnMarket: 8,
      latitude: 39.790, longitude: -89.640, status: 'Active',
    },
    {
      formattedAddress: '555 Lake View Dr, Springfield, IL 62704',
      price: 310000, squareFootage: 2000, bedrooms: 3, bathrooms: 2.5,
      propertyType: 'Townhouse', yearBuilt: 2001, daysOnMarket: 21,
      latitude: 39.775, longitude: -89.655, status: 'Active',
    },
    {
      formattedAddress: '666 Sunset Way, Springfield, IL 62704',
      price: 385000, squareFootage: 2400, bedrooms: 4, bathrooms: 3,
      propertyType: 'Single Family', yearBuilt: 1995, daysOnMarket: 3,
      latitude: 39.784, longitude: -89.647, status: 'Active',
    },
  ];
  return base;
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

  if (state.demoMode || !state.apiLive) {
    // Demo mode
    await new Promise((r) => setTimeout(r, 800));
    const prop = getDemoProperty();
    const val = getDemoValuation();
    renderSearchResults(prop, val);
    hide('search-loading');
    show('search-results');
    toast('Showing demo data — add your RentCast API key for live results', 'info');
    return;
  }

  try {
    // Fetch property data
    const propRes = await fetch(`/api/property?address=${encodeURIComponent(address)}`);
    const propData = await propRes.json();
    if (propData.error) throw new Error(propData.error);

    const property = Array.isArray(propData) ? propData[0] : propData;
    if (!property) {
      hide('search-loading');
      show('search-empty');
      return;
    }

    // Fetch valuation
    let valuation = null;
    try {
      const valRes = await fetch(`/api/value?address=${encodeURIComponent(address)}`);
      const valData = await valRes.json();
      if (!valData.error) valuation = valData;
    } catch {
      /* valuation is optional */
    }

    // Fetch rent estimate
    let rent = null;
    try {
      const rentRes = await fetch(`/api/rent?address=${encodeURIComponent(address)}`);
      const rentData = await rentRes.json();
      if (!rentData.error) rent = rentData;
    } catch {
      /* rent is optional */
    }

    if (valuation && rent) {
      valuation.rentEstimate = rent.rent;
    }

    renderSearchResults(property, valuation);
    hide('search-loading');
    show('search-results');
  } catch (err) {
    hide('search-loading');
    show('search-empty');
    $('search-empty-text').textContent = err.message || 'Failed to fetch property data.';
    toast(err.message, 'error');
  }
}

function renderSearchResults(property, valuation) {
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

  if (state.demoMode || !state.apiLive) {
    await new Promise((r) => setTimeout(r, 600));
    const listings = getDemoListings();
    renderScanResults(listings);
    hide('scan-loading');
    toast('Showing demo data — add your RentCast API key for live results', 'info');
    return;
  }

  try {
    const endpoint = type === 'rental' ? '/api/listings/rental' : '/api/listings/sale';
    const params = new URLSearchParams();
    if (city) params.set('city', city);
    if (stateVal) params.set('state', stateVal);
    if (zip) params.set('zipCode', zip);
    if (priceMin) params.set('priceMin', priceMin);
    if (priceMax) params.set('priceMax', priceMax);
    if (beds) params.set('bedrooms', beds);
    if (baths) params.set('bathrooms', baths);

    const res = await fetch(`${endpoint}?${params}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const listings = Array.isArray(data) ? data : [];
    if (!listings.length) {
      hide('scan-loading');
      $('scan-list').innerHTML =
        '<div class="empty-state"><p>No listings found matching your criteria. Try adjusting filters.</p></div>';
      return;
    }

    renderScanResults(listings);
    hide('scan-loading');
  } catch (err) {
    hide('scan-loading');
    toast(err.message, 'error');
    $('scan-list').innerHTML =
      `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

function renderScanResults(listings) {
  // Calculate analytics
  const withPrice = listings.filter((l) => l.price > 0);
  const avgPrice = withPrice.reduce((s, l) => s + l.price, 0) / (withPrice.length || 1);
  const withSqft = listings.filter((l) => l.squareFootage > 0 && l.price > 0);
  const avgPpsf = withSqft.length
    ? withSqft.reduce((s, l) => s + l.price / l.squareFootage, 0) / withSqft.length
    : 0;

  // Deal scoring algorithm
  const scored = listings.map((listing) => {
    let score = 50; // base

    // Price per sqft compared to average (lower is better deal)
    if (listing.squareFootage > 0 && avgPpsf > 0) {
      const ppsf = listing.price / listing.squareFootage;
      const ratio = ppsf / avgPpsf;
      if (ratio < 0.85) score += 30;
      else if (ratio < 0.95) score += 20;
      else if (ratio < 1.05) score += 10;
      else if (ratio > 1.15) score -= 10;
    }

    // Days on market bonus (longer = potential negotiation)
    if (listing.daysOnMarket > 30) score += 10;
    else if (listing.daysOnMarket > 60) score += 15;

    // Newer construction bonus
    if (listing.yearBuilt >= 2015) score += 5;
    else if (listing.yearBuilt >= 2000) score += 3;

    return { ...listing, dealScore: Math.max(0, Math.min(100, score)) };
  });

  // Sort by deal score descending
  scored.sort((a, b) => b.dealScore - a.dealScore);
  const bestScore = scored[0]?.dealScore || 0;

  // Summary
  show('scan-summary');
  $('scan-count').textContent = listings.length;
  $('scan-avg-price').textContent = fmtCurrency(avgPrice);
  $('scan-avg-ppsf').textContent = avgPpsf ? '$' + avgPpsf.toFixed(0) : '--';
  $('scan-best-deal').textContent = bestScore + '/100';

  // Listing cards
  const list = $('scan-list');
  list.innerHTML = '';
  scored.forEach((listing, i) => {
    const ppsf =
      listing.squareFootage > 0 ? '$' + (listing.price / listing.squareFootage).toFixed(0) + '/sqft' : '';
    const isBest = i === 0 && listing.dealScore >= 70;

    let dealClass = 'deal-fair';
    let dealLabel = 'Fair';
    if (listing.dealScore >= 75) {
      dealClass = 'deal-excellent';
      dealLabel = 'Excellent';
    } else if (listing.dealScore >= 60) {
      dealClass = 'deal-good';
      dealLabel = 'Good';
    }

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
      </div>
      <div class="scan-pricing">
        <div class="scan-price">${fmtCurrency(listing.price)}</div>
        <div class="scan-ppsf">${ppsf}</div>
        <div class="deal-score ${dealClass}">${dealLabel} (${listing.dealScore})</div>
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
  if (state.demoMode || !state.apiLive) {
    await new Promise((r) => setTimeout(r, 600));
    listings = getDemoListings().map((l) => ({
      ...l,
      latitude: state.mapCenter.lat + (Math.random() - 0.5) * 0.02,
      longitude: state.mapCenter.lon + (Math.random() - 0.5) * 0.02,
    }));
    toast('Showing demo data — add your RentCast API key for live results', 'info');
  } else {
    try {
      // Reverse geocode to get zip
      const revRes = await fetch(
        `/api/reverse-geocode?lat=${state.mapCenter.lat}&lon=${state.mapCenter.lon}`
      );
      const revData = await revRes.json();
      const zip = revData.address?.postcode;

      if (!zip) {
        toast('Could not determine zip code for this location', 'error');
        $('map-find-similar').disabled = false;
        $('map-find-similar').textContent = 'Find Similar Homes';
        return;
      }

      const res = await fetch(`/api/listings/sale?zipCode=${zip}&limit=25`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      listings = Array.isArray(data) ? data : [];
    } catch (err) {
      toast(err.message, 'error');
      $('map-find-similar').disabled = false;
      $('map-find-similar').textContent = 'Find Similar Homes';
      return;
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
  if (state.demoMode || !state.apiLive) {
    await new Promise((r) => setTimeout(r, 600));
    marketData = getDemoMarket();
    toast('Showing demo data — add your RentCast API key for live results', 'info');
  } else {
    try {
      const res = await fetch(`/api/market?zipCode=${zip}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      marketData = Array.isArray(data) ? data[0] : data;
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
