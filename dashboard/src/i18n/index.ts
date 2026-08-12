import i18n from 'i18next';
import type { BackendModule, ReadCallback, ResourceKey } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

export const supportedLanguages = [
  'en',
  'de',
  'es',
  'he',
  'tr',
  'zh-CN',
  'zh-HK',
  'ar',
  'te',
  'fr',
  'it',
  'pt-BR',
  'ko',
] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export const rtlLanguages: SupportedLanguage[] = ['he', 'ar'];

export const languageOptions: Array<{ value: SupportedLanguage; label: string; compactLabel: string }> = [
  { value: 'en', label: 'English', compactLabel: 'EN' },
  { value: 'de', label: 'Deutsch', compactLabel: 'DE' },
  { value: 'tr', label: 'Türkçe', compactLabel: 'TR' },
  { value: 'es', label: 'Español', compactLabel: 'ES' },
  { value: 'he', label: 'עברית', compactLabel: 'עברית' },
  { value: 'zh-CN', label: '简体中文', compactLabel: '简中' },
  { value: 'zh-HK', label: '繁體中文', compactLabel: '繁中' },
  { value: 'ar', label: 'العربية', compactLabel: 'AR' },
  { value: 'te', label: 'తెలుగు', compactLabel: 'TE' },
  { value: 'fr', label: 'Français', compactLabel: 'FR' },
  { value: 'it', label: 'Italiano', compactLabel: 'IT' },
  { value: 'pt-BR', label: 'Português (Brasil)', compactLabel: 'PT' },
  { value: 'ko', label: '한국어', compactLabel: 'KO' },
];

export function resolveSupportedLanguage(lang?: string): SupportedLanguage {
  const value = lang || 'en';
  const exact = supportedLanguages.find(supported => supported.toLowerCase() === value.toLowerCase());
  if (exact) return exact;

  const parts = value.toLowerCase().split('-');
  const base = parts[0];
  if (base === 'zh') {
    const subtags = new Set(parts.slice(1));
    if (subtags.has('hant') || subtags.has('hk') || subtags.has('mo') || subtags.has('tw')) return 'zh-HK';
    return 'zh-CN';
  }

  return supportedLanguages.find(supported => supported === base) ?? 'en';
}

/**
 * i18next's own loading extension point. Using it rather than fetching by hand is what keeps a
 * runtime language switch correct: i18next resolves `read` for the requested language before it
 * emits `languageChanged`, so no component ever renders against a half-loaded catalogue and neither
 * language picker has to sequence anything itself.
 */
const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    // A dynamic import with a variable rather than `import.meta.glob`: Vite splits one chunk per
    // matched file either way, but this stays a real runtime import under the bare node test runner
    // that renders the components, where the Vite transform does not run and `import.meta.glob` is
    // undefined. Keep the directory and the extension literal or the split stops happening.
    void import(`./locales/${language}.json`).then(
      (module: { default: ResourceKey }) => callback(null, module.default),
      (error: Error) => callback(error, false),
    );
  },
};

function applyDirection(lang: string) {
  const resolved = resolveSupportedLanguage(lang);
  const dir = rtlLanguages.includes(resolved) ? 'rtl' : 'ltr';
  if (typeof document !== 'undefined') {
    document.documentElement.lang = resolved;
    document.documentElement.dir = dir;
  }
}

// Subscribed before init, which is also what sets the initial direction: init resolves the detected
// language through `changeLanguage`, so the first event is the initial one. Registering afterwards
// happens to work too, but only because init defers — this way the order cannot matter.
i18n.on('languageChanged', applyDirection);

export const i18nReady = i18n
  .use(lazyLocaleBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    supportedLngs: supportedLanguages as unknown as string[],
    nonExplicitSupportedLngs: false,
    // Fetch only the resolved language (plus the fallback). i18next's default would also request a
    // bare 'zh' catalogue for a 'zh-CN' visitor, and no such file exists.
    load: 'currentOnly',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'openwa_language',
      caches: ['localStorage'],
      convertDetectedLanguage: (lang: string) => resolveSupportedLanguage(lang),
    },
    react: { useSuspense: false },
  });

export default i18n;
