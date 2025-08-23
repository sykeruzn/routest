"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const ROUTE_API_BASE =
  process.env.NEXT_PUBLIC_ROUTE_API_BASE || "http://127.0.0.1:5000/api";

export default function HistoryPage() {
  const [rows, setRows] = useState(null);   // null = loading
  const [err, setErr] = useState("");

useEffect(() => {
  let alive = true;
  (async () => {
    try {
      const res = await fetch(`${ROUTE_API_BASE}/history?limit=20`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const text = await res.text();
      const json = safeJson(text);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      if (alive) setRows(json.items || []);
    } catch (e) {
      if (alive) {
        setErr(e.message || "Failed to load history");
        setRows([]); // stop skeleton
      }
    }
  })();
  return () => { alive = false; };
}, []);
// state
const [deletingId, setDeletingId] = useState(null);

// actions
const refresh = async () => {
  try {
    const res = await fetch(`${ROUTE_API_BASE}/history?limit=20`, { cache: "no-store" });
    const text = await res.text();
    const json = safeJson(text);
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    setRows(json.items || []);
    setErr("");
  } catch (e) {
    setErr(e.message || "Failed to load history");
    setRows([]);
  }
};

const deleteRow = async (id) => {
  if (!id) return;
  if (!window.confirm("Delete this saved route? This cannot be undone.")) return;
  try {
    setDeletingId(id);
    const res = await fetch(`${ROUTE_API_BASE}/history/${id}`, { method: "DELETE" });
    if (!(res.ok || res.status === 204)) throw new Error(`Delete failed (HTTP ${res.status})`);
    setRows((prev) => (prev || []).filter(r => r.request_id !== id));
  } catch (e) {
    setErr(e.message || "Delete failed");
  } finally {
    setDeletingId(null);
  }
};

const csvEscape = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportCsv = async () => {
  try {
    const res = await fetch(`${ROUTE_API_BASE}/history?limit=100`, { cache: "no-store" });
    const text = await res.text();
    const { items = [] } = safeJson(text) || {};
    const header = ["When","Vehicle","Stops","Distance (km)","Duration (min)","Engine","Optimized","Request ID"];
    const lines = [header.join(",")];

    for (const it of items) {
      const distanceKm = it.total_distance == null ? "" : (Number(it.total_distance)/1000).toFixed(1);
      const durationMin = it.total_duration == null ? "" : Math.round(Number(it.total_duration)/60);
      const engine = usedMlEngine(it) ? "ML" : "Default";
      lines.push([
        csvEscape(fmtWhen(it.created_at)),
        csvEscape(it.vehicle_id || ""),
        it.dest_count ?? "",
        distanceKm,
        durationMin,
        engine,
        it.optimized ? "yes" : "no",
        it.request_id
      ].join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `route-history-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    setErr(e.message || "Export failed");
  }
};

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-screen-2xl px-6 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-3xl font-black tracking-tight text-slate-900">Route History</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCsv}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-100"
              title="Export last 100 rows to CSV"
            >
              ⤓ Export CSV
            </button>
            <button
              onClick={refresh}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-100"
            >
              Refresh
            </button>
            <a
              href="/ui"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-100"
            >
              ← Back to Dashboard
            </a>
          </div>
        </div>


        {/* Error banner */}
        {err && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {err}
          </div>
        )}

        {/* Desktop table */}
        <div className="hidden md:block rounded-2xl border bg-white shadow-sm">
          <div className="max-h-[70vh] overflow-auto rounded-2xl">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600">
                <tr>
                  <Th align="left">When</Th>
                  <Th align="left">Vehicle</Th>
                  <Th align="right">Stops</Th>
                  <Th align="right">Distance (km)</Th>
                  <Th align="right">Duration (min)</Th>
                  <Th align="center">Engine</Th>
                  <Th align="center">Optimized</Th>
                  <Th align="left">Request ID</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>

              <tbody className="divide-y">
                {rows === null
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <SkeletonRow key={i} />
                    ))
                  : rows.length === 0
                  ? (
                    <tr>
                      <td colSpan={9} className="px-6 py-10 text-center text-slate-500">
                        No history yet.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr
                        key={r.request_id}
                        className="odd:bg-white even:bg-slate-50/40 hover:bg-yellow-50 transition"
                      >
                        <Td>
                          <div className="font-medium text-slate-900">
                            {fmtWhen(r.created_at)}
                          </div>
                          <div className="text-xs text-slate-500">
                            {timeAgo(r.created_at)}
                          </div>
                        </Td>
                        <Td><VehicleBadge id={r.vehicle_id} /></Td>
                        <Td align="right">
                        {r.dest_count == null ? "—" : <Num>{r.dest_count}</Num>}
                        </Td>

                        <Td align="right">
                        {r.total_distance == null ? "—" : (
                            <>
                            <Num>{(Number(r.total_distance) / 1000).toFixed(1)}</Num>
                            <Unit>km</Unit>
                            </>
                        )}
                        </Td>

                       <Td align="right">
                         {(() => {
                           const ml = getMlMin(r);                 // minutes
                           if (ml != null) return (<><Num>{Math.round(ml)}</Num><Unit>min</Unit></>);
                           if (r.total_duration == null) return "—";
                           return (<><Num>{Math.round(Number(r.total_duration) / 60)}</Num><Unit>min</Unit></>);
                         })()}
                       </Td>
                       <Td align="center">
                         {usedMlEngine(r)
                           ? <span className="inline-flex items-center rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[11px] font-medium text-indigo-700">ML</span>
                           : <span className="text-slate-400 text-xs">Default</span>}
                       </Td>
                       <Td align="center">
                         {r.optimized ? (
                           <Pill>✓ Optimized</Pill>
                         ) : (
                            <span className="text-slate-400 text-xs">—</span>
                          )}
                        </Td>
                        <Td>
                          <Mono id={r.request_id} />
                        </Td>
                        <Td align="right">
                          <button
                            onClick={() => deleteRow(r.request_id)}
                            disabled={deletingId === r.request_id}
                            title="Delete"
                            className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs ${
                              deletingId === r.request_id
                                ? "cursor-not-allowed opacity-50 border-slate-200 text-slate-400"
                                : "border-red-200 text-red-700 hover:bg-red-50"
                            }`}
                          >
                            🗑 Delete
                          </button>
                        </Td>
                      </tr>
                    ))
                  )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden space-y-3">
          {rows === null ? (
            Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)
          ) : rows.length === 0 ? (
            <div className="rounded-2xl border bg-white p-6 text-center text-slate-500">
              No history yet.
            </div>
          ) : (
            rows.map((r) => (
              <div
                key={r.request_id}
                className="rounded-2xl border bg-white p-4 shadow-sm"
              >
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-800">
                    {fmtWhen(r.created_at)}
                  </div>
                  {r.optimized && <Pill>✓ Optimized</Pill>}
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-xl border bg-slate-50 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">Vehicle</div>
                    <div className="mt-1"><VehicleBadge id={r.vehicle_id} /></div>
                  </div>
                  <Info label="Stops" value={r.dest_count} />
                  <Info label="Distance" value={(Number(r.total_distance)/1000).toFixed(1)} unit="km" />
                 <Info
                   label="Duration"
                   value={(getMlMin(r) != null)
                            ? Math.round(getMlMin(r))
                            : Math.round(Number(r.total_duration)/60)}
                   unit="min"
                 />
                 <Info label="Engine" value={usedMlEngine(r) ? "ML" : "Default"} />
                </div>
                  <div className="mt-3 flex items-center justify-between text-xs">
                    <div>
                      <span className="text-slate-500">Request ID: </span>
                      <Mono id={r.request_id} />
                    </div>
                    <button
                      onClick={() => deleteRow(r.request_id)}
                      disabled={deletingId === r.request_id}
                      className={`rounded border px-2 py-1 ${
                        deletingId === r.request_id
                          ? "border-slate-300 text-slate-400"
                          : "border-red-200 text-red-700 hover:bg-red-50"
                      }`}
                    >
                      Delete
                    </button>
                  </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- tiny components ---------- */

function Th({ children, align = "left" }) {
  return (
    <th className={`px-6 py-3 text-${align} text-xs font-semibold uppercase tracking-wide`}>
      {children}
    </th>
  );
}
function Td({ children, align = "left" }) {
  return <td className={`px-6 py-4 text-${align}`}>{children}</td>;
}
function Pill({ children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
      {children}
    </span>
  );
}
function Mono({ id = "" }) {
  if (!id) {
    return <span className="font-mono text-xs text-slate-400">—</span>;
  }
  const short = id.slice(0, 8);

  const copy = async () => {
    try { await navigator.clipboard.writeText(id); } catch {}
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Link
        href={`/ui/history/${id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs text-indigo-600 hover:underline"
        title="Open details in a new tab"
      >
        {short}
      </Link>
      <button
        onClick={copy}
        title="Copy full Request ID"
        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px]
                   text-slate-600 shadow-sm hover:bg-slate-50"
      >
        Copy
      </button>
    </span>
  );
}
function Info({ label, value, unit }) {
  return (
    <div className="rounded-xl border bg-slate-50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-slate-900">
        <Num>{value ?? "—"}</Num>
        {unit ? <Unit>{unit}</Unit> : null}
      </div>
    </div>
  );
}

/* ---------- skeletons ---------- */

function SkeletonRow() {
  return (
    <tr className="odd:bg-white even:bg-slate-50/40">
      {[...Array(9)].map((_, i) => (
        <td key={i} className="px-6 py-3">
          <div className="h-4 w-full max-w-[160px] animate-pulse rounded bg-slate-200" />
        </td>
      ))}
    </tr>
  );
}
function CardSkeleton() {
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="mb-3 h-4 w-40 animate-pulse rounded bg-slate-200" />
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 rounded-xl bg-slate-100 animate-pulse" />
        ))}
      </div>
      <div className="mt-3 h-3 w-48 animate-pulse rounded bg-slate-200" />
    </div>
  );
}

/* ---------- helpers ---------- */

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function fmtKm(meters) {
  if (meters == null) return "—";
  return (Number(meters) / 1000).toFixed(1);
}
function fmtMin(seconds) {
  if (seconds == null) return "—";
  return Math.round(Number(seconds) / 60);
}
function fmtWhen(isoLike) {
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}
function timeAgo(isoLike) {
  const d = new Date(isoLike).getTime();
  if (Number.isNaN(d)) return "";
  const s = Math.max(1, Math.floor((Date.now() - d) / 1000));
  const mins = Math.floor(s / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs >= 24) return `${Math.floor(hrs / 24)}d ago`;
  if (hrs >= 1) return `${hrs}h ago`;
  if (mins >= 1) return `${mins}m ago`;
  return `${s}s ago`;
}

function Num({ children }) {
  return <span className="tabular-nums font-semibold text-slate-900">{children}</span>;
}
function Unit({ children }) {
  return <span className="ml-1 text-[11px] text-slate-500">{children}</span>;
}

function getMlMin(row) {
  // minutes (number) if present
  const direct = row?.eta_minutes_ml;
  const nested = row?.properties?.eta_minutes_ml; // if you stored properties JSON
  const v = direct ?? nested;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function usedMlEngine(row) {
  return Boolean(getMlMin(row) != null || row?.use_ml_eta === true);
}

function VehicleBadge({ id }) {
  if (!id) return <span className="text-slate-400 text-xs">—</span>;
  return (
    <span
      className="inline-flex max-w-[180px] items-center gap-1 rounded-md bg-slate-100 px-2.5 py-0.5
                 text-xs font-semibold text-slate-800 ring-1 ring-slate-200 truncate"
      title={id}
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10 16h4" />
        <path d="M2 12h2l3-6h10l3 6h2" />
        <circle cx="7" cy="16" r="2" />
        <circle cx="17" cy="16" r="2" />
      </svg>
      <span className="truncate">{id}</span>
    </span>
  );
}