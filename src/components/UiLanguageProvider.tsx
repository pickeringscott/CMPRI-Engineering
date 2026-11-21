"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { getValidSession } from '@/lib/supabase/client';
import { makeUiTranslator, UI_LANGUAGE_EVENT, UI_LANGUAGE_MESSAGE, uiLanguage, uiLocale, uiTitleCase,
  type UiLanguage, type UiTranslator } from '@/lib/i18n/ui';

const DEVICE_KEY = 'cmpri:ui-language:device:v1';
const userKey = (id: string) => 'cmpri:ui-language:user:v1:' + id;
const preferenceCache = new Map<string, { language: UiLanguage; at: number }>();
const CACHE_MS = 300000;
type LanguageContext = { language: UiLanguage; setLanguage: (language: UiLanguage) => void };
const Context = createContext<LanguageContext>({ language: 'en', setLanguage: () => {} });

function storedLanguage(key: string): UiLanguage | null {
  try { const value = localStorage.getItem(key); return value === 'en' || value === 'es' ? value : null; }
  catch { return null; }
}

/** Language affects presentation only. Canonical values and authorization never depend on it. */
export default function UiLanguageProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [language, setCurrentLanguage] = useState<UiLanguage>('en');
  const current = useRef({ language: 'en' as UiLanguage, userId: '' });
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const lastPreferenceEvent = useRef({ key: '', at: 0 });

  const sendToFrames = useCallback(() => {
    const value = current.current;
    const message = { type: UI_LANGUAGE_MESSAGE, language: value.language, userId: value.userId };
    for (const frame of document.querySelectorAll('iframe')) {
      try { frame.contentWindow?.postMessage(message, window.location.origin); } catch {}
    }
  }, []);

  const apply = useCallback((next: UiLanguage, userId: string, persist = true) => {
    current.current = { language: next, userId };
    document.documentElement.lang = next;
    document.documentElement.dataset.cmpriLanguageOwner = userId;
    setCurrentLanguage(old => old === next ? old : next);
    if (persist) try {
      localStorage.setItem(DEVICE_KEY, next);
      if (userId) localStorage.setItem(userKey(userId), next);
    } catch {}
    window.dispatchEvent(new CustomEvent(UI_LANGUAGE_EVENT, { detail: current.current }));
    sendToFrames();
  }, [sendToFrames]);

  const refresh = useCallback(async (force = false) => {
    const request = ++generation.current;
    controller.current?.abort();
    const lifetime = new AbortController(); controller.current = lifetime;
    try {
      const session = await getValidSession();
      if (request !== generation.current || lifetime.signal.aborted) return;
      if (!session?.user.id) { apply(storedLanguage(DEVICE_KEY) || storedLanguage('cmpri:work-order-language') || 'en', ''); return; }
      const userId = session.user.id;
      if (current.current.userId !== userId) apply(storedLanguage(userKey(userId)) || 'en', userId, false);
      if (!force && window.parent !== window) try {
        const root = window.parent.document.documentElement;
        if (root.dataset.cmpriLanguageOwner === userId) { apply(uiLanguage(root.lang), userId); return; }
      } catch {}
      const cached = preferenceCache.get(userId);
      if (!force && cached && Date.now() - cached.at >= 0 && Date.now() - cached.at < CACHE_MS) { apply(cached.language, userId); return; }
      const response = await fetch('/api/profile', { headers: { Authorization: `Bearer ${session.access_token}` }, cache: force ? 'reload' : 'no-store', signal: lifetime.signal });
      const payload = await response.json();
      const active = await getValidSession();
      if (request !== generation.current || lifetime.signal.aborted || active?.user.id !== userId || !response.ok) return;
      if (payload.profile?.id && payload.profile.id !== userId) return;
      if (payload.preferences?.language !== 'en' && payload.preferences?.language !== 'es') return;
      const next = uiLanguage(payload.preferences.language);
      preferenceCache.set(userId, { language: next, at: Date.now() });
      while (preferenceCache.size > 8) preferenceCache.delete(preferenceCache.keys().next().value!);
      apply(next, userId);
    } catch { /* A failed preference read keeps the last verified language for this account. */ }
  }, [apply]);

  const cancelPending = useCallback(() => { generation.current++; controller.current?.abort(); }, []);

  useEffect(() => {
    const savedPreference = (value: unknown) => {
      const key = current.current.userId + ':' + String(value);
      if (lastPreferenceEvent.current.key === key && Date.now() - lastPreferenceEvent.current.at < 200) return;
      lastPreferenceEvent.current = { key, at: Date.now() };
      void refresh(true);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return;
      if (event.data.type === UI_LANGUAGE_MESSAGE && event.source === window.parent && window.parent !== window) {
        const { language: next, userId } = event.data;
        if ((next !== 'en' && next !== 'es') || typeof userId !== 'string') return;
        void getValidSession().then(session => {
          if (session?.user.id !== userId) return;
          generation.current++; controller.current?.abort();
          apply(next, userId);
        });
      } else if (event.data.type === 'cmpri-profile-preferences-updated') {
        if (window.parent !== window && event.source === window.parent) return;
        // Read the acknowledged preference for the current account instead of trusting a stale frame payload.
        savedPreference(event.data.preferences?.language);
      }
    };
    const onSavedPreference = (event: Event) => savedPreference((event as CustomEvent).detail?.language);
    const onFocus = () => { void refresh(false); };
    const onSignOut = () => {
      generation.current++; controller.current?.abort(); preferenceCache.clear();
      apply(storedLanguage(DEVICE_KEY) || 'en', '', false);
    };
    const onFrameLoad = (event: Event) => { if (event.target instanceof HTMLIFrameElement) sendToFrames(); };
    window.addEventListener('message', onMessage);
    window.addEventListener('cmpri-profile-preferences-updated', onSavedPreference);
    window.addEventListener('cmpri-workspace-sign-out', onSignOut);
    window.addEventListener('focus', onFocus);
    document.addEventListener('load', onFrameLoad, true);
    return () => {
      cancelPending();
      window.removeEventListener('message', onMessage);
      window.removeEventListener('cmpri-profile-preferences-updated', onSavedPreference);
      window.removeEventListener('cmpri-workspace-sign-out', onSignOut);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('load', onFrameLoad, true);
    };
  }, [apply, cancelPending, refresh, sendToFrames]);
  useEffect(() => {
    let canceled = false;
    void Promise.resolve().then(() => { if (!canceled) void refresh(false); });
    return () => { canceled = true; };
  }, [pathname, refresh]);

  const setLanguage = useCallback((next: UiLanguage) => apply(next, current.current.userId), [apply]);
  const value = useMemo(() => ({ language, setLanguage }), [language, setLanguage]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useUiLanguage(overrideLanguage?: UiLanguage) {
  const context = useContext(Context);
  const language = overrideLanguage || context.language;
  const t = useMemo(() => makeUiTranslator(language), [language]);
  const tt: UiTranslator = useCallback((english, fallbackOrValues, values) => uiTitleCase(t(english, fallbackOrValues, values)), [t]);
  return { ...context, language, locale: uiLocale(language), t, tt };
}
