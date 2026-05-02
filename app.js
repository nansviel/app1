// ─── CONFIG ────────────────────────────────────────────────────────────────
// Créez un compte gratuit sur https://account.mapbox.com/ pour obtenir votre token
const MAPBOX_TOKEN = 'VOTRE_TOKEN_MAPBOX_ICI';

const PARIS = { lat: 48.8566, lng: 2.3522 };

// ─── INIT MAP ──────────────────────────────────────────────────────────────

mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [PARIS.lng, PARIS.lat],
  zoom: 15,
  pitch: 55,
  bearing: -15,
  antialias: true,
});

map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');

// ─── STATE ─────────────────────────────────────────────────────────────────

let isLive = true;
let simDate = new Date();

// ─── SUN CALCULATIONS ──────────────────────────────────────────────────────

function getSunInfo(date) {
  const pos = SunCalc.getPosition(date, PARIS.lat, PARIS.lng);
  const altitudeDeg = pos.altitude * (180 / Math.PI);
  // SunCalc azimuth: radians from south, positive westward → compass (N=0, CW)
  const bearing = ((pos.azimuth * 180 / Math.PI) + 180 + 360) % 360;
  return { altitudeDeg, bearing };
}

// Mapbox light azimuthal: 0=East, counterclockwise (standard math convention)
function bearingToMapboxAzimuthal(bearing) {
  return (90 - bearing + 360) % 360;
}

function getCardinal(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO', 'N'][Math.round(deg / 45)];
}

function lightParams(altitudeDeg) {
  if (altitudeDeg < 0)  return { color: '#001a4d', intensity: 0.12 };
  if (altitudeDeg < 5)  return { color: '#ff7722', intensity: 0.25 + altitudeDeg * 0.05 };
  if (altitudeDeg < 15) return { color: '#ffcc88', intensity: 0.50 + (altitudeDeg - 5) * 0.02 };
  return { color: '#ffffff', intensity: Math.min(0.88, 0.70 + altitudeDeg / 360) };
}

// ─── APPLY SUN TO MAP ──────────────────────────────────────────────────────

function applyLight(date) {
  const { altitudeDeg, bearing } = getSunInfo(date);
  const { color, intensity } = lightParams(altitudeDeg);

  const mapboxAz = bearingToMapboxAzimuthal(bearing);
  const polar    = Math.max(0, Math.min(90, 90 - altitudeDeg));

  map.setLight({
    anchor: 'map',
    position: [1.5, mapboxAz, polar],
    color,
    intensity,
  });

  updatePanel(date, altitudeDeg, bearing);
}

// ─── PANEL UI ──────────────────────────────────────────────────────────────

function updatePanel(date, altitudeDeg, bearing) {
  const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('time-display').textContent = timeStr;
  document.getElementById('sun-altitude').textContent = `${altitudeDeg.toFixed(1)}°`;
  document.getElementById('sun-direction').textContent =
    `${getCardinal(bearing)} · ${bearing.toFixed(0)}°`;

  const badge = document.getElementById('sun-status');
  if (altitudeDeg < 0) {
    badge.textContent = '🌙 Nuit';
    badge.className = 'badge night';
  } else if (altitudeDeg < 6) {
    badge.textContent = '🌅 Heure dorée';
    badge.className = 'badge golden';
  } else {
    badge.textContent = '☀️ Soleil';
    badge.className = 'badge day';
  }

  // Compass needle: rotate around center then push outward
  const needle = document.getElementById('c-needle');
  needle.style.transform = altitudeDeg > 0
    ? `translate(-50%, -50%) rotate(${bearing}deg)`
    : `translate(-50%, -50%)`;
  needle.style.opacity = altitudeDeg > 0 ? '1' : '0.3';
}

// ─── 3D BUILDINGS ──────────────────────────────────────────────────────────

function addBuildings() {
  map.addLayer({
    id: '3d-buildings',
    source: 'composite',
    'source-layer': 'building',
    filter: ['==', 'extrude', 'true'],
    type: 'fill-extrusion',
    minzoom: 14,
    paint: {
      'fill-extrusion-color': [
        'interpolate', ['linear'], ['get', 'height'],
        0,  '#ede5d0',
        30, '#d8cdb4',
        80, '#c4b496',
      ],
      'fill-extrusion-height':  ['get', 'height'],
      'fill-extrusion-base':    ['get', 'min_height'],
      'fill-extrusion-opacity': 0.92,
    },
  });
}

// ─── POIs (OpenStreetMap via Overpass) ─────────────────────────────────────

const AMENITY_COLOR = { restaurant: '#ff6b35', bar: '#9b59b6', cafe: '#27ae60' };
const AMENITY_ICON  = { restaurant: '🍽️', bar: '🍺', cafe: '☕' };

async function loadPOIs() {
  const q = `
    [out:json][timeout:25];
    (
      node["amenity"~"^(restaurant|bar|cafe)$"]["outdoor_seating"="yes"](48.82,2.27,48.90,2.42);
      way["amenity"~"^(restaurant|bar|cafe)$"]["outdoor_seating"="yes"](48.82,2.27,48.90,2.42);
    );
    out center 400;
  `;

  let features = [];
  try {
    const res  = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: `data=${encodeURIComponent(q)}`,
    });
    const json = await res.json();

    features = json.elements
      .filter(el => (el.lat && el.lon) || el.center)
      .map(el => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: el.center
            ? [el.center.lon, el.center.lat]
            : [el.lon, el.lat],
        },
        properties: {
          name:    el.tags.name || 'Terrasse',
          amenity: el.tags.amenity,
          cuisine: el.tags.cuisine || '',
          phone:   el.tags['contact:phone'] || el.tags.phone || '',
          addr:    el.tags['addr:street']
            ? `${el.tags['addr:housenumber'] || ''} ${el.tags['addr:street']}`.trim()
            : '',
        },
      }));
  } catch (err) {
    console.warn('[SoleilParis] Overpass error:', err);
  }

  const geojson = { type: 'FeatureCollection', features };

  map.addSource('pois', { type: 'geojson', data: geojson });

  // Soft glow halo
  map.addLayer({
    id: 'pois-glow',
    type: 'circle',
    source: 'pois',
    paint: {
      'circle-radius': 15,
      'circle-color': ['match', ['get', 'amenity'],
        'restaurant', '#ff6b35',
        'bar',        '#9b59b6',
        /* cafe */    '#27ae60',
      ],
      'circle-opacity': 0.18,
      'circle-blur': 1,
    },
  });

  // Main dot
  map.addLayer({
    id: 'pois-layer',
    type: 'circle',
    source: 'pois',
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'amenity'],
        'restaurant', '#ff6b35',
        'bar',        '#9b59b6',
        /* cafe */    '#27ae60',
      ],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.95,
    },
  });

  map.on('click', 'pois-layer', e => {
    const f = e.features[0];
    const p = f.properties;
    const icon = AMENITY_ICON[p.amenity] || '📍';

    new mapboxgl.Popup({ offset: 12, maxWidth: '230px' })
      .setLngLat(f.geometry.coordinates.slice())
      .setHTML(`
        <div class="popup-content">
          <h3>${p.name}</h3>
          <p class="type">${icon} ${p.amenity}</p>
          ${p.cuisine ? `<p>🍴 ${p.cuisine}</p>` : ''}
          ${p.addr    ? `<p>📍 ${p.addr}</p>`    : ''}
          ${p.phone   ? `<p>📞 ${p.phone}</p>`   : ''}
          <p class="terrace-badge">🌿 Terrasse extérieure</p>
        </div>
      `)
      .addTo(map);
  });

  map.on('mouseenter', 'pois-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'pois-layer', () => { map.getCanvas().style.cursor = '';        });
}

// ─── MAP LOAD ──────────────────────────────────────────────────────────────

map.on('load', () => {
  addBuildings();
  applyLight(simDate);
  loadPOIs();

  // Auto-update every 60 s in live mode
  setInterval(() => {
    if (!isLive) return;
    simDate = new Date();
    applyLight(simDate);
    syncSlider(simDate);
  }, 60_000);
});

// ─── TIME CONTROLS ─────────────────────────────────────────────────────────

const slider       = document.getElementById('time-slider');
const sliderLabel  = document.getElementById('slider-time');
const liveBtn      = document.getElementById('live-btn');

function syncSlider(date) {
  slider.value = date.getHours() + date.getMinutes() / 60;
  sliderLabel.textContent = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function sliderToDate(val) {
  const d = new Date();
  d.setHours(Math.floor(val), Math.round((val % 1) * 60), 0, 0);
  return d;
}

slider.addEventListener('input', () => {
  isLive = false;
  liveBtn.classList.remove('active');
  liveBtn.textContent = '⏸ Temps réel';

  const v = +slider.value;
  const h = Math.floor(v);
  const m = Math.round((v % 1) * 60);
  sliderLabel.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  simDate = sliderToDate(v);
  applyLight(simDate);
});

liveBtn.addEventListener('click', () => {
  isLive = true;
  liveBtn.classList.add('active');
  liveBtn.textContent = '🔴 Temps réel';
  simDate = new Date();
  applyLight(simDate);
  syncSlider(simDate);
});

// Boot: sync slider to current time
syncSlider(simDate);
