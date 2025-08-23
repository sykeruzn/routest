'use client';
import { useEffect, useRef, useState } from 'react';

export default function RouteControls({
  locations,
  originId, setOriginId,
  destId, setDestId,
  onRoute, onClear,
  initial = { x: 8, y: 140 },
}) {
  const [pos, setPos] = useState(initial);
  const [collapsed, setCollapsed] = useState(false);
  const drag = useRef({ on:false, sx:0, sy:0, ox:0, oy:0 });

  useEffect(() => {
    const move = (e) => {
      if (!drag.current.on) return;
      setPos({ x: drag.current.ox + (e.clientX - drag.current.sx), y: drag.current.oy + (e.clientY - drag.current.sy) });
    };
    const up = () => (drag.current.on = false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  const onDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { on:true, sx:e.clientX, sy:e.clientY, ox:pos.x, oy:pos.y };
  };

  return (
    <div className="absolute z-[1000] select-none group" style={{ left: pos.x, top: pos.y }}>
      <div className="relative rounded-2xl bg-white/90 dark:bg-neutral-900/90 shadow-lg backdrop-blur w-[min(86vw,380px)]">
        {/* Hover-only drag handle */}
        <div
          onPointerDown={onDown}
          className="
            absolute left-1/2 -translate-x-1/2 -top-3
            px-2 py-0.5 rounded-full border text-[11px] shadow
            bg-white/90 dark:bg-neutral-900/90
            border-black/10 dark:border-white/10
            text-black/60 dark:text-white/60
            cursor-grab active:cursor-grabbing
            opacity-0 pointer-events-none
            group-hover:opacity-100 group-hover:pointer-events-auto group-hover:-top-5
            transition-all duration-200
          "
          title="Drag to move"
        >
          drag me
        </div>

        {/* Header with collapse toggle */}
        <div className="flex items-center justify-between px-3 pt-2">
          <div className="text-xs font-medium opacity-70">Routing (dev OSRM)</div>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="text-xs rounded-full px-2 py-1 border border-black/15 dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/5"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? 'Show' : 'Hide'}
          </button>
        </div>

        {!collapsed && (
          <div className="p-2 sm:p-3">
            <div className="grid grid-cols-1 gap-2">
              <select
                value={originId || ''}
                onChange={(e) => setOriginId(e.target.value || null)}
                className="rounded-xl border border-black/15 dark:border-white/15 bg-white/80 dark:bg-neutral-900/80 px-3 py-2 text-sm outline-none"
              >
                <option value="">Origin…</option>
                {locations.map(l => (<option key={l.id} value={l.id}>{l.name}</option>))}
              </select>

              <select
                value={destId || ''}
                onChange={(e) => setDestId(e.target.value || null)}
                className="rounded-xl border border-black/15 dark:border-white/15 bg-white/80 dark:bg-neutral-900/80 px-3 py-2 text-sm outline-none"
              >
                <option value="">Destination…</option>
                {locations.map(l => (<option key={l.id} value={l.id}>{l.name}</option>))}
              </select>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onRoute}
                  className="flex-1 rounded-xl border border-black/15 dark:border-white/15 px-3 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                  disabled={!originId || !destId}
                >
                  Route
                </button>
                <button
                  type="button"
                  onClick={onClear}
                  className="rounded-xl border border-black/15 dark:border-white/15 px-3 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="mt-2 text-[11px] opacity-60">
              Tip: this uses the public OSRM demo; later I’ll switch to the <code>/route_optimize</code> of Dane.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}