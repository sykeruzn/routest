'use client';
import { supabase } from '@/lib/supabaseClient';

export async function fetchLocations() {
  const hasSupabaseEnv =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (hasSupabaseEnv) {
    const { data, error } = await supabase
      .from('locations')
      .select('id, name, latitude, longitude, created_at')
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);

    return (data || []).map((r) => ({
      ...r,
      latitude: typeof r.latitude === 'number' ? r.latitude : parseFloat(r.latitude),
      longitude: typeof r.longitude === 'number' ? r.longitude : parseFloat(r.longitude),
    }));
  }

  // Fallback: our Next API (pg)
  const res = await fetch('/api/locations', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load locations');
  return await res.json();
}