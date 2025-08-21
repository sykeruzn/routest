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
        // be resilient if backend ever replies HTML
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
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-screen-2xl px-6 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-3xl font-black tracking-tight text-slate-900">
            Route History
          </h1>
          <a
            href="/ui"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white
                            px-4 py-2 text-sm font-medium text-slate-700 shadow-sm
                            hover:bg-slate-100 hover:text-slate-900
                            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
          >
            ← Back to Dashboard
          </a>
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
                  <Th align="center">Optimized</Th>
                  <Th align="left">Request ID</Th>
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
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500">
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
                        <Td>{r.vehicle_id || "—"}</Td>
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
                        {r.total_duration == null ? "—" : (
                            <>
                            <Num>{Math.round(Number(r.total_duration) / 60)}</Num>
                            <Unit>min</Unit>
                            </>
                        )}
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
                  <Info label="Vehicle" value={r.vehicle_id || "—"} />
                  <Info label="Stops" value={r.dest_count} />
                  <Info label="Distance" value={(Number(r.total_distance)/1000).toFixed(1)} unit="km" />
                  <Info label="Duration" value={Math.round(Number(r.total_duration)/60)} unit="min" />
                </div>
                <div className="mt-3 text-xs">
                  <span className="text-slate-500">Request ID: </span>
                  <Mono id={r.request_id} />
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
      {[...Array(7)].map((_, i) => (
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