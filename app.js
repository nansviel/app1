// ─── CONFIG ────────────────────────────────────────────────────────────────
// Aucun token nécessaire — MapLibre GL JS + OpenFreeMap (100% gratuit & open source)

const PARIS = { lat: 48.8566, lng: 2.3522 };
const SHADOW_BBOX = { minLat: 48.838, minLng: 2.318, maxLat: 48.878, maxLng: 2.388 };

// ─── MAP ───────────────────────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: 'map',
  // Tuiles OpenFreeMap — open source, pas de compte requis
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [PARIS.lng, PARIS.lat],
  zoom: 15.5,
  pitch: 30,
  bearing: -10,
  antialias: true,
});

map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

// ─── STATE ──────────────────────────────────────────────────────────────────

let isLive = true;
let simDate = new Date();
let cachedBuildings = []; // { coords: [[lng,lat]…], height: number }

// ─── SUN ────────────────────────────────────────────────────────────────────

function getSunInfo(date) {
  const pos = SunCalc.getPosition(date, PARIS.lat, PARIS.lng);
  const altitudeDeg = pos.altitude * (180 / Math.PI);
  // SunCalc: azimuth from south, positive westward → compass bearing (N=0, CW)
  const bearing = ((pos.azimuth * 180 / Math.PI) + 180 + 360) % 360;
  return { altitudeDeg, bearing };
}

function bearingToMapLibreAzimuthal(bearing) {
  // MapLibre azimuthal: 0=East, counterclockwise
  return (90 - bearing + 360) % 360;
}

function getCardinal(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO', 'N'][Math.round(deg / 45)];
}

function lightParams(alt) {
  if (alt < 0)  return { color: '#001a4d', intensity: 0.12 };
  if (alt < 5)  return { color: '#ff7722', intensity: 0.25 + alt * 0.05 };
  if (alt < 15) return { color: '#ffcc88', intensity: 0.50 + (alt - 5) * 0.02 };
  return { color: '#ffffff', intensity: Math.min(0.88, 0.70 + alt / 360) };
}

// ─── SHADOW GEOMETRY ────────────────────────────────────────────────────────
// L'ombre au sol = balayage continu de l'empreinte vers sa projection :
//   anneau = empreinte originale (sens horaire) + empreinte projetée (sens anti-horaire)
// → couvre le sol depuis le pied du mur jusqu'au bout de l'ombre, sans trou.

function buildShadowRing(coords, dLng, dLat) {
  const projected = coords.map(([lng, lat]) => [lng + dLng, lat + dLat]);
  // Aller sur l'original, revenir sur le projeté (inversé) → polygone fermé continu
  const ring = [...coords, ...projected.slice().reverse()];
  ring.push(ring[0]);
  return ring;
}

function computeShadowGeoJSON(altDeg, bearingDeg) {
  const empty = { type: 'FeatureCollection', features: [] };
  if (altDeg < 2 || cachedBuildings.length === 0) return empty;

  const altRad          = altDeg * Math.PI / 180;
  const shadowBearingRad = ((bearingDeg + 180) % 360) * Math.PI / 180;
  const MAX_SHADOW_M    = 160; // cap à ~160 m (crédible jusqu'à ~10° d'altitude)

  const features = cachedBuildings.map(({ coords, height }) => {
    const shadowLen = Math.min(MAX_SHADOW_M, height / Math.tan(altRad));
    const refLat    = coords[0][1];
    const mPerLng   = 111111 * Math.cos(refLat * Math.PI / 180);
    const dLat = (shadowLen * Math.cos(shadowBearingRad)) / 111111;
    const dLng = (shadowLen * Math.sin(shadowBearingRad)) / mPerLng;

    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [buildShadowRing(coords, dLng, dLat)] },
      properties: {}
    };
  });

  return { type: 'FeatureCollection', features };
}

// ─── APPLY LIGHT + SHADOWS ──────────────────────────────────────────────────

function applyLight(date) {
  const { altitudeDeg, bearing } = getSunInfo(date);
  const { color, intensity }     = lightParams(altitudeDeg);
  const polar = Math.max(0, Math.min(90, 90 - altitudeDeg));

  map.setLight({
    anchor: 'map',
    position: [1.5, bearingToMapLibreAzimuthal(bearing), polar],
    color,
    intensity,
  });

  if (map.getLayer('sunny-overlay')) {
    map.setPaintProperty('sunny-overlay', 'fill-opacity', altitudeDeg > 2 ? 0.38 : 0);
  }

  if (map.getSource('shadows')) {
    map.getSource('shadows').setData(computeShadowGeoJSON(altitudeDeg, bearing));
  }

  updatePanel(date, altitudeDeg, bearing);
}

// ─── PANEL ──────────────────────────────────────────────────────────────────

function updatePanel(date, altitudeDeg, bearing) {
  document.getElementById('time-display').textContent =
    date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('sun-altitude').textContent = `${altitudeDeg.toFixed(1)}°`;
  document.getElementById('sun-direction').textContent =
    `${getCardinal(bearing)} · ${bearing.toFixed(0)}°`;

  const badge = document.getElementById('sun-status');
  if (altitudeDeg < 0)      { badge.textContent = '🌙 Nuit';        badge.className = 'badge night';  }
  else if (altitudeDeg < 6) { badge.textContent = '🌅 Heure dorée'; badge.className = 'badge golden'; }
  else                       { badge.textContent = '☀️ Soleil';      badge.className = 'badge day';    }

  const needle = document.getElementById('c-needle');
  needle.style.transform = altitudeDeg > 0
    ? `translate(-50%, -50%) rotate(${bearing}deg)`
    : `translate(-50%, -50%)`;
  needle.style.opacity = altitudeDeg > 0 ? '1' : '0.3';
}

// ─── LOAD BUILDINGS (Overpass OSM) ──────────────────────────────────────────

async function loadBuildings() {
  const { minLat, minLng, maxLat, maxLng } = SHADOW_BBOX;
  const q = `[out:json][timeout:30];
    way["building"](${minLat},${minLng},${maxLat},${maxLng});
    out geom;`;

  try {
    const res  = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: `data=${encodeURIComponent(q)}`,
    });
    const json = await res.json();

    cachedBuildings = json.elements
      .filter(el => el.geometry && el.geometry.length >= 3)
      .map(el => ({
        coords: el.geometry.map(pt => [pt.lon, pt.lat]),
        height: parseFloat(el.tags?.height)
          || (parseInt(el.tags?.['building:levels']) * 3.5)
          || 15,
      }));

    const { altitudeDeg, bearing } = getSunInfo(simDate);
    if (map.getSource('shadows')) {
      map.getSource('shadows').setData(computeShadowGeoJSON(altitudeDeg, bearing));
    }
  } catch (err) {
    console.warn('[SoleilParis] Erreur bâtiments:', err);
  }
}

// ─── MAP LOAD ────────────────────────────────────────────────────────────────

map.on('load', () => {
  // Insertion avant les labels pour rester lisible
  const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;

  // 1. Overlay jaune — zones ensoleillées
  const bboxPoly = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [SHADOW_BBOX.minLng, SHADOW_BBOX.minLat],
        [SHADOW_BBOX.maxLng, SHADOW_BBOX.minLat],
        [SHADOW_BBOX.maxLng, SHADOW_BBOX.maxLat],
        [SHADOW_BBOX.minLng, SHADOW_BBOX.maxLat],
        [SHADOW_BBOX.minLng, SHADOW_BBOX.minLat],
      ]]
    }
  };
  map.addSource('sunny-area', { type: 'geojson', data: bboxPoly });
  map.addLayer({
    id: 'sunny-overlay',
    type: 'fill',
    source: 'sunny-area',
    // Jaune franc, bien visible — opacity gérée dynamiquement dans applyLight()
    paint: { 'fill-color': '#FFD700', 'fill-opacity': 0 },
  }, firstSymbol);

  // 2. Polygones d'ombre — gris bleuté opaque
  map.addSource('shadows', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  map.addLayer({
    id: 'shadow-layer',
    type: 'fill',
    source: 'shadows',
    // Couvre clairement les zones à l'ombre (rues, trottoirs, terrasses)
    paint: { 'fill-color': '#8090a0', 'fill-opacity': 0.72 },
  }, firstSymbol);

  // 3. Bâtiments 3D (OpenMapTiles schema : render_height)
  map.addLayer({
    id: '3d-buildings',
    source: 'openmaptiles',
    'source-layer': 'building',
    type: 'fill-extrusion',
    minzoom: 14,
    paint: {
      'fill-extrusion-color': [
        'interpolate', ['linear'],
        ['coalesce', ['get', 'render_height'], 10],
        0, '#ede5d0', 30, '#d8cdb4', 80, '#c4b496',
      ],
      'fill-extrusion-height':  ['coalesce', ['get', 'render_height'], 10],
      'fill-extrusion-base':    ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.92,
    },
  });

  applyLight(simDate);
  loadBuildings();
  loadPOIs();

  setInterval(() => {
    if (!isLive) return;
    simDate = new Date();
    applyLight(simDate);
    syncSlider(simDate);
  }, 60_000);
});

// ─── POIs ────────────────────────────────────────────────────────────────────

const AMENITY_ICON = { restaurant: '🍽️', bar: '🍺', cafe: '☕' };

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
    const res  = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: `data=${encodeURIComponent(q)}` });
    const json = await res.json();
    features = json.elements
      .filter(el => (el.lat && el.lon) || el.center)
      .map(el => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: el.center ? [el.center.lon, el.center.lat] : [el.lon, el.lat],
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
    console.warn('[SoleilParis] POI error:', err);
  }

  map.addSource('pois', { type: 'geojson', data: { type: 'FeatureCollection', features } });

  map.addLayer({
    id: 'pois-glow', type: 'circle', source: 'pois',
    paint: {
      'circle-radius': 15,
      'circle-color': ['match', ['get', 'amenity'], 'restaurant', '#ff6b35', 'bar', '#9b59b6', '#27ae60'],
      'circle-opacity': 0.18, 'circle-blur': 1,
    },
  });

  map.addLayer({
    id: 'pois-layer', type: 'circle', source: 'pois',
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'amenity'], 'restaurant', '#ff6b35', 'bar', '#9b59b6', '#27ae60'],
      'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff', 'circle-opacity': 0.95,
    },
  });

  map.on('click', 'pois-layer', e => {
    const f = e.features[0];
    const p = f.properties;
    new maplibregl.Popup({ offset: 12, maxWidth: '230px' })
      .setLngLat(f.geometry.coordinates.slice())
      .setHTML(`
        <div class="popup-content">
          <h3>${p.name}</h3>
          <p class="type">${AMENITY_ICON[p.amenity] || '📍'} ${p.amenity}</p>
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

// ─── CONTROLS ────────────────────────────────────────────────────────────────

const slider      = document.getElementById('time-slider');
const sliderLabel = document.getElementById('slider-time');
const liveBtn     = document.getElementById('live-btn');

function syncSlider(date) {
  slider.value = date.getHours() + date.getMinutes() / 60;
  sliderLabel.textContent = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

slider.addEventListener('input', () => {
  isLive = false;
  liveBtn.classList.remove('active');
  liveBtn.textContent = '⏸ Temps réel';

  const v = +slider.value;
  const h = Math.floor(v);
  const m = Math.round((v % 1) * 60);
  sliderLabel.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  simDate = new Date();
  simDate.setHours(h, m, 0, 0);
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

syncSlider(simDate);
