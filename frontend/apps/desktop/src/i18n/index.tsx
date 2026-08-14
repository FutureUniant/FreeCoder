import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { catalogs, type MessageKey } from "./messages";
import {
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  type UiLocale,
} from "./types";

export type { UiLocale, MessageKey };
export { normalizeLocale, LOCALE_STORAGE_KEY };

type Vars = Record<string, string | number>;

export type TFunction = (key: MessageKey, vars?: Vars) => string;

type I18nContextValue = {
  locale: UiLocale;
  setLocale: (locale: UiLocale) => void;
  t: TFunction;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function formatMessage(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] != null ? String(vars[name]) : `{${name}}`,
  );
}

function readStoredLocale(): UiLocale {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return "zh-CN";
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>(() => readStoredLocale());

  const setLocale = useCallback((next: UiLocale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback<TFunction>(
    (key, vars) => {
      const table = catalogs[locale] ?? catalogs["zh-CN"];
      const fallback = catalogs.en;
      const template = table[key] ?? fallback[key] ?? String(key);
      return formatMessage(template, vars);
    },
    [locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return (
    <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}
