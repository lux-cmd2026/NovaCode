import { createContext, useContext } from 'react'
import { t as tr } from '@shared/i18n'
import type { Lang } from '@shared/types'

export const LangContext = createContext<Lang>('en')
export const useLang = () => useContext(LangContext)

/** `const t = useT(); t('chat.send')` */
export function useT() {
  const lang = useLang()
  return (key: string, vars?: Record<string, string | number>) => tr(lang, key, vars)
}
