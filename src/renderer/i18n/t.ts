import { en } from '../locales/en'

export type MessageKey = keyof typeof en

/** The interface locale for Intl formatting (dates, numbers); v1 is English only. */
export const LOCALE = 'en'

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template: string = en[key]
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  )
}
