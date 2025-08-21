'use client';

export const TYPE = {
  ALL: 'all',
  MALL: 'mall',
  WAREHOUSE: 'warehouse',
};

/** Very simple name-based classifier for now. */
export function classifyType(name = '') {
  const n = String(name).toLowerCase();
  if (/\bwarehouse\b/.test(n)) return TYPE.WAREHOUSE;
  return TYPE.MALL;
}

export function matchesType(name, filter) {
  if (!filter || filter === TYPE.ALL) return true;
  return classifyType(name) === filter;
}