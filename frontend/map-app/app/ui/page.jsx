"use client";

/**
 * Make sure Leaflet CSS is imported once globally, e.g. in app/globals.css:
 *   @import "leaflet/dist/leaflet.css";
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import Link from "next/link";

const ROUTER_MODE = process.env.NEXT_PUBLIC_ROUTER_MODE || "osrm";
const ROUTE_API_BASE = process.env.NEXT_PUBLIC_ROUTE_API_BASE || "http://127.0.0.1:5055/api";

export default function Page() {
  // ---- App State
  const [mapReady, setMapReady] = useState(false);
  const [originId, setOriginId] = useState(""); // uuid | "__current_location__"
  const MAX_STOPS = 10;
  const [destIds, setDestIds] = useState([]); // array of uuid
  const [vehicleId, setVehicleId] = useState(""); // ephemeral
  const [vehicleType, setVehicleType] = useState('car'); // 'car' | 'hgv' | 'bike' | 'roadbike' | 'foot'
  const [filter, setFilter] = useState("all"); // all | mall | warehouse
  const [health, setHealth] = useState(null);

  const [locations, setLocations] = useState([]); // [{id,name,latitude,longitude,created_at}]
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [geo, setGeo] = useState(null); // {lat,lng}
  const [errorMsg, setErrorMsg] = useState("");

  // ML toggle + driver age
  const [engine, setEngine] = useState("default"); // "default" | "ml"
  const [driverAge, setDriverAge] = useState(30);

  // Routing spinner + toast
  const [routing, setRouting] = useState(false);
  const [toast, setToast] = useState(null); // { type: 'error'|'info', message: string }

  // Analytics
  const [distanceKm, setDistanceKm] = useState(null);
  const [durationMin, setDurationMin] = useState(null);
  const [eta, setEta] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Route details
  const [routeSummary, setRouteSummary] = useState(null); // {originName,destName,km,min}
  const [routeSteps, setRouteSteps] = useState([]); // [{maneuver,modifier,name,distance,duration}]
  const [optimized, setOptimized] = useState(false);

  // Map progress
  const fullRouteRef = useRef(null);        // full polyline from backend result
  const progressDoneRef = useRef(null);     // driven segment
  const progressRemainRef = useRef(null);   // remaining segment
  const orderLayerRef = useRef(null);       // order layer

  // SSE connection state
  const [connStatus, setConnStatus] = useState('idle'); // 'idle' | 'connecting' | 'connected' | 'error'
  const [lastSseAt, setLastSseAt] = useState(null);     // timestamp (ms)
  const [retries, setRetries] = useState(0);

  const desiredChannelRef = useRef(null);   // non-null means we want to stay connected
  const reconnectTimerRef = useRef(null);   // holds setTimeout id

  const connecting = connStatus === 'connecting';
  const connected  = connStatus === 'connected';

  // Supabase client
  const supabase = useMemo(
    () =>
      createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      ),
    []
  );

  // Helpers
  const classify = (name = "") =>
    name.toLowerCase().includes("warehouse") ? "warehouse" : "mall";

  const [q, setQ] = useState("");

  const filteredLocations = useMemo(() => {
    const query = q.trim().toLowerCase();
    return locations.filter((l) => {
      const typeOk = filter === "all" ? true : classify(l.name) === filter;
      const textOk = !query ? true : l.name.toLowerCase().includes(query);
      return typeOk && textOk;
    });
  }, [locations, filter, q]);

  const distanceText = useMemo(
    () => (distanceKm == null ? "--" : `${distanceKm.toFixed(1)}`),
    [distanceKm]
  );

  const [saved, setSaved] = useState(false);

  const durationText = useMemo(() => {
    if (durationMin == null) return "--";
    const hours = Math.floor(durationMin / 60);
    const mins = Math.round(durationMin % 60);
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  }, [durationMin]);

  const etaText = useMemo(
    () => (eta ? eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--"),
    [eta]
  );

  // Map refs
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const routeLayerRef = useRef(null);

  // SSE base URL
  const SSE_BASE =
  (process.env.NEXT_PUBLIC_ROUTE_API_BASE || '').replace(/\/api$/, '') ||
  'http://127.0.0.1:5000';

  // Refs
  const lastFeatureRef = useRef(null);   // store last backend feature for simulate/export
  const sseRef = useRef(null);
  const trackerMarkerRef = useRef(null);

  // SSE channel
  const [sseChannel, setSseChannel] = useState('');   // defaults to vehicleId when set
  const [tracking, setTracking] = useState(false);
  
  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Health check
  useEffect(() => {
    let canceled = false;

    const load = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        const json = await res.json();
        if (!canceled) setHealth(json.checks || null);
      } catch {
        if (!canceled) setHealth(null);
      }
    };

    load();                      // initial
    const id = setInterval(load, 30000); // repeat
    return () => { canceled = true; clearInterval(id); };
  }, []);

  // Fetch locations
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoadingLocations(true);
        const { data, error } = await supabase
          .from("locations")
          .select("id,name,latitude,longitude,created_at")
          .order("created_at", { ascending: true });
        if (error) throw error;
        if (!active) return;
        setLocations(
          (data || []).map((r) => ({
            ...r,
            latitude: +r.latitude,
            longitude: +r.longitude,
          }))
        );
      } catch (e) {
        console.error(e);
        const msg = "Failed to load locations from Supabase.";
        setErrorMsg(msg);
        setToast({ type: "error", message: msg });
      } finally {
        if (active) setLoadingLocations(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [supabase]);

  // Mount Leaflet map
  useEffect(() => {
    if (typeof window === "undefined" || mapRef.current) return;

    let ro;
    let onResize;

    (async () => {
      const L = (await import("leaflet")).default;
      // Guard against re-init on Fast Refresh / remount
      const container = L.DomUtil.get("leaflet-map");
      if (container) {
        // If a map was previously attached to this DOM node, remove its id
        // so Leaflet doesn't throw "Map container is already initialized."
        container._leaflet_id = null;
      }
      // Default marker icon (CDN paths)
      const DefaultIcon = L.Icon.Default;
      DefaultIcon.mergeOptions({
        iconRetinaUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });

      // Initial view so tiles load
      const map = L.map("leaflet-map", {
        zoomControl: false,
        minZoom: 10,
        maxZoom: 18,
      }).setView([14.6, 121.0], 11); // Metro Manila default
      mapRef.current = map;

      const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
      }).addTo(map);
      const carto = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        { attribution: "© Carto & OpenStreetMap" }
      );

      L.control.layers({ OSM: osm, Carto: carto }, {}).addTo(map);
      L.control.zoom({ position: "bottomright" }).addTo(map);

      // Hide placeholder when first tiles load
      osm.on("load", () => setMapReady(true));

      // Marker layer group
      markersRef.current = L.layerGroup().addTo(map);

      // Make sure Leaflet knows actual size after layout
      setTimeout(() => map.invalidateSize(), 0);

      // Invalidate size on container or window resize
      const el = document.getElementById("map-container");
      ro = new ResizeObserver(() => map.invalidateSize());
      if (el) ro.observe(el);
      onResize = () => map.invalidateSize();
      window.addEventListener("resize", onResize);
    })();

    return () => {
      if (ro) ro.disconnect();
      if (onResize) window.removeEventListener("resize", onResize);
      // Properly tear down Leaflet on unmount / page switch
      if (mapRef.current) {
        try { mapRef.current.remove(); } catch {}
        mapRef.current = null;
      }
    };
  }, []);

  // Fit map to all locations (once loaded)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || locations.length === 0) return;
    const L = require("leaflet");
    const bounds = L.latLngBounds(
      locations.map((p) => L.latLng(+p.latitude, +p.longitude))
    );
    map.fitBounds(bounds.pad(0.15));
    setTimeout(() => map.invalidateSize(), 0);
  }, [locations]);

  // Render markers based on filter
  useEffect(() => {
    const map = mapRef.current;
    const group = markersRef.current;
    if (!map || !group) return;
    group.clearLayers();
    const L = require("leaflet");
    filteredLocations.forEach((p) => {
      L.marker([p.latitude, p.longitude])
        .bindPopup(
          `<div><strong>${escapeHtml(p.name)}</strong><br/>${new Date(
            p.created_at
          ).toLocaleString()}<br/>${p.latitude.toFixed(6)}, ${p.longitude.toFixed(
            6
          )}</div>`
        )
        .addTo(group);
    });
  }, [filteredLocations]);

  // Cleanup SSE + marker on unmount / route change
  useEffect(() => {
    return () => {
      stopTracking();
    };
  }, []); // run only on unmount

  // Update last SSE timestamp
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => { /* trigger re-render */ setLastSseAt((t) => t ? t : Date.now()); }, 1000);
    return () => clearInterval(id);
  }, [connected]);

  // Geolocation helper
  const ensureGeolocation = async () => {
    if (!("geolocation" in navigator)) {
      const msg = "Geolocation not supported by this browser.";
      setErrorMsg(msg);
      setToast({ type: "error", message: msg });
      return null;
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setGeo(coords);
          resolve(coords);
        },
        (err) => {
          console.warn(err);
          const msg = "Could not access current location.";
          setErrorMsg(msg);
          setToast({ type: "error", message: msg });
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  };

  const clearOrderLayer = () => {
    const map = mapRef.current;
    if (map && orderLayerRef.current) {
      try { map.removeLayer(orderLayerRef.current); } catch {}
      orderLayerRef.current = null;
    }
  };

  const showOptimizedOrderBadges = (feature) => {
    const map = mapRef.current;
    if (!map) return;
    const L = require('leaflet');

    clearOrderLayer();
    orderLayerRef.current = L.layerGroup().addTo(map);

    const props = feature?.properties || {};
    const order = props.optimized_order || [];
    const dests = props.destinations || [];
    if (!order.length || !dests.length) return;

    order.forEach((idx, i) => {
      const d = dests[idx];
      if (!d) return;
      const el = document.createElement('div');
      el.className = 'bg-indigo-600 text-white text-[10px] font-bold rounded-full w-5 h-5 grid place-items-center border border-white shadow';
      el.innerText = String(i + 1);
      const icon = L.divIcon({ html: el, className: 'order-badge', iconSize: [20, 20] });
      L.marker([d.lat, d.lon], { icon }).addTo(orderLayerRef.current);
    });
  };

  const handleCalculate = async () => {
    setErrorMsg("");
    setRouting(true);
    setOptimized(false);
    try {
    // --- Resolve origin
    let originCoords = null;
    if (originId === "__current_location__") {
      originCoords = geo || (await ensureGeolocation());
      if (!originCoords) return;
    } else {
      const o = locations.find((l) => l.id === originId);
      if (!o) {
        setErrorMsg("Select a valid origin.");
        return;
      }
      originCoords = { lat: +o.latitude, lng: +o.longitude };
    }

    // --- Resolve destinations
    const destRows = destIds.map((id) => locations.find((l) => l.id === id)).filter(Boolean);
    if (destRows.length === 0) {
      setErrorMsg("Select at least one destination.");
      return;
    }
    if (destIds.includes(originId)) {
      setErrorMsg("Origin cannot also be a destination.");
      return;
    }
    const destCoordsList = destRows.map((r) => ({ lat: +r.latitude, lng: +r.longitude }));

    // --- Try backend first (when enabled)
    if (ROUTER_MODE === "backend") {
      try {
        const feature = await callBackendOptimizeRoute(
           originCoords,
           destCoordsList,
           vehicleId,
           vehicleType,
           originId,
           destIds,
           engine,
           driverAge
         );
        lastFeatureRef.current = feature;
        showOptimizedOrderBadges(feature);

        // analytics (prefer ML if available)
        const props = feature?.properties || {};
        const sum   = props.summary || {};
        const km    = (sum.distance || 0) / 1000;

        const mlMin = props.eta_minutes_ml;             // minutes (number)
        const mlIso = props.eta_completion_time_ml;     // ISO string

        setDistanceKm(km);
        let minutes;
        if (typeof mlMin === "number") {
          minutes = mlMin;
          setEta(mlIso ? new Date(mlIso) : new Date(Date.now() + mlMin * 60 * 1000));
        } else {
          minutes = (sum.duration || 0) / 60;
          setEta(new Date(Date.now() + (sum.duration || 0) * 1000));
        }
        setDurationMin(minutes);
        setLastUpdated(Date.now());
        setOptimized((feature?.properties?.optimized_order?.length || 0) > 1);
        setSaved(Boolean(feature?.properties?.request_id));

        // steps
        setRouteSteps(stepsFromORS(feature));

        // summary header
        const oName =
          originId === "__current_location__"
            ? "My Current Location"
            : locations.find((l) => l.id === originId)?.name || "Origin";
        const firstDest = destRows[0]?.name || "Destination";
        const label = destRows.length === 1 ? firstDest : `${firstDest} + ${destRows.length - 1} more`;
        setRouteSummary({ originName: oName, destName: label, km, min: minutes });

        // draw polyline
        const coords = feature?.geometry?.coordinates || []; // [lon, lat]
        const latlngs = coords.map(([lon, lat]) => [lat, lon]);
        const L = require("leaflet");
        const map = mapRef.current;
        if (!map) return;
        if (routeLayerRef.current) map.removeLayer(routeLayerRef.current);
        routeLayerRef.current = L.polyline(latlngs, { weight: 5, opacity: 0.95 }).addTo(map);
        fullRouteRef.current = routeLayerRef.current;
        map.fitBounds(routeLayerRef.current.getBounds().pad(0.2));
        setTimeout(() => map.invalidateSize(), 0);
        return; // success via backend; skip OSRM
      } catch (err) {
        console.error(err);
        setToast({ type: "info", message: "Backend unavailable — fell back to OSRM." });
        // fall through to OSRM below
      }
    }

    // --- OSRM path (fallback or when ROUTER_MODE !== 'backend')
    lastFeatureRef.current = null; // OSRM result isn't used by simulator
    const base = process.env.NEXT_PUBLIC_OSRM_URL || "https://router.project-osrm.org";
    const coordsSeq = [
      `${originCoords.lng},${originCoords.lat}`,
      ...destCoordsList.map((p) => `${p.lng},${p.lat}`),
    ].join(";");
    const url = `${base}/route/v1/driving/${coordsSeq}?overview=full&geometries=geojson&steps=true`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("OSRM request failed");
    const json = await res.json();
    const route = json?.routes?.[0];
    if (!route) throw new Error("No route found");

    setOptimized(false);

    const km = route.distance / 1000;
    const minutes = route.duration / 60;
    setDistanceKm(km);
    setDurationMin(minutes);
    setEta(new Date(Date.now() + route.duration * 1000));
    setLastUpdated(Date.now());

    const steps = [];
    (route.legs || []).forEach((leg) => {
      (leg.steps || []).forEach((s) => {
        steps.push({
          maneuver: s.maneuver?.type || "",
          name: s.name || "Unnamed road",
          distance: s.distance,
          duration: s.duration,
        });
      });
    });
    setRouteSteps(steps);

    const oName =
      originId === "__current_location__"
        ? "My Current Location"
        : locations.find((l) => l.id === originId)?.name || "Origin";
    const firstDest = destRows[0]?.name || "Destination";
    const label = destRows.length === 1 ? firstDest : `${firstDest} + ${destRows.length - 1} more`;
    setRouteSummary({ originName: oName, destName: label, km, min: minutes });

    const coords = route.geometry?.coordinates || [];
    const latlngs = coords.map(([lng, lat]) => [lat, lng]);
    const L = require("leaflet");
    const map = mapRef.current;
    if (!map) return;
    if (routeLayerRef.current) map.removeLayer(routeLayerRef.current);
    routeLayerRef.current = L.polyline(latlngs, { weight: 5, opacity: 0.95 }).addTo(map);
    map.fitBounds(routeLayerRef.current.getBounds().pad(0.2));
    setTimeout(() => map.invalidateSize(), 0);
  } catch (e) {
    console.error(e);
    setErrorMsg(e?.message || "Routing failed. Please try again.");
  } finally {
    setRouting(false);
  }
};

  const canCalculate = Boolean(originId && destIds.length > 0);

    // --- helpers used by SSE ---
  const lonlatToLatLng = (pair) => (Array.isArray(pair) && pair.length >= 2 ? [pair[1], pair[0]] : null);

  const downloadJson = (obj, filename = 'route.geojson') => {
    if (!obj) return;
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const backoffMs = (n) => {
    const base = Math.min(1000 * (2 ** n), 20000); // 1s, 2s, 4s, ... max 20s
    const jitter = Math.floor(Math.random() * 250);
    return base + jitter;
  };

  const stopTracking = () => {
    desiredChannelRef.current = null;   // <- stops auto-reconnect
    clearReconnectTimer();

    try { sseRef.current?.close?.(); } catch {}
    sseRef.current = null;

    // clear markers/lines
    const map = mapRef.current;
    if (map) {
      if (trackerMarkerRef.current) map.removeLayer(trackerMarkerRef.current);
      if (progressDoneRef.current)  map.removeLayer(progressDoneRef.current);
      if (progressRemainRef.current) map.removeLayer(progressRemainRef.current);
    }
    trackerMarkerRef.current = null;
    progressDoneRef.current = null;
    progressRemainRef.current = null;

    setTracking(false);
    setConnStatus('idle');
    setRetries(0);
  };

  const startTracking = (channel) => {
    if (!channel) {
      setToast({ type: 'info', message: 'Set a channel (use Vehicle ID or type one).' });
      return;
    }

    // If already connecting/connected to the same channel, ignore
    if (desiredChannelRef.current === channel && (connecting || connected)) return;

    // Reset and mark desire to stay connected
    stopTracking();
    desiredChannelRef.current = channel;
    setConnStatus('connecting');
    setTracking(true);

    const openEventSource = () => {
      // Make sure we still want to connect
      if (!desiredChannelRef.current) return;

      const url = `${SSE_BASE}/api/realtime_feed?channel=${encodeURIComponent(desiredChannelRef.current)}`;
      const es = new EventSource(url);
      sseRef.current = es;

      es.onopen = () => {
        setConnStatus('connected');
        setRetries(0);
        setToast?.({ type: 'info', message: `SSE connected: ${desiredChannelRef.current}` });
      };

      es.onmessage = (ev) => {
        setLastSseAt(Date.now());
        try {
          const payload = JSON.parse(ev.data);

          // --- marker update
          const next = (payload.remaining_routes && payload.remaining_routes[0]) || null;
          const latlng = lonlatToLatLng(next);
          const map = mapRef.current;
          if (map && latlng) {
            const L = require('leaflet');
            if (!trackerMarkerRef.current) {
              trackerMarkerRef.current = L.circleMarker(latlng, { radius: 6, opacity: 0.95 })
                .addTo(map)
                .bindTooltip('Live tracker', { direction: 'top', offset: [0, -8] });
            } else {
              trackerMarkerRef.current.setLatLng(latlng);
            }
          }

          // --- progress lines
          const feature = lastFeatureRef.current;
          const all = feature?.geometry?.coordinates || [];
          const rem = payload.remaining_routes || [];
          if (map && all.length > 0) {
            const { done, remaining } = splitProgressByRemaining(all, rem);
            const L = require('leaflet');

            if (!progressDoneRef.current) {
              progressDoneRef.current  = L.polyline(done, { weight: 6, opacity: 0.9, color: '#16a34a' }).addTo(map);
            } else {
              progressDoneRef.current.setLatLngs(done);
            }
            if (!progressRemainRef.current) {
              progressRemainRef.current = L.polyline(remaining, { weight: 6, opacity: 0.4, dashArray: '6,6', color: '#334155' }).addTo(map);
            } else {
              progressRemainRef.current.setLatLngs(remaining);
            }
          }
        } catch (e) {
          console.warn('SSE parse error:', e);
        }
      };

      es.onerror = () => {
        // If user manually stopped, do nothing
        if (!desiredChannelRef.current) return;

        // Close current es and schedule a backoff reconnect
        try { es.close(); } catch {}
        sseRef.current = null;

        setConnStatus('error');
        setRetries((n) => {
          const next = n + 1;
          const delay = backoffMs(next);
          clearReconnectTimer();
          reconnectTimerRef.current = setTimeout(openEventSource, delay);
          return next;
        });
      };
    };

    openEventSource();
  };

  const handleSimulate = async () => {
    if (!lastFeatureRef.current) {
      setToast({ type: 'info', message: 'Compute a route via backend first.' });
      return;
    }
    try {
      const res = await fetch(`${ROUTE_API_BASE}/confirm_route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driver_details: {
            driver_name: (sseChannel || vehicleId || 'Driver-1'),
            vehicle_type: (typeof vehicleType === 'string' ? vehicleType : 'car'),
          },
          route_details: lastFeatureRef.current,
        }),
      });
      if (!res.ok) throw new Error(`Simulate failed (${res.status})`);
      setToast({ type: 'info', message: 'Simulation started. Connecting SSE…' });
      startTracking(sseChannel || vehicleId || 'Driver-1');
    } catch (e) {
      setToast({ type: 'error', message: e.message || 'Simulation failed' });
    }
  };

  // ---- Render
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 to-slate-100 text-slate-900">
      {/* Header */}
      <div className="sticky top-0 z-[1000] border-b bg-white backdrop-blur-md shadow-sm shrink-0">
        <div className="mx-auto max-w-screen-2xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-yellow-400 flex items-center justify-center shadow">
              <MapIcon className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight">Routest</h1>
              <p className="text-xs text-slate-500 -mt-1">Real-time route optimization dashboard</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {errorMsg && <span className="text-sm text-red-600">{errorMsg}</span>}
              <div className="flex items-center gap-3 text-xs">
                <StatusDot
                  ok={health?.backend?.ok}
                  label="Backend"
                  title={health?.backend?.status ? `HTTP ${health.backend.status}` : ''}
                />
                <StatusDot
                  ok={health?.osrm?.ok}
                  label="OSRM"
                  title={
                    health?.osrm?.status
                      ? `HTTP ${health.osrm.status} / ${health?.osrm?.distanceKm?.toFixed?.(1) ?? '--'} km`
                      : ''
                  }
                />
                <StatusDot
                  ok={health?.supabase?.ok}
                  label="DB"
                  title={health?.supabase?.total != null ? `${health.supabase.total} rows` : ''}
                />
                <StatusDot
                  ok={health?.tiles?.osm?.ok && health?.tiles?.carto?.ok}
                  label="Tiles"
                  title={`OSM:${health?.tiles?.osm?.status ?? '?'} Carto:${health?.tiles?.carto?.status ?? '?'}`}
                />
              </div>
            <span className="text-sm text-slate-500" aria-live="polite">
              Last Updated: {lastUpdated ? new Date(lastUpdated).toLocaleString() : "—"}
            </span>
              <Link
                href="/ui/history"
                target="_blank"
                rel="noopener noreferrer"
                prefetch={false}
                className="hidden md:flex items-center justify-center w-28 h-10 rounded-xl bg-white border shadow-sm text-sm hover:bg-slate-50"
              >
                History
              </Link>
              <Link
                href="/ui/dashboard"
                className="hidden md:flex items-center justify-center w-28 h-10 rounded-xl bg-white border shadow-sm text-sm hover:bg-slate-50"
              >
                Dashboard
              </Link>
            <button className="hidden md:flex items-center justify-center w-10 h-10 rounded-xl bg-white border shadow-sm">
              <SettingsIcon className="w-5 h-5" />
            </button>
            <button className="hidden md:flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-600 text-white shadow">
              <UserIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toasts (fixed inside header area to avoid map overlap) */}
        <div className="pointer-events-none fixed top-4 right-4 z-[1100] space-y-2">
          {toast && (
            <Toast
              type={toast.type}
              onClose={() => setToast(null)}
            >
              {toast.message}
            </Toast>
          )}
        </div>
      </div>

      {/* Main takes the rest of the viewport; inner grid fills it */}
      <main className="flex-1 min-h-0">
        <div className="mx-auto max-w-screen-2xl px-6 py-6 grid grid-cols-1 md:grid-cols-12 gap-6 h-full min-h-0">
          {/* LEFT PANE */}
          <aside className="bg-white rounded-3xl border shadow-lg p-6 space-y-6 overflow-y-auto sticky top-24 max-h-[calc(100vh-160px)] md:col-span-4 lg:col-span-4 xl:col-span-3 min-h-0">
            {/* Brand */}
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-yellow-400 flex items-center justify-center shadow">
                <TruckIcon />
              </div>
              <div>
                <h2 className="text-xl font-extrabold tracking-tight">Thumbworx</h2>
                <p className="text-sm text-slate-600 font-medium">Predictive Route Estimation</p>
              </div>
            </div>

            {/* Loading locations pill */}
            {loadingLocations && (
              <div
                className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 bg-slate-100 border border-slate-200 rounded-full px-3 py-1"
                role="status"
                aria-live="polite"
              >
                <span className="h-2 w-2 rounded-full bg-slate-400 animate-pulse" />
                Loading locations…
              </div>
            )}

              {/* Search */}
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">
                  Search locations
                </label>
                <div className="relative">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search by name…"
                    className="w-full px-4 py-3 rounded-2xl border bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 pr-10"
                  />
                  {q && (
                    <button
                      type="button"
                      onClick={() => setQ("")}
                      className="absolute inset-y-0 right-0 px-3 text-slate-400 hover:text-slate-600"
                      aria-label="Clear search"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {filteredLocations.length} match{filteredLocations.length === 1 ? "" : "es"}
                </div>
              </div>
              
            {/* Inputs */}
            <div className="space-y-5">
              {/* Origin */}
              <div>
                <label htmlFor="origin-select" className="block text-sm font-semibold text-slate-700 mb-2">
                  From
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
                    <MapPinIcon className="w-5 h-5" />
                  </div>
                  <select
                    id="origin-select"
                    value={originId}
                    onChange={(e) => setOriginId(e.target.value)}
                    disabled={loadingLocations}
                    aria-disabled={loadingLocations}
                    className="w-full pl-12 pr-4 py-4 rounded-2xl border bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:opacity-60"
                  >
                    <option value="" disabled>
                      {loadingLocations ? "Loading…" : "Select origin…"}
                    </option>
                    <option value="__current_location__">My Current Location</option>
                    {filteredLocations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Destinations (multi) */}
              <div>
                <label htmlFor="destinations-select" className="block text-sm font-semibold text-slate-700 mb-2">
                  To (select up to {MAX_STOPS})
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
                    <NavigationIcon className="w-5 h-5" />
                  </div>
                    <select
                      multiple
                      size={Math.min(6, Math.max(3, filteredLocations.length))}
                      id="destinations-select"
                      value={destIds}
                      onChange={(e) => {
                        const vals = getSelectedValues(e.target)
                          .filter(v => v)                      // no blanks
                          .filter(v => v !== originId);        // prevent selecting origin as a stop
                        if (vals.length > MAX_STOPS) {
                          setToast({ type: "info", message: `Max ${MAX_STOPS} stops.` });
                          return;
                        }
                        setDestIds(vals);
                      }}
                      disabled={loadingLocations}
                      aria-disabled={loadingLocations}
                      className="w-full pl-12 pr-4 py-4 rounded-2xl border bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 disabled:opacity-60"
                    >
                      {filteredLocations.map((l) => (
                        <option key={l.id} value={l.id} disabled={l.id === originId}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  Selected stops: <span className="font-medium">{destIds.length}</span> / {MAX_STOPS}
                </div>
              </div>

              {/* Vehicle ID */}
              <div>
                <label htmlFor="vehicle-id" className="block text-sm font-semibold text-slate-700 mb-2">
                  Vehicle ID
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
                    <CarIcon className="w-5 h-5" />
                  </div>
                  <input
                    id="vehicle-id"
                    value={vehicleId}
                    onChange={(e) => setVehicleId(e.target.value)}
                    placeholder="e.g., TRUCK-12"
                    className="w-full pl-12 pr-4 py-4 rounded-2xl border bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  />
                </div>
              </div>
            </div>

              {/* Vehicle Type */}
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">
                  Vehicle Type
                </label>
                <select
                  value={vehicleType}
                  onChange={(e) => setVehicleType(e.target.value)}
                  className="w-full px-4 py-3 rounded-2xl border bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                >
                  {['car','hgv','bike','roadbike','foot'].map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
                {/* Prediction Engine */}
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">
                    Prediction Engine
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEngine("default")}
                      aria-pressed={engine === "default"}
                      className={`px-3 py-2 rounded-xl border shadow-sm ${
                        engine === "default" ? "bg-slate-900 text-white border-slate-900" : "bg-white hover:bg-slate-50"
                      }`}
                    >
                      Default (Routing)
                    </button>
                    <button
                      type="button"
                      onClick={() => setEngine("ml")}
                      aria-pressed={engine === "ml"}
                      className={`px-3 py-2 rounded-xl border shadow-sm ${
                        engine === "ml" ? "bg-slate-900 text-white border-slate-900" : "bg-white hover:bg-slate-50"
                      }`}
                    >
                      ML (XGBoost ETA)
                    </button>
                  </div>

                  {/* Driver Age */}
                  <div className="mt-3">
                    <label className="block text-sm font-semibold text-slate-700 mb-2">
                      Driver Age
                    </label>
                    <input
                      type="number"
                      min={16}
                      max={85}
                      value={driverAge}
                      onChange={(e) => setDriverAge(parseInt(e.target.value || "30", 10))}
                      className="w-32 px-3 py-2 rounded-xl border bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                    />
                  </div>
                </div>
            {/* Filters */}
            <div>
              <div className="text-sm font-semibold text-slate-700 mb-2">Filters</div>
              <div className="flex gap-2">
                {[
                  { key: "all", label: "All" },
                  { key: "mall", label: "Malls" },
                  { key: "warehouse", label: "Warehouse" },
                ].map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    aria-pressed={filter === f.key}
                    className={`px-3 py-1.5 rounded-full border text-sm transition ${
                      filter === f.key
                        ? "bg-indigo-600 text-white border-indigo-600"
                        : "bg-white hover:bg-slate-50"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Action */}
            <div className="pt-2">
              <button
                type="button"
                disabled={!canCalculate || routing}
                onClick={handleCalculate}
                className={`w-full rounded-2xl px-4 py-4 font-semibold shadow-md transition ${
                  canCalculate && !routing
                    ? "bg-gradient-to-r from-yellow-400 to-orange-500 text-white hover:opacity-95"
                    : "bg-slate-200 text-slate-500 cursor-not-allowed"
                }`}
              >
                {routing ? "Calculating…" : "⚡ Calculate Route"}
              </button>
              <div className="mt-3 text-xs text-slate-500">
                Last Updated <span className="font-medium">{lastUpdated ? "Just now" : "—"}</span>
              </div>
            </div>
            
          {/* Live tracker + export */}
          <div className="mt-6 space-y-3">
            <div className="text-sm font-semibold text-slate-700">Live Tracker (SSE)</div>
              <span className="flex items-center gap-2 text-xs text-slate-600">
                <span className={`inline-block w-2 h-2 rounded-full ${
                  connected ? 'bg-green-500' : connecting ? 'bg-amber-500' : 'bg-slate-400'
                }`} />
                {connected ? 'Connected' : connecting ? 'Connecting…' : 'Disconnected'}
                <span className="text-slate-400">•</span>
                <span title={lastSseAt ? new Date(lastSseAt).toLocaleString() : ''}>
                  Last msg: {lastSseAt ? new Date(lastSseAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '—'}
                </span>
              </span>
            {/* make the row wrap and keep buttons visible */}
            <div className="flex flex-wrap gap-2">
              <input
                value={sseChannel}
                onChange={(e) => setSseChannel(e.target.value)}
                placeholder="Channel (defaults to Vehicle ID)"
                className="flex-[1_1_220px] min-w-[160px] px-3 py-2 rounded-xl border bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
              />
              <button
                type="button"
                onClick={() => startTracking(sseChannel || vehicleId)}
                disabled={connecting || connected}
                className={`shrink-0 px-3 py-2 rounded-xl border shadow-sm ${
                  (connecting || connected) ? 'opacity-50 cursor-not-allowed' : 'bg-white hover:bg-slate-50'
                }`}
              >
                {connecting ? 'Connecting…' : 'Connect'}
              </button>

              <button
                type="button"
                onClick={stopTracking}
                disabled={!connecting && !connected}
                className={`shrink-0 px-3 py-2 rounded-xl border shadow-sm ${
                  (!connecting && !connected) ? 'opacity-50 cursor-not-allowed' : 'bg-white hover:bg-slate-50'
                }`}
              >
                Disconnect
              </button>

            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleSimulate}
                disabled={!lastFeatureRef.current || ROUTER_MODE !== 'backend'}
                className={`flex-1 min-w-[160px] px-3 py-2 rounded-xl border shadow-sm ${
                  (!lastFeatureRef.current || ROUTER_MODE !== 'backend') ? 'opacity-50 cursor-not-allowed' : 'bg-white hover:bg-slate-50'
                }`}
                title={ROUTER_MODE !== 'backend' ? 'Run backend route first' : ''}
              >
                ▶ Simulate
              </button>
              <button
                type="button"
                onClick={() => downloadJson(lastFeatureRef.current, 'route.geojson')}
                disabled={!lastFeatureRef.current}
                className={`flex-1 min-w-[160px] px-3 py-2 rounded-xl border shadow-sm ${
                  !lastFeatureRef.current ? 'opacity-50 cursor-not-allowed' : 'bg-white hover:bg-slate-50'
                }`}
              >
                ⤓ Export GeoJSON
              </button>
            </div>
          </div>
          </aside>

          {/* RIGHT PANE — fill height; inner div is the ONLY scroller */}
          <section className="md:col-span-8 lg:col-span-8 xl:col-span-9 min-h-0 flex">
            <div
              id="right-pane-scroll"
              className="flex-1 flex flex-col min-h-0 overflow-y-auto overscroll-contain pb-6"
            >
              {/* Map Card */}
              <div
                id="map-container"
                className="relative z-0 overflow-hidden rounded-3xl bg-gradient-to-br from-gray-50 to-white shadow-inner border-4 border-white/30"
                aria-busy={routing}
              >
                <div id="leaflet-map" className="w-full h-[50vh] md:h-[55vh] xl:h-[60vh] rounded-3xl" />
                {!mapReady && (
                  <div
                    id="map-placeholder"
                    className="absolute inset-0 bg-gradient-to-br from-blue-50/30 to-green-50/30 flex items-center justify-center"
                  >
                    <div className="flex flex-col items-center space-y-4">
                      <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center shadow-lg">
                        <MapIcon className="w-10 h-10 text-gray-400" />
                      </div>
                      <div>
                        <p className="font-semibold text-lg text-gray-600">Loading Map...</p>
                        <p className="text-sm text-gray-500">Initializing Leaflet.js</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Routing overlay spinner */}
                {routing && (
                  <div className="absolute inset-0 bg-white/40 backdrop-blur-sm grid place-items-center" role="status">
                    <div className="h-10 w-10 rounded-full border-4 border-slate-300 border-t-indigo-600 animate-spin" />
                  </div>
                )}
              </div>

              {/* Analytics */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <DashboardCard
                  title="ETA"
                  icon={<ClockIcon />}
                  value={<span id="eta-value" className="text-3xl font-bold text-gray-900">{etaText}</span>}
                  hint="minutes remaining"
                />
                <DashboardCard
                  title="DURATION"
                  icon={<TimerIcon />}
                  value={<span id="duration-value" className="text-3xl font-bold text-gray-900">{durationText}</span>}
                  hint="total hours"
                />
                <DashboardCard
                  title="DISTANCE"
                  icon={<RouteIcon />}
                  value={<span id="distance-value" className="text-3xl font-bold text-gray-900">{distanceText ?? "--"}</span>}
                  hint="kilometers"
                />
              </div>

              {/* Route Details */}
              <div className="bg-white rounded-3xl border shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b flex items-center justify-between">
                  <div className="text-base font-semibold">Route Details</div>
                  <div className="flex items-center gap-2">
                    {saved && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                        ✓ Saved
                      </span>
                    )}
                    {optimized && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 text-xs font-medium"
                        title="Optimized stop order applied"
                      >
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        Optimized
                      </span>
                    )}
                    {engine === "ml" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 text-xs font-medium">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500" />
                        ML ETA
                      </span>
                    )}
                    <span className="text-xs text-slate-500">Summary &amp; Steps</span>
                  </div>
                </div>

                {/* internal scroller so very long step lists don't balloon the page */}
                <div className="max-h-[45vh] overflow-y-auto">
                  {routeSummary ? (
                    <div className="px-6 py-4 space-y-3">
                      <div className="text-sm font-medium">
                        {routeSummary.originName} → {routeSummary.destName}
                      </div>
                      <div className="text-xs text-slate-500">
                        {routeSummary.km.toFixed(1)} km • {Math.round(routeSummary.min)} min
                      </div>
                      <ol className="mt-2 space-y-1 text-sm text-slate-700">
                        {routeSteps.map((s, idx) => (
                          <li key={idx} className="flex items-center gap-3">
                            <StepIcon type={s.maneuver} modifier={s.modifier} />
                            <span className="flex-1">
                              <span className="font-medium capitalize">{displayManeuver(s.maneuver, s.modifier)}</span>{" "}
                              <span className="text-slate-600">{s.name}</span>
                            </span>
                            <span className="text-xs text-slate-500 tabular-nums">
                              {(s.distance / 1000).toFixed(2)} km • {Math.round(s.duration / 60)} m
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : (
                    <div className="px-6 py-12 text-center text-slate-500">
                      <div className="mx-auto w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                        <RouteIcon className="w-6 h-6" />
                      </div>
                      <div className="font-semibold">Route Analysis Ready</div>
                      <div className="text-sm">Detailed breakdown will appear after route calculation</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

/* ---------- Small components & icons (inline SVGs) ---------- */

function DashboardCard({ title, icon, value, hint }) {
  return (
    <div className="bg-white rounded-3xl border shadow hover:shadow-md transition p-5 flex items-center gap-4">
      <div className="w-12 h-12 rounded-2xl bg-white shadow flex items-center justify-center border">
        {icon}
      </div>
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{title}</p>
        </div>
        <div className="space-y-1">
          {value}
          <p className="text-sm text-gray-600">{hint}</p>
        </div>
      </div>
    </div>
  );
}

function StatusDot({ ok, label, title }) {
  const color =
    ok === true ? "bg-green-500" :
    ok === false ? "bg-red-500" :
    "bg-slate-400";

  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-600" title={title || ""}>
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

/** Step icon for route maneuvers (tiny inline SVGs) */
function StepIcon({ type = "", modifier = "" }) {
  const t = type.toLowerCase();
  const m = (modifier || "").toLowerCase();

  // simple directional helpers
  const isLeft = m.includes("left");
  const isRight = m.includes("right");
  const isUTurn = m.includes("uturn") || m === "uturn";

  // Base icon props
  const cls = "w-4 h-4 text-slate-600";

  // TURN (left/right/straight/u-turn)
  if (t === "turn" || t === "new name" || t === "continue" || t === "end of road") {
    if (isLeft) return <TurnLeftIcon className={cls} />;
    if (isRight) return <TurnRightIcon className={cls} />;
    if (isUTurn) return <UTurnIcon className={cls} />;
    return <StraightIcon className={cls} />;
  }

  // MERGE / FORK / RAMPS
  if (t === "merge") return <MergeIcon className={cls} direction={isLeft ? "left" : isRight ? "right" : "right"} />;
  if (t === "fork") return <ForkIcon className={cls} direction={isLeft ? "left" : isRight ? "right" : "right"} />;
  if (t === "on ramp" || t === "off ramp") {
    return <RampIcon className={cls} direction={isLeft ? "left" : isRight ? "right" : "right"} />;
  }

  // ROUNDABOUT / ROTARY
  if (t === "roundabout" || t === "rotary" || t === "exit roundabout" || t === "exit rotary" || t === "roundabout turn") {
    return <RoundaboutIcon className={cls} />;
  }

  if (t === "depart") return <DepartIcon className={cls} />;
  if (t === "arrive") return <ArriveIcon className={cls} />;


  // fallback
  return <DotIcon className={cls} />;
}

function displayManeuver(type = "", modifier = "") {
  const t = type ? type.replace(/_/g, " ") : "";
  if (!modifier) return t || "step";
  return `${t} ${modifier}`.trim();
}

/* ---- Tiny SVGs ---- */
function DotIcon({ className }) {
  return <span className={`inline-block w-2 h-2 rounded-full bg-slate-400 ${className || ""}`} />;
}
function StraightIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V6" />
      <path d="M8 10l4-4 4 4" />
    </svg>
  );
}
function TurnLeftIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V8a4 4 0 0 0-4-4H6" />
      <path d="M8 6L4 2 0 6" transform="translate(6,0)" />
    </svg>
  );
}
function TurnRightIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V8a4 4 0 0 1 4-4h2" />
      <path d="M16 6l4-4 4 4" transform="translate(-2,0)" />
    </svg>
  );
}
function UTurnIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V10a4 4 0 1 0-8 0v6" />
      <path d="M8 8l-4-4-4 4" transform="translate(8,0)" />
    </svg>
  );
}
function MergeIcon({ className, direction = "right" }) {
  const d = direction === "left" ? -1 : 1;
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={`M12 22V12`} />
      <path d={`M12 12c0-4 3-6 6-6`} transform={`scale(${d},1) translate(${d === -1 ? -24 : 0},0)`} />
    </svg>
  );
}
function ForkIcon({ className, direction = "right" }) {
  const d = direction === "left" ? -1 : 1;
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V14" />
      <path d="M12 14c0-4 3-6 6-6" transform={`scale(${d},1) translate(${d === -1 ? -24 : 0},0)`} />
      <path d="M12 14c0-4-3-6-6-6" transform={`scale(${d},1) translate(${d === -1 ? -24 : 0},0)`} />
    </svg>
  );
}
function RampIcon({ className, direction = "right" }) {
  const d = direction === "left" ? -1 : 1;
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V6" />
      <path d="M12 10c3 0 6-2 6-6" transform={`scale(${d},1) translate(${d === -1 ? -24 : 0},0)`} />
    </svg>
  );
}
function RoundaboutIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v3M23 12h-3M12 23v-3M1 12h3" />
    </svg>
  );
}
function DepartIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h18" />
      <path d="M12 21v-8" />
      <path d="M8 16l4-4 4 4" />
    </svg>
  );
}
function ArriveIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h18" />
      <path d="M12 13v8" />
      <path d="M16 18l-4 4-4-4" />
    </svg>
  );
}

function TruckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 17h4a1 1 0 0 0 1-1v-5H3v6a1 1 0 0 0 1 1h1" />
      <path d="M14 11h3l3 3v2a1 1 0 0 1-1 1h-2" />
      <circle cx="7.5" cy="17.5" r="1.5" />
      <circle cx="16.5" cy="17.5" r="1.5" />
    </svg>
  );
}
function MapIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="1 6 9 2 15 6 23 2 23 18 15 22 9 18 1 22 1 6"></polygon>
      <line x1="9" y1="2" x2="9" y2="18"></line>
      <line x1="15" y1="6" x2="15" y2="22"></line>
    </svg>
  );
}
function SettingsIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6l-.09.1a2 2 0 1 1-3.32 0l-.09-.1a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 1 1 4.49 17l.06-.06A1.65 1.65 0 0 0 5 15.1a1.65 1.65 0 0 0-.6-1l-.1-.09a2 2 0 1 1 0-3.32l.1-.09a1.65 1.65 0 0 0 .6-1A1.65 1.65 0 0 0 4.49 6l-.06-.06A2 2 0 1 1 7.37 3.1l.06.06c.46.46 1.09.67 1.72.57a1.65 1.65 0 0 0 1-.6l.09-.1a2 2 0 1 1 3.32 0l.09.1a1.65 1.65 0 0 0 1 .6c.63.1 1.26-.11 1.72-.57l.06-.06A2 2 0 1 1 19.51 6l-.06.06c-.46.46-.67 1.09-.57 1.72.1.39.31.74.6 1l.1.09a1.65 1.65 0 0 0 .6 1c.2.17.44.3.7.4z"></path>
    </svg>
  );
}
function UserIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M4 21v-2a4 4 0 0 1 3-3.87"></path>
      <circle cx="12" cy="7" r="4"></circle>
    </svg>
  );
}
function MapPinIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1 1 18 0z"></path>
      <circle cx="12" cy="10" r="3"></circle>
    </svg>
  );
}
function NavigationIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
    </svg>
  );
}
function CarIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 16h4"></path>
      <path d="M2 12h2l3-6h10l3 6h2"></path>
      <circle cx="7" cy="16" r="2"></circle>
      <circle cx="17" cy="16" r="2"></circle>
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-6 h-6 text-orange-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}
function TimerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="10" x2="14" y1="2" y2="2" />
      <line x1="12" x2="12" y1="14" y2="10" />
      <circle cx="12" cy="14" r="8" />
    </svg>
  );
}
function RouteIcon(props) {
  return (
    <svg viewBox="0 0 24 24" {...props} className={"w-6 h-6 text-green-600"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="19" r="3" />
      <circle cx="18" cy="5" r="3" />
      <path d="M9 18H7a4 4 0 0 1-4-4V5" />
      <path d="M15 6h2a4 4 0 0 1 4 4v9" />
    </svg>
  );
}

/** Toast component */
function Toast({ type = "info", children, onClose }) {
  return (
    <div className="pointer-events-auto flex items-start gap-3 rounded-xl border bg-white px-4 py-3 shadow-lg">
      <div className={`mt-0.5 h-2.5 w-2.5 rounded-full ${type === "error" ? "bg-red-500" : "bg-slate-500"}`} />
      <div className="text-sm text-slate-800">{children}</div>
      <button
        onClick={onClose}
        className="ml-2 text-slate-400 hover:text-slate-600"
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}

function toLonLat({ lat, lng }) {
  return { lat, lon: lng };
}

function stepsFromORS(feature) {
  const segments = feature?.properties?.segments || [];
  const steps = [];
  segments.forEach(seg => {
    (seg.steps || []).forEach(s => {
      steps.push({
        maneuver: s.instruction || s.type || "step",
        name: s.name || "—",
        distance: s.distance,   // meters
        duration: s.duration,   // seconds
      });
    });
  });
  if (steps.length === 0 && feature?.properties?.summary) {
    const sum = feature.properties.summary;
    steps.push({
      maneuver: "segment",
      name: "Route",
      distance: sum.distance,
      duration: sum.duration,
    });
  }
  return steps;
}

function getSelectedValues(selectEl) {
  return Array.from(selectEl.selectedOptions).map(o => o.value);
}

function splitProgressByRemaining(allLonLat = [], remainingLonLat = []) {
  // We assume remaining is a suffix of the full path from simulate_route.
  const remLen = remainingLonLat.length;
  const doneLen = Math.max(0, allLonLat.length - remLen);
  const done = allLonLat.slice(0, doneLen).map(([lon, lat]) => [lat, lon]);
  const remaining = allLonLat.slice(doneLen).map(([lon, lat]) => [lat, lon]);
  return { done, remaining };
}

function showOptimizedOrderBadges(feature) {
  const map = mapRef.current;
  if (!map) return;
  const L = require('leaflet');

  // clear old
  if (orderLayerRef.current) {
    try { map.removeLayer(orderLayerRef.current); } catch {}
  }
  orderLayerRef.current = L.layerGroup().addTo(map);

  const props = feature?.properties || {};
  const order = props.optimized_order || [];
  const dests = props.destinations || [];
  if (!order.length || !dests.length) return;

  order.forEach((idx, i) => {
    const d = dests[idx];
    if (!d) return;
    const el = document.createElement('div');
    el.className = 'bg-indigo-600 text-white text-[10px] font-bold rounded-full w-5 h-5 grid place-items-center border border-white shadow';
    el.innerText = (i + 1).toString();
    const icon = L.divIcon({ html: el, className: 'order-badge', iconSize: [20, 20] });
    L.marker([d.lat, d.lon], { icon }).addTo(orderLayerRef.current);
  });
}

async function callBackendOptimizeRoute(
  originCoords,
  destCoordsList,
  vehicleId,
  vehicleType,
  originIdValue,
  destIdsValue,
  engine,         // NEW
  driverAge       // NEW
) {
  const payload = {
    source_point: toLonLat(originCoords),
    destination_points: destCoordsList.map(c => ({ ...toLonLat(c), payload: 1 })),
    driver_details: {
      driver_name: vehicleId || "Driver-1",
      vehicle_type: vehicleType || "car",
      vehicle_capacity: 9999,
      maximum_distance: 100000,
      driver_age: Number.isFinite(+driverAge) ? +driverAge : 30, // NEW
    },
    meta: {
      origin_id: originIdValue === "__current_location__" ? null : originIdValue,
      destination_ids: destIdsValue,
      vehicle_id: vehicleId || null
    },
    // ML toggle + optional context (backend reads when use_ml_eta=true)
    use_ml_eta: engine === "ml",                           // NEW
    context: engine === "ml" ? { weather: "Sunny", traffic: "Medium" } : undefined, // NEW
  };

  const res = await fetch(`${ROUTE_API_BASE}/optimize_route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || "Optimize route failed");
  return json;
}

// Basic HTML escaping for popup strings
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}