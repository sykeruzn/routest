// app/api/health/route.js
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';

const TMO = 7000;

function fetchWithTimeout(url, options = {}, ms = TMO) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

export async function GET() {
  const osrmBase = process.env.NEXT_PUBLIC_OSRM_URL || 'https://router.project-osrm.org';
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const checks = {
    tiles: { osm: null, carto: null },
    supabase: null,
    osrm: null,
  };

  const backendBase = process.env.NEXT_PUBLIC_ROUTE_API_BASE || 'http://127.0.0.1:5000/api';
  try {
    const res = await fetchWithTimeout(`${backendBase}/ping`, { method: 'GET' });
    const ok = res.ok;
    checks.backend = { ok, status: res.status };
  } catch (e) {
    checks.backend = { ok: false, error: String(e) };
  }

  try {
    // OSM tile (world tile 0/0/0 is safe)
    const osm = await fetchWithTimeout('https://tile.openstreetmap.org/0/0/0.png', { method: 'GET' });
    checks.tiles.osm = { ok: osm.ok, status: osm.status };
  } catch (e) {
    checks.tiles.osm = { ok: false, error: String(e) };
  }

  try {
    // Carto Dark tile (world tile)
    const carto = await fetchWithTimeout('https://basemaps.cartocdn.com/dark_all/0/0/0.png', { method: 'GET' });
    checks.tiles.carto = { ok: carto.ok, status: carto.status };
  } catch (e) {
    checks.tiles.carto = { ok: false, error: String(e) };
  }

  try {
    if (!supaUrl || !supaKey) {
      checks.supabase = { ok: false, error: 'Missing Supabase env' };
    } else {
      // Request count of rows via REST
      const res = await fetchWithTimeout(
        `${supaUrl}/rest/v1/locations?select=id`,
        {
          headers: {
            apikey: supaKey,
            Authorization: `Bearer ${supaKey}`,
            Prefer: 'count=exact',
          },
        }
      );
      const ok = res.ok;
      const contentRange = res.headers.get('content-range'); // e.g. "0-20/21"
      let total = null;
      if (contentRange && contentRange.includes('/')) {
        total = Number(contentRange.split('/').pop());
      }
      checks.supabase = { ok, status: res.status, total };
    }
  } catch (e) {
    checks.supabase = { ok: false, error: String(e) };
  }

  try {
    // Simple OSRM route between Warehouse and Megamall (lon,lat;lon,lat)
    const o = [121.0409, 14.5836]; // Main Warehouse - Mandaluyong
    const d = [121.0567, 14.5833]; // SM Megamall
    const res = await fetchWithTimeout(
      `${osrmBase}/route/v1/driving/${o[0]},${o[1]};${d[0]},${d[1]}?overview=false`,
      { method: 'GET' }
    );
    const json = res.ok ? await res.json() : null;
    let distanceKm = null, durationMin = null;
    if (json?.routes?.[0]) {
      distanceKm = json.routes[0].distance / 1000;
      durationMin = json.routes[0].duration / 60;
    }
    checks.osrm = { ok: res.ok && !!json?.routes?.length, status: res.status, distanceKm, durationMin };
  } catch (e) {
    checks.osrm = { ok: false, error: String(e) };
  }

  return NextResponse.json({ ok: true, checks }, { status: 200 });
}