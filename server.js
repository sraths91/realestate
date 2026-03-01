require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;
const RENTCAST_KEY = process.env.RENTCAST_API_KEY;
const RENTCAST_BASE = 'https://api.rentcast.io/v1';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Middleware: check API key is configured
// ---------------------------------------------------------------------------
function requireApiKey(req, res, next) {
  if (!RENTCAST_KEY) {
    return res.status(503).json({
      error: 'RENTCAST_API_KEY not configured. Add it to your .env file.',
      demo: true,
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// Helper: proxy fetch to RentCast
// ---------------------------------------------------------------------------
async function rentcastFetch(endpoint, params = {}) {
  const url = new URL(`${RENTCAST_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { 'X-Api-Key': RENTCAST_KEY, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RentCast ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Property lookup by address
app.get('/api/property', requireApiKey, async (req, res) => {
  try {
    const { address, city, state, zipCode } = req.query;
    const data = await rentcastFetch('/properties', { address, city, state, zipCode });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Property value estimate (AVM)
app.get('/api/value', requireApiKey, async (req, res) => {
  try {
    const { address, propertyType, bedrooms, bathrooms, squareFootage, compCount } = req.query;
    const data = await rentcastFetch('/avm/value', {
      address,
      propertyType,
      bedrooms,
      bathrooms,
      squareFootage,
      compCount: compCount || 10,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rent estimate
app.get('/api/rent', requireApiKey, async (req, res) => {
  try {
    const { address, propertyType, bedrooms, bathrooms, squareFootage, compCount } = req.query;
    const data = await rentcastFetch('/avm/rent/long-term', {
      address,
      propertyType,
      bedrooms,
      bathrooms,
      squareFootage,
      compCount: compCount || 10,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active listings (for-sale)
app.get('/api/listings/sale', requireApiKey, async (req, res) => {
  try {
    const { city, state, zipCode, bedrooms, bathrooms, status, priceMin, priceMax, limit } =
      req.query;
    const data = await rentcastFetch('/listings/sale', {
      city,
      state,
      zipCode,
      bedrooms,
      bathrooms,
      status: status || 'Active',
      priceMin,
      priceMax,
      limit: limit || 25,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active listings (rental)
app.get('/api/listings/rental', requireApiKey, async (req, res) => {
  try {
    const { city, state, zipCode, bedrooms, bathrooms, priceMin, priceMax, limit } = req.query;
    const data = await rentcastFetch('/listings/rental/long-term', {
      city,
      state,
      zipCode,
      bedrooms,
      bathrooms,
      priceMin,
      priceMax,
      limit: limit || 25,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Market statistics
app.get('/api/market', requireApiKey, async (req, res) => {
  try {
    const { zipCode, city, state, historyRange } = req.query;
    const data = await rentcastFetch('/markets', {
      zipCode,
      city,
      state,
      historyRange: historyRange || 12,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Geocode address via OpenStreetMap Nominatim (free, no key needed)
app.get('/api/geocode', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'RealtorTool/1.0' },
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reverse geocode
app.get('/api/reverse-geocode', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'RealtorTool/1.0' },
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    apiConfigured: !!RENTCAST_KEY,
    uptime: process.uptime(),
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Realtor Tool running at http://localhost:${PORT}`);
  if (!RENTCAST_KEY) {
    console.log('WARNING: RENTCAST_API_KEY not set. App will run in demo mode.');
    console.log('Get your free key at https://developers.rentcast.io');
  }
});
