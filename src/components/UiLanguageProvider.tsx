"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { getValidSession } from '@/lib/supabase/client';
import { resolveProfileTimeFormat, type TimeFormat } from '@/lib/profile-preferences';
import { isTimeFormat, TIME_FORMAT_MESSAGE } from '@/lib/ui/time-format';
import { makeUiTranslator, UI_LANGUAGE_EVENT, UI_LANGUAGE_MESSAGE, uiLanguage, uiLocale, uiTitleCase,
  type UiLanguage, type UiTranslator } from '@/lib/i18n/ui';
import { TimeFormatContext } from './TimeFormatProvider';

const DEVICE_KEY = 'cmpri:ui-language:device:v1';
const userKey = (id: string) => 'cmpri:ui-language:user:v1:' + id;
const timeFormatKey = (id: string) => 'cmpri:time-format:user:v1:' + id;
const preferenceCache = new Map<string, { language: UiLanguage; timeFormat: TimeFormat | null; at: number }>();
const CACHE_MS = 300000;
type LanguageContext = { language: UiLanguage; setLanguage: (language: UiLanguage) => void };
const Context = createContext<LanguageContext>({ language: 'en', setLanguage: () => {} });

function storedLanguage(key: string): UiLanguage | null {
  try { const value = localStorage.getItem(key); return value === 'en' || value === 'es' ? value : null; }
  catch { return null; }
}

function storedTimeFormat(userId: string): TimeFormat | null {
  try { const value = localStorage.getItem(timeFormatKey(userId)); return isTimeFormat(value) ? value : null; }
  catch { return null; }
}

/** Language affects presentation only. Canonical values and authorization never depend on it. */
export default function UiLanguageProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [language, setCurrentLanguage] = useState<UiLanguage>('en');
  const [timeFormat, setTimeFormat] = useState<TimeFormat>('12h');
  const current = useRef({ language: 'en' as UiLanguage, timeFormat: null as TimeFormat | null, userId: '' });
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const lastPreferenceEvent = useRef({ key: '', at: 0 });

  const sendToFrames = useCallback(() => {
    const value = current.current;
    const message = { type: UI_LANGUAGE_MESSAGE, ...value };
    const timeMessage = { type: TIME_FORMAT_MESSAGE, timeFormat: value.timeFormat, userId: value.userId };
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        frame.contentWindow?.postMessage(message, window.location.origin);
        if (value.timeFormat) frame.contentWindow?.postMessage(timeMessage, window.location.origin);
      } catch {}
    }
  }, []);

  const apply = useCallback((next: UiLanguage, userId: string, persist = true, nextTimeFormat = current.current.timeFormat) => {
    current.current = { language: next, timeFormat: nextTimeFormat, userId };
    document.documentElement.lang = next;
    document.documentElement.dataset.cmpriLanguageOwner = userId;
    if (nextTimeFormat) document.documentElement.dataset.cmpriTimeFormat = nextTimeFormat;
    else delete document.documentElement.dataset.cmpriTimeFormat;
    setCurrentLanguage(old => old === next ? old : next);
    setTimeFormat(nextTimeFormat ?? '12h');
    if (persist) try {
      localStorage.setItem(DEVICE_KEY, next);
      if (userId) {
        localStorage.setItem(userKey(userId), next);
        if (nextTimeFormat) localStorage.setItem(timeFormatKey(userId), nextTimeFormat);
      }
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
      if (!session?.user.id) { apply(storedLanguage(DEVICE_KEY) || storedLanguage('cmpri:work-order-language') || 'en', '', true, null); return; }
      const userId = session.user.id;
      if (current.current.userId !== userId) apply(storedLanguage(userKey(userId)) || 'en', userId, false, storedTimeFormat(userId));
      if (!force && window.parent !== window) try {
        const root = window.parent.document.documentElement;
        const inheritedFormat = root.dataset.cmpriTimeFormat;
        if (root.dataset.cmpriLanguageOwner === userId && isTimeFormat(inheritedFormat)) {
          apply(uiLanguage(root.lang), userId, true, inheritedFormat);
          return;
        }
      } catch {}
      const cached = preferenceCache.get(userId);
      if (!force && cached && Date.now() - cached.at >= 0 && Date.now() - cached.at < CACHE_MS) { apply(cached.language, userId, true, cached.timeFormat); return; }
      const response = await fetch('/api/profile', { headers: { Authorization: `Bearer ${session.access_token}` }, cache: force ? 'reload' : 'no-store', signal: lifetime.signal });
      const payload = await response.json();
      const active = await getValidSession();
      if (request !== generation.current || lifetime.signal.aborted || active?.user.id !== userId || !response.ok) return;
      if (payload.profile?.id && payload.profile.id !== userId) return;
      if (!payload.preferences) return;
      const languageValue = payload.preferences.language;
      const next = languageValue === 'en' || languageValue === 'es' ? languageValue : current.current.language;
      const nextTimeFormat = typeof payload.profile?.role === 'string' || isTimeFormat(payload.preferences.time_format)
        ? resolveProfileTimeFormat(payload.preferences, payload.profile ?? { role: undefined })
        : current.current.timeFormat;
      preferenceCache.set(userId, { language: next, timeFormat: nextTimeFormat, at: Date.now() });
      while (preferenceCache.size > 8) preferenceCache.delete(preferenceCache.keys().next().value!);
      apply(next, userId, true, nextTimeFormat);
    } catch { /* A failed preference read keeps the last verified preferences for this account. */ }
  }, [apply]);

  const cancelPending = useCallback(() => { generation.current++; controller.current?.abort(); }, []);

  useEffect(() => {
    const savedPreference = (preferences: { language?: unknown; time_format?: unknown } | null) => {
      const key = current.current.userId + ':' + String(preferences?.language) + ':' + String(preferences?.time_format);
      if (lastPreferenceEvent.current.key === key && Date.now() - lastPreferenceEvent.current.at < 200) return;
      lastPreferenceEvent.current = { key, at: Date.now() };
      void refresh(true);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return;
      if (event.data.type === UI_LANGUAGE_MESSAGE && event.source === window.parent && window.parent !== window) {
        const { language: next, timeFormat: nextTimeFormat, userId } = event.data;
        if ((next !== 'en' && next !== 'es') || typeof userId !== 'string') return;
        void getValidSession().then(session => {
          if (session?.user.id !== userId) return;
          generation.current++; controller.current?.abort();
          const format = isTimeFormat(nextTimeFormat) ? nextTimeFormat
            : current.current.userId === userId ? current.current.timeFormat : storedTimeFormat(userId);
          apply(next, userId, true, format);
        });
      } else if (event.data.type === 'cmpri-profile-preferences-updated') {
        if (window.parent !== window && event.source === window.parent) return;
        // Read the acknowledged preference for the current account instead of trusting a stale frame payload.
        savedPreference(event.data.preferences);
      }
    };
    const onSavedPreference = (event: Event) => savedPreference((event as CustomEvent).detail);
    const onStorage = (event: StorageEvent) => {
      const userId = current.current.userId;
      if (userId && event.key === timeFormatKey(userId) && isTimeFormat(event.newValue)
        && event.newValue !== current.current.timeFormat) void refresh(true);
    };
    const onFocus = () => { void refresh(false); };
    const onSignOut = () => {
      generation.current++; controller.current?.abort(); preferenceCache.clear();
      apply(storedLanguage(DEVICE_KEY) || 'en', '', false, null);
    };
    const onFrameLoad = (event: Event) => { if (event.target instanceof HTMLIFrameElement) sendToFrames(); };
    window.addEventListener('message', onMessage);
    window.addEventListener('cmpri-profile-preferences-updated', onSavedPreference);
    window.addEventListener('cmpri-workspace-sign-out', onSignOut);
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    document.addEventListener('load', onFrameLoad, true);
    return () => {
      cancelPending();
      window.removeEventListener('message', onMessage);
      window.removeEventListener('cmpri-profile-preferences-updated', onSavedPreference);
      window.removeEventListener('cmpri-workspace-sign-out', onSignOut);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
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
  return <Context.Provider value={value}><TimeFormatContext.Provider value={timeFormat}>{children}</TimeFormatContext.Provider></Context.Provider>;
}

export function useUiLanguage(overrideLanguage?: UiLanguage) {
  const context = useContext(Context);
  const language = overrideLanguage || context.language;
  const t = useMemo(() => makeUiTranslator(language), [language]);
  const tt: UiTranslator = useCallback((english, fallbackOrValues, values) => uiTitleCase(t(english, fallbackOrValues, values)), [t]);
  return { ...context, language, locale: uiLocale(language), t, tt };
}
