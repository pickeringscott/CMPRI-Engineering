"use client";
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { modalActionForRoute, modalThemeStyle } from '@/lib/ui/header-palette';
import { followSitePalette } from '@/lib/ui/shared-palette';

export default function ModalTheme() {
  const path = usePathname();
  useEffect(() => followSitePalette(window), []);
  useEffect(() => {
    const action = modalActionForRoute(path);
    if (!action) return;
    const root = document.documentElement;
    root.dataset.cmpriModalTheme = 'true';
    for (const [key, value] of Object.entries(modalThemeStyle(action))) if (key.startsWith('--')) root.style.setProperty(key, value);
    return () => {
      delete root.dataset.cmpriModalTheme;
      for (const key of Object.keys(modalThemeStyle(action))) if (key.startsWith('--')) root.style.removeProperty(key);
    };
  }, [path]);
  return null;
}
