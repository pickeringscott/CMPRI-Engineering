import { SPANISH_UI } from './catalog';

export type UiLanguage = 'en' | 'es';
export type UiValues = Record<string, string | number | boolean | null | undefined>;
export type UiTranslator = (english: string, fallbackOrValues?: string | UiValues, values?: UiValues) => string;
export const UI_LANGUAGE_MESSAGE = 'cmpri-ui-language';
export const UI_LANGUAGE_EVENT = 'cmpri-ui-language-updated';
export const uiLanguage = (value: unknown): UiLanguage => value === 'es' ? 'es' : 'en';
export const uiLocale = (language: UiLanguage) => language === 'es' ? 'es-US' : 'en-US';

function interpolate(text: string, values: UiValues) {
  return text.replace(/\{([\w]+)\}/g, (token, key: string) => Object.hasOwn(values, key) ? String(values[key] ?? '') : token);
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = new Map(Object.entries(SPANISH_UI));
const contextKeys = new Map(Object.entries(SPANISH_UI).filter(([key]) => key.includes('::')).map(([key, value]) => [key.toLocaleLowerCase('en-US'), value]));
const patterns = Object.entries(SPANISH_UI).flatMap(([english, spanish]) => {
  const names = [...english.matchAll(/\{([\w]+)\}/g)].map(match => match[1]);
  if (!names.length) return [];
  const parts = english.split(/\{[\w]+\}/g);
  if (!parts[0].trim() || !/[\p{L}]/u.test(parts[0])) return [];
  // Only known UI templates are matched, preserving every captured user/data value.
  return [{ prefix: parts[0], literalLength: parts.reduce((length, part) => length + part.length, 0), pattern: new RegExp('^' + parts.map(escape).join('([\\s\\S]+?)') + '$'), names, spanish }];
}).sort((a, b) => b.prefix.length - a.prefix.length || b.literalLength - a.literalLength);

export function translateUiText(language: UiLanguage, english: string, fallbackOrValues?: string | UiValues, extraValues?: UiValues): string {
  const values = typeof fallbackOrValues === 'object' ? fallbackOrValues : extraValues || {};
  if (language === 'en') return interpolate(english, values);
  if (typeof values.context === 'string') {
    const key = english.trim() + '::' + values.context;
    const contextual = exact.get(key) ?? contextKeys.get(key.toLocaleLowerCase('en-US'));
    if (contextual !== undefined) return interpolate(contextual, values);
  }
  const direct = exact.get(english);
  if (direct !== undefined) return interpolate(direct, values);
  const [, leading = '', core = english, trailing = ''] = english.match(/^(\s*)([\s\S]*?)(\s*)$/) || [];
  const normalized = core.replace(/\s+/g, ' ');
  let translated = exact.get(normalized);
  if (translated === undefined && normalized.endsWith(':') && exact.has(normalized.slice(0, -1))) translated = exact.get(normalized.slice(0, -1)) + ':';
  if (translated !== undefined) return leading + interpolate(translated, values) + trailing;
  if (typeof fallbackOrValues === 'string') return leading + interpolate(fallbackOrValues.trim(), values) + trailing;
  if (normalized.length <= 2000) for (const template of patterns) {
    if (!normalized.startsWith(template.prefix)) continue;
    const match = template.pattern.exec(normalized);
    if (!match) continue;
    const captured = Object.fromEntries(template.names.map((name, index) => [name, match[index + 1]]));
    return leading + interpolate(template.spanish, { ...captured, ...values }) + trailing;
  }
  return interpolate(english, values);
}

export function uiTitleCase(text: string) {
  return text.replace(/(^|[\s/–—(])([\p{L}])/gu, (_, boundary: string, letter: string) => boundary + letter.toLocaleUpperCase());
}

export function makeUiTranslator(language: UiLanguage): UiTranslator {
  return (english, fallbackOrValues, values) => translateUiText(language, english, fallbackOrValues, values);
}
