'use client';

/**
 * Fetch a driving route from OSRM demo server.
 * Returns: { coords: [ [lat,lng], ... ], distanceKm, durationMin }
 */
export async function fetchOsrmRoute(origin, destination, { baseUrl } = {}) {
  if (!origin || !destination) throw new Error('Origin and destination required');

  const OSRM = baseUrl || process.env.NEXT_PUBLIC_OSRM_URL || 'https://router.project-osrm.org';
  // NOTE: OSRM expects lon,lat order in the URL
  const o = `${origin.longitude},${origin.latitude}`;
  const d = `${destination.longitude},${destination.latitude}`;
  const url = `${OSRM}/route/v1/driving/${o};${d}?overview=full&geometries=geojson`;

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`OSRM error: ${res.status}`);
  const json = await res.json();
  if (!json?.routes?.length) throw new Error('No route found');

  const r = json.routes[0];
  const coords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]); // -> [lat,lng]
  const distanceKm = r.distance / 1000;
  const durationMin = r.duration / 60;
  return { coords, distanceKm, durationMin };
}

/** Placeholder for later backend switch */
export async function fetchBackendOptimizedRoute(payload) {
  // Example shape; you’ll wire this once your backend is ready:
  // const res = await fetch('/api/optimize_route', { method: 'POST', body: JSON.stringify(payload) });
  // return await res.json();
  throw new Error('Backend optimize route not implemented yet');
}