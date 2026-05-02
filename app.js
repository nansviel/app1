// ─── CONFIG ────────────────────────────────────────────────────────────────
// Créez un compte gratuit sur https://account.mapbox.com/ → Access tokens
const MAPBOX_TOKEN = 'VOTRE_TOKEN_MAPBOX_ICI';

const PARIS = { lat: 48.8566, lng: 2.3522 };

// Zone de calcul des ombres (~2 km² autour du centre)
const SHADOW_BBOX = { minLat: 48.845, minLng: 2.330, maxLat: 48.870, maxLng: 2.375 };

// ─── MAP ───────────────────────────────────────────────────────────────────

mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [PARIS.lng, PARIS.lat],
  zoom: 15,
  pitch: 45,
  bearing: -15,
  antialias: true,
});

map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');

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

function bearingToMapboxAzimuthal(bearing) {
  // Mapbox azimuthal: 0=East, counterclockwise
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
// Pour chaque bâtiment on translate son empreinte selon le vecteur d'ombre
// (direction opposée au soleil, longueur = hauteur / tan(altitude))

function computeShadowGeoJSON(altDeg, bearingDeg) {
  const empty = { type: 'FeatureCollection', features: [] };
  if (altDeg < 2 || cachedBuildings.length === 0) return empty;

  const altRad = altDeg * Math.PI / 180;
  // Ombre dans la direction OPPOSÉE au soleil
  const shadowBearingRad = ((bearingDeg + 180) % 360) * Math.PI / 180;
  const MAX_SHADOW_M = 250; // cap à 250 m (soleil très bas → ombres infinies sinon)

  const features = cachedBuildings.map(({ coords, height }) => {
    const shadowLen = Math.min(MAX_SHADOW_M, height / Math.tan(altRad));
    const refLat   = coords[0][1];
    const mPerLng  = 111111 * Math.cos(refLat * Math.PI / 180);

    const dLat = (shadowLen * Math.cos(shadowBearingRad)) / 111111;
    const dLng = (shadowLen * Math.sin(shadowBearingRad)) / mPerLng;

    const shadow = coords.map(([lng, lat]) => [lng + dLng, lat + dLat]);

    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [shadow] },
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
    position: [1.5, bearingToMapboxAzimuthal(bearing), polar],
    color,
    intensity,
  });

  // Overlay jaune visible uniquement de jour
  if (map.getLayer('sunny-overlay')) {
    map.setPaintProperty('sunny-overlay', 'fill-opacity', altitudeDeg > 2 ? 0.20 : 0);
  }

  // Mise à jour des polygones d'ombre
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
  if (altitudeDeg < 0)     { badge.textContent = '🌙 Nuit';         badge.className = 'badge night';  }
  else if (altitudeDeg < 6){ badge.textContent = '🌅 Heure dorée';  badge.className = 'badge golden'; }
  else                      { badge.textContent = '☀️ Soleil';       badge.className = 'badge day';    }

  const needle = document.getElementById('c-needle');
  needle.style.transform = altitudeDeg > 0
    ? `translate(-50%, -50%) rotate(${bearing}deg)`
    : `translate(-50%, -50%)`;
  needle.style.opacity = altitudeDeg > 0 ? '1' : '0.3';
}

// ─── LOAD BUILDINGS FOR SHADOW CALC (Overpass) ─────────────────────────────

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
          || 15, // hauteur par défaut Paris ~15 m
      }));

    // Recalculer les ombres maintenant que les bâtiments sont chargés
    const { altitudeDeg, bearing } = getSunInfo(simDate);
    if (map.getSource('shadows')) {
      map.getSource('shadows').setData(computeShadowGeoJSON(altitudeDeg, bearing));
    }
  } catch (err) {
    console.warn('[SoleilParis] Erreur chargement bâtiments:', err);
  }
}

// ─── MAP LOAD ────────────────────────────────────────────────────────────────

map.on('load', () => {
  // Insertion avant la première couche de labels pour rester sous le texte
  const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;

  // 1. Overlay jaune (zones ensoleillées)
  const bboxPolygon = {
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
  map.addSource('sunny-area', { type: 'geojson', data: bboxPolygon });
  map.addLayer({
    id: 'sunny-overlay',
    type: 'fill',
    source: 'sunny-area',
    paint: { 'fill-color': '#FFE566', 'fill-opacity': 0 }, // opacity gérée dynamiquement
  }, firstSymbol);

  // 2. Couche ombres gris clair
  map.addSource('shadows', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  map.addLayer({
    id: 'shadow-layer',
    type: 'fill',
    source: 'shadows',
    paint: {
      'fill-color': '#b8c4cc',
      'fill-opacity': 0.60,
    },
  }, firstSymbol);

  // 3. Bâtiments 3D (par-dessus les ombres)
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
        0, '#ede5d0', 30, '#d8cdb4', 80, '#c4b496',
      ],
      'fill-extrusion-height':  ['get', 'height'],
      'fill-extrusion-base':    ['get', 'min_height'],
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
    id: 'pois-glow',
    type: 'circle',
    source: 'pois',
    paint: {
      'circle-radius': 15,
      'circle-color': ['match', ['get', 'amenity'], 'restaurant', '#ff6b35', 'bar', '#9b59b6', '#27ae60'],
      'circle-opacity': 0.18,
      'circle-blur': 1,
    },
  });

  map.addLayer({
    id: 'pois-layer',
    type: 'circle',
    source: 'pois',
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'amenity'], 'restaurant', '#ff6b35', 'bar', '#9b59b6', '#27ae60'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.95,
    },
  });

  map.on('click', 'pois-layer', e => {
    const f = e.features[0];
    const p = f.properties;
    new mapboxgl.Popup({ offset: 12, maxWidth: '230px' })
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
