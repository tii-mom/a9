import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'fuse.lang';

interface LangCtx {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggle: () => void;
}

const Ctx = createContext<LangCtx>({ lang: 'zh', setLang: () => {}, toggle: () => {} });

function readInitial(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'en' || v === 'zh') return v;
  } catch {
    /* ignore */
  }
  return 'zh';
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitial);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);
  const toggle = useCallback(() => setLangState((l) => (l === 'zh' ? 'en' : 'zh')), []);
  const value = useMemo(() => ({ lang, setLang, toggle }), [lang, setLang, toggle]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang() {
  return useContext(Ctx);
}

/** Pick a localized value: const label = usePick('库存', 'Inventory') */
export function usePick<T>(zh: T, en: T): T {
  const { lang } = useLang();
  return lang === 'zh' ? zh : en;
}

/** Pick a localized object shape: const L = useDict(ZH, EN) */
export function useDict<T extends Record<string, unknown>>(zh: T, en: T): T {
  const { lang } = useLang();
  return lang === 'zh' ? zh : en;
}
