"use client";

import { useEffect, useMemo, useRef, useState, use as usePromise } from "react";
import Link from "next/link";
import "leaflet/dist/leaflet.css";

import { createClient } from "@supabase/supabase-js";


const ROUTE_API_BASE = process.env.NEXT_PUBLIC_ROUTE_API_BASE || "http://127.0.0.1:5000/api";
const OSRM_URL = process.env.NEXT_PUBLIC_OSRM_URL || "https://router.project-osrm.org";

export default function HistoryDetail({ params }) {
    const { id } = usePromise(params);

    const supabase = useMemo(
        () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
        []
    );

    const [data, setData] = useState(null);   // {request, result}
    const [err, setErr] = useState("");
    const [names, setNames] = useState({});     // {uuid: "Location name"}
    const [km, setKm] = useState(null);
    const [min, setMin] = useState(null);

    // Leaflet bits
    const mapRef = useRef(null);
    const routeLayerRef = useRef(null);
    const [mapReady, setMapReady] = useState(false);

    // Compute the display order of stops (optimized if available)
    const orderedStopIds = useMemo(() => {
    const ids = data?.request?.stops?.destination_ids || [];
    const ord = data?.result?.optimized_order;
    return Array.isArray(ord) && ord.length === ids.length ? ord.map(i => ids[i]) : ids;
    }, [data]);

    // load history detail
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch(`${ROUTE_API_BASE}/history/${id}`, { cache: "no-store" });
                const json = await res.json();
                if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
                if (alive) setData(json || null);
            } catch (e) {
                if (alive) setErr(e.message || "Failed to load history");
            }
        })();
        return () => { alive = false; };
    }, [id]);

    // fetch readable names for origin/dests (optional, purely for UI)
    useEffect(() => {
        const stops = data?.request?.stops || {};
        const ids = [
            ...(stops.destination_ids || []),
            ...(data?.request?.origin_id ? [data.request.origin_id] : []),
        ];
        const unique = Array.from(new Set(ids.filter(Boolean)));
        if (!unique.length) return;

        let active = true;
        (async () => {
            const { data: rows, error } = await supabase.from("locations")
                .select("id,name").in("id", unique);
            if (!error && active) {
                const map = Object.fromEntries((rows || []).map(r => [r.id, r.name]));
                setNames(map);
            }
        })();
        return () => { active = false; };
    }, [data, supabase]);

    useEffect(() => {
        if (!data?.result) return;
        const td = Number(data.result.total_distance);
        const tt = Number(data.result.total_duration);
        if (!Number.isNaN(td)) setKm(td / 1000);
        if (!Number.isNaN(tt)) setMin(tt / 60);
    }, [data]);

    // create a tiny map once the container exists
    useEffect(() => {
    (async () => {
        const container = document.getElementById("detail-map");
        if (!container || mapRef.current) return;

        const L = (await import("leaflet")).default;
        if (container._leaflet_id) { try { container._leaflet_id = null; } catch {} }

        const DefaultIcon = L.Icon.Default;
        DefaultIcon.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        });

        const map = L.map(container, { zoomControl: false, minZoom: 3 }).setView([14.6,121.0], 11);
        const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        }).addTo(map);
        mapRef.current = map;
        setMapReady(true);               // <-- ✅ tell the rest of the page the map exists now

        tiles.on("load", () => map.invalidateSize());
        setTimeout(() => map.invalidateSize(), 0);
        const ro = new ResizeObserver(() => map.invalidateSize());
        ro.observe(container);
        return () => ro.disconnect();
    })();
    }, [data]);


    // cleanup when navigating to a different history id (or unmount)
    useEffect(() => {
    return () => {
        if (mapRef.current) {
        try { mapRef.current.remove(); } catch {}
        mapRef.current = null;
        }
     setMapReady(false);
    };
    }, [id]);

    // draw polyline: (1) stored geometry → (2) OSRM from coords → (3) dashed fallback
    useEffect(() => {
    const run = async () => {
        if (!mapReady || !mapRef.current || !data?.request) return;
        const map = mapRef.current;
        const L = (await import("leaflet")).default;

        // clear previous layer
        if (routeLayerRef.current) {
        try { map.removeLayer(routeLayerRef.current); } catch {}
        routeLayerRef.current = null;
        }

        // (1) If geometry was persisted, use it
        const geom = data?.result?.geometry?.coordinates; // [[lon,lat], ...]
        if (Array.isArray(geom) && geom.length > 1) {
        const latlngs = geom.map(([lon, lat]) => [lat, lon]);
        routeLayerRef.current = L.polyline(latlngs, { weight: 5, opacity: 0.95 }).addTo(map);
        map.fitBounds(routeLayerRef.current.getBounds().pad(0.2));

        const td = Number(data?.result?.total_distance);
        const tt = Number(data?.result?.total_duration);
        if (!Number.isNaN(td)) setKm(td / 1000);
        if (!Number.isNaN(tt)) setMin(tt / 60);
        return;
        }

        // (2) OSRM (recompute if no geometry saved)
        const stops = data.request.stops || {};
        const originId = data.request.origin_id || null;

        // 2a) get origin coord if present
        let originCoord = null;
        if (originId) {
        const { data: oRows, error: oErr } = await supabase
            .from("locations")
            .select("id,latitude,longitude")
            .eq("id", originId)
            .limit(1);
        const o = oRows && oRows[0];
        if (o && o.latitude != null && o.longitude != null) {
            originCoord = { lat: +o.latitude, lon: +o.longitude };
        }
        }

        // 2b) build destination coords:
        // - prefer persisted stops.destination_points
        // - otherwise fetch coords for orderedStopIds from Supabase
        let destPoints = Array.isArray(stops.destination_points) ? stops.destination_points : [];
        if (!destPoints.length && orderedStopIds.length) {
        const { data: dRows, error: dErr } = await supabase
            .from("locations")
            .select("id,latitude,longitude")
            .in("id", orderedStopIds);
        const byId = Object.fromEntries((dRows || []).map(r => [r.id, { lat: +r.latitude, lon: +r.longitude }]));
        destPoints = orderedStopIds.map(id => byId[id]).filter(Boolean);
        }

        // 2c) try OSRM if we have at least 2 waypoints
        const osrmSeq = [
        ...(originCoord ? [`${originCoord.lon},${originCoord.lat}`] : []),
        ...destPoints.map(p => `${p.lon},${p.lat}`),
        ];

        if (osrmSeq.length >= 2) {
        try {
            const url = `${OSRM_URL}/route/v1/driving/${osrmSeq.join(";")}?overview=full&geometries=geojson`;
            const r = await fetch(url);
            const j = await r.json().catch(() => null);
            const route = j?.routes?.[0];
            if (route?.geometry?.coordinates?.length) {
            const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
            routeLayerRef.current = L.polyline(latlngs, { weight: 5, opacity: 0.95 }).addTo(map);
            map.fitBounds(routeLayerRef.current.getBounds().pad(0.2));
            setKm((route.distance || 0) / 1000);
            setMin((route.duration || 0) / 60);
            return;
            }
        } catch {
            // fall through to dashed fallback
        }
        }

        // ---------- 3) Straight-line fallback between stops (dashed)
        const straightLatLngs = [
        ...(originCoord ? [[originCoord.lat, originCoord.lon]] : []),
        ...destPoints.map(p => [p.lat, p.lon]),
        ];

        if (straightLatLngs.length > 1) {
        routeLayerRef.current = L.polyline(straightLatLngs, {
            weight: 4,
            opacity: 0.75,
            dashArray: "6,6",
        }).addTo(map);
        map.fitBounds(routeLayerRef.current.getBounds().pad(0.25));
        }

    };

    run();
    }, [data, supabase, orderedStopIds, mapReady]);


    const optimized = Boolean(data?.result?.optimized_order?.length);

    return (
        <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
            <div className="mx-auto max-w-screen-2xl px-6 py-8">
                <div className="mb-6 flex items-center justify-between">
                    <h1 className="text-3xl font-black tracking-tight text-slate-900">Route History</h1>
                    <Link
                        href="/ui"
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                    >
                        ← Back to Dashboard
                    </Link>
                </div>

                {err && (
                    <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {err}
                    </div>
                )}

                {!data ? (
                    <div className="text-slate-500">Loading…</div>
                ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        {/* Left: details */}
                        <div className="lg:col-span-1 space-y-4">
                            <div className="rounded-2xl border bg-white p-5 shadow-sm">
                            <Label>Request ID</Label>
                            <MutedMono>{data.request.id}</MutedMono>

                            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                                <div>
                                <Label>When</Label>
                                <Value>{new Date(data.request.request_time || Date.now()).toLocaleString()}</Value>
                                </div>
                                <div>
                                <Label>Optimized</Label>
                                {optimized ? (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 text-xs">
                                    ✓ Optimized
                                    </span>
                                ) : (
                                    <span className="text-slate-400 text-xs">—</span>
                                )}
                                </div>
                                <div>
                                <Label>Distance (km)</Label>
                                {km != null ? <Metric value={km.toFixed(1)} unit="km" /> : <Value>—</Value>}
                                </div>
                                <div>
                                <Label>Duration (min)</Label>
                                {min != null ? <Metric value={Math.round(min)} unit="min" /> : <Value>—</Value>}
                                </div>
                            </div>
                            </div>


                            <div className="rounded-2xl border bg-white p-5 shadow-sm">
                            <div className="font-semibold mb-2 text-slate-800">Stops</div>
                            <ol className="space-y-2 text-sm">
                                {(orderedStopIds || []).map((id, i) => (
                                <li key={id} className="flex items-center gap-2">
                                    <span className="inline-flex w-5 h-5 items-center justify-center rounded-full bg-slate-100 text-[11px] text-slate-600">
                                    {i + 1}
                                    </span>
                                    <span className="text-slate-800">{names[id] || id}</span>
                                </li>
                                ))}
                            </ol>
                            </div>
                        </div>

                        {/* Right: map */}
                        <div className="lg:col-span-2">
                            <div className="rounded-3xl border bg-white shadow-sm overflow-hidden">
                                <div id="detail-map" className="w-full h-[55vh]" />
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function Label({ children }) {
  return <div className="text-xs text-slate-500">{children}</div>;
}
function Value({ children }) {
  return <div className="text-slate-800">{children}</div>;
}
function MutedMono({ children }) {
  return <div className="font-mono text-xs break-all text-slate-600">{children}</div>;
}
function Metric({ value, unit }) {
  return (
    <div className="text-slate-800">
      <span className="tabular-nums font-semibold">{value}</span>
      {unit ? <span className="ml-1 text-[11px] text-slate-500">{unit}</span> : null}
    </div>
  );
}