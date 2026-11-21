/** English UI fixture for isolated component VMs; canonical data and values stay unchanged. */
function interpolate(text, values = {}) {
  return text.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(values, key) ? String(values[key] ?? '') : token);
}
function t(english, fallbackOrValues, values) {
  return interpolate(english, typeof fallbackOrValues === 'object' && fallbackOrValues !== null ? fallbackOrValues : values);
}
function tt(...args) {
  return t(...args).replace(/(^|[\s/–—(])([\p{L}])/gu, (_, boundary, letter) => boundary + letter.toLocaleUpperCase());
}
export const englishUiLanguage = Object.freeze({ language: 'en', locale: 'en-US', t, tt, setLanguage() {} });
export const uiLanguageDependency = Object.freeze({ useUiLanguage: () => englishUiLanguage });
