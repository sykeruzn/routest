'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MapContainer,
  TileLayer,
  LayersControl,
  Marker,
  Popup,
  ZoomControl,
  Polyline,
} from 'react-leaflet';
import L from 'leaflet';

import 'leaflet/dist/leaflet.css';
import 'leaflet-defaulticon-compatibility';
import 'leaflet-defaulticon-compatibility/dist/leaflet-defaulticon-compatibility.css';

import { fetchLocations } from '@/lib/locations';
import Controls from '@/components/Controls';
import RouteControls from '@/components/RouteControls';
import { matchesType, classifyType, TYPE } from '@/lib/classify';
import { fetchOsrmRoute } from '@/lib/routing';

const INITIAL_BOUNDS = L.latLngBounds([14.4043, 120.9634], [14.6656, 121.0891]);

// Single, consistent marker style
const defaultIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

export default function MapView() {
  const mapRef = useRef(null);

  // Data + UI state
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);            // NEW: loading state
  const [error, setError] = useState(null);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(TYPE.ALL);

  // Routing state (OSRM demo)
  const [originId, setOriginId] = useState(null);
  const [destId, setDestId] = useState(null);
  const [route, setRoute] = useState(null); // { coords, distanceKm, durationMin }

  const defaultBounds = useMemo(() => INITIAL_BOUNDS.pad(0.02), []);

  // Load locations
  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchLocations();
        if (!mounted) return;
        setLocations(data);

        // Initial fit once
        if (mapRef.current && data.length > 0) {
          const b = L.latLngBounds(data.map((d) => [d.latitude, d.longitude])).pad(0.02);
          mapRef.current.fitBounds(b, { padding: [24, 24] });
        }
      } catch (err) {
        if (!mounted) return;
        setError(err.message || 'Failed to load locations');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Search + type filter
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return locations.filter((loc) => {
      const nameMatch = !q || loc.name.toLowerCase().includes(q);
      const filterMatch = matchesType(loc.name, filter);
      return nameMatch && filterMatch;
    });
  }, [locations, search, filter]);

  // Selected origin/destination
  const origin = useMemo(() => locations.find((l) => l.id === originId) || null, [locations, originId]);
  const destination = useMemo(() => locations.find((l) => l.id === destId) || null, [locations, destId]);


  // Dev-only data source badge (toggleable)
  const isDev = process.env.NODE_ENV !== 'production';
  const hideBadge =
    String(process.env.NEXT_PUBLIC_HIDE_DS_BADGE || '')
      .trim()
      .toLowerCase() === '1' ||
    String(process.env.NEXT_PUBLIC_HIDE_DS_BADGE || '')
      .trim()
      .toLowerCase() === 'true';

  const dataSource = useMemo(() => {
    const hasSupabaseEnv =
      !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
      !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    return hasSupabaseEnv ? 'Supabase' : 'API';
  }, []);

  async function handleRoute() {
    try {
      setError(null);
      setRoute(null);
      if (!origin || !destination) return;
      const r = await fetchOsrmRoute(origin, destination);
      setRoute(r);
      // Focus map to route
      if (mapRef.current && r?.coords?.length) {
        const b = L.latLngBounds(r.coords).pad(0.02);
        mapRef.current.fitBounds(b, { padding: [24, 24], maxZoom: 16 });
      }
    } catch (e) {
      setError(e.message || 'Routing failed');
    }
  }
  function clearRoute() {
    setRoute(null);
  }

  // Clear filters helper (for the empty state action)
  function clearFilters() {
    setSearch('');
    setFilter(TYPE.ALL);
  }
  
  return (
    <div className="h-screen w-full">
      {/* Error banner (existing) */}
      {error && (
        <div className="absolute z-[1100] m-2 rounded bg-red-600/90 px-3 py-2 text-white shadow">
          {error}
        </div>
      )}

      {/* Loading overlay */}
      {loading && (
        <div
          className="absolute inset-0 z-[1050] grid place-items-center bg-black/5 backdrop-blur-sm"
          aria-live="polite"
        >
          <div className="flex items-center gap-3 rounded-2xl bg-black/80 px-4 py-2 text-white shadow">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            <span className="text-sm">Loading locations…</span>
          </div>
        </div>
      )}

      {/* Empty results badge (only when not loading, we have data, but 0 match) */}
      {!loading && locations.length > 0 && filtered.length === 0 && (
        <div className="absolute left-1/2 top-3 z-[1040] -translate-x-1/2 rounded-full bg-black/80 px-3 py-1 text-xs text-white shadow">
          No locations match your search/filter.
          <button
            className="ml-2 rounded-full border border-white/30 px-2 py-0.5 text-[11px] hover:bg-white/10"
            onClick={clearFilters}
          >
            Clear
          </button>
        </div>
      )}

      {/* Search & filter panel */}
      <Controls
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        count={filtered.length}
      />

      {/* Routing panel */}
      <RouteControls
        locations={locations}
        originId={originId}
        setOriginId={setOriginId}
        destId={destId}
        setDestId={setDestId}
        onRoute={handleRoute}
        onClear={clearRoute}
      />

      {/* Route summary */}
      {route && (
        <div className="absolute left-1/2 bottom-3 -translate-x-1/2 z-[1000] rounded-full bg-black/80 text-white text-xs px-3 py-1 shadow">
          Distance: {route.distanceKm.toFixed(1)} km • Duration: {Math.round(route.durationMin)} min
        </div>
      )}

      {isDev && !hideBadge && (
        <div className="absolute bottom-3 left-3 z-[1000] rounded-full border border-black/10 dark:border-white/10 bg-white/90 dark:bg-neutral-900/90 px-2.5 py-1 text-xs text-black dark:text-white shadow backdrop-blur">
          <span
            className={`mr-2 inline-block h-2 w-2 rounded-full ${
              dataSource === 'Supabase' ? 'bg-emerald-500' : 'bg-amber-500'
            }`}
          />
          Data source: <strong className="ml-1">{dataSource}</strong>
        </div>
      )}

      <MapContainer
        whenCreated={(map) => {
          mapRef.current = map;
        }}
        bounds={defaultBounds}
        className="h-full w-full"
        minZoom={10}
        maxZoom={18}
        scrollWheelZoom
        zoomControl={false}
      >
        <ZoomControl position="bottomright" />

        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="OSM Light">
            <TileLayer
              attribution="&copy; OpenStreetMap contributors"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Carto Dark Matter">
            <TileLayer
              attribution="&copy; OpenStreetMap contributors & CARTO"
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              subdomains="abcd"
              maxZoom={20}
            />
          </LayersControl.BaseLayer>
        </LayersControl>

        {/* Route polyline */}
        {route?.coords?.length ? (
          <Polyline positions={route.coords} pathOptions={{ weight: 5, opacity: 0.9 }} />
        ) : null}

        {/* Markers */}
        {filtered.map((loc) => {
          const t = classifyType(loc.name); // 'mall' | 'warehouse'
          return (
            <Marker key={loc.id} position={[loc.latitude, loc.longitude]} icon={defaultIcon}>
              <Popup>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="font-semibold">{loc.name}</div>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[10px] ${
                        t === TYPE.WAREHOUSE ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'
                      }`}
                    >
                      {t}
                    </span>
                  </div>
                  {loc.created_at && (
                    <div className="text-xs opacity-80">
                      Created: {new Date(loc.created_at).toLocaleString()}
                    </div>
                  )}
                  <div className="text-xs opacity-80">
                    {loc.latitude.toFixed(6)}, {loc.longitude.toFixed(6)}
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}