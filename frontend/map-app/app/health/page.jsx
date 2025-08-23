'use client';
import { useEffect, useState } from 'react';

export default function HealthPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        const json = await res.json();
        setData(json);
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, []);

  const Dot = ({ ok }) => (
    <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
  );

  return (
    <div className="min-h-dvh bg-white text-black dark:bg-neutral-950 dark:text-white p-6">
      <h1 className="text-xl font-semibold mb-4">Health</h1>
      {err && <div className="rounded bg-red-600/90 text-white px-3 py-2 mb-3">{err}</div>}
      {!data ? (
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black dark:border-white/30 dark:border-t-white" />
          <span>Checking…</span>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Dot ok={!!data.checks?.supabase?.ok} />
            <div>Supabase REST</div>
            <div className="ml-auto opacity-70">
              {data.checks?.supabase?.ok
                ? `rows: ${data.checks?.supabase?.total ?? 'n/a'} (status ${data.checks?.supabase?.status})`
                : data.checks?.supabase?.error || 'failed'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Dot ok={!!data.checks?.osrm?.ok} />
            <div>OSRM demo</div>
            <div className="ml-auto opacity-70">
              {data.checks?.osrm?.ok
                ? `~${data.checks?.osrm?.distanceKm?.toFixed?.(1)} km • ${Math.round(data.checks?.osrm?.durationMin || 0)} min (status ${data.checks?.osrm?.status})`
                : data.checks?.osrm?.error || 'failed'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Dot ok={!!data.checks?.tiles?.osm?.ok} />
            <div>OSM tiles</div>
            <div className="ml-auto opacity-70">
              {data.checks?.tiles?.osm?.ok ? `status ${data.checks?.tiles?.osm?.status}` : data.checks?.tiles?.osm?.error || 'failed'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Dot ok={!!data.checks?.tiles?.carto?.ok} />
            <div>Carto tiles</div>
            <div className="ml-auto opacity-70">
              {data.checks?.tiles?.carto?.ok ? `status ${data.checks?.tiles?.carto?.status}` : data.checks?.tiles?.carto?.error || 'failed'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}