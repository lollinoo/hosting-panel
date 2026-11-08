import type { SessionData } from "@/lib/session";
import { en } from "./en";
import { it } from "./it";

export type Locale = "it" | "en";
export const DEFAULT_LOCALE: Locale = "it";
export const LOCALE_COOKIE = "hp_locale";

type Widen<T> = { -readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Messages = Widen<typeof it>;

export function getMessages(locale: Locale): Messages {
  return locale === "en" ? en : it;
}

export function format(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const isLocale = (v: unknown): v is Locale => v === "it" || v === "en";

export function resolveLocale(session: SessionData | null, cookieValue: string | undefined): Locale {
  if (isLocale(session?.user.locale)) return session.user.locale;
  return isLocale(cookieValue) ? cookieValue : DEFAULT_LOCALE;
}

export function errorMessage(messages: Messages, code: string): string {
  const errors = messages.errors as Record<string, string>;
  return Object.hasOwn(errors, code) ? errors[code]! : messages.errors.generic;
}
