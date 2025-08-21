'use client';
import { useEffect, useRef, useState } from 'react';
import { TYPE } from '@/lib/classify';

export default function Controls({
  search,
  setSearch,
  filter,
  setFilter,
  count,
  initial = { x: 8, y: 8 }, // px from top-left
}) {
  const rootRef = useRef(null);
  const [pos, setPos] = useState(initial);
  const [collapsed, setCollapsed] = useState(false);
  const dragData = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  useEffect(() => {
    const onMove = (e) => {
      if (!dragData.current.dragging) return;
      const dx = e.clientX - dragData.current.startX;
      const dy = e.clientY - dragData.current.startY;
      setPos({ x: dragData.current.origX + dx, y: dragData.current.origY + dy });
    };
    const onUp = () => (dragData.current.dragging = false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const onDragStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragData.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
    };
  };

  const chip = (value, label) => {
    const active = filter === value;
    return (
      <button
        onClick={() => setFilter(value)}
        className={[
          'rounded-full px-3 py-1 text-xs border transition',
          active
            ? 'bg-black text-white border-black dark:bg-white dark:text-black dark:border-white'
            : 'bg-white/80 text-black border-black/20 hover:bg-black/5 dark:bg-neutral-900/80 dark:text-white dark:border-white/20 dark:hover:bg-white/5',
        ].join(' ')}
        type="button"
      >
        {label}
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      className="absolute z-[1000] select-none group"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="relative rounded-2xl bg-white/90 dark:bg-neutral-900/90 shadow-lg backdrop-blur w-[min(86vw,380px)]">
        {/* Hover-only drag handle */}
        <div
          onPointerDown={onDragStart}
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
          <div className="text-xs font-medium opacity-70">Search & Filters</div>
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
            <div className="flex items-center gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search locations…"
                className="w-full rounded-xl border border-black/15 dark:border-white/15 bg-white/80 dark:bg-neutral-900/80 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/20 dark:focus:ring-white/20"
              />
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {chip(TYPE.ALL, 'All')}
              {chip(TYPE.MALL, 'Malls')}
              {chip(TYPE.WAREHOUSE, 'Warehouse')}
              <span className="ml-auto text-xs opacity-70 self-center">{count} shown</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}