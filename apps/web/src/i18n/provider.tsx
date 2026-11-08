"use client";

import { createContext, useContext } from "react";
import type { Locale, Messages } from "./index";

const Ctx = createContext<{ locale: Locale; messages: Messages } | null>(null);

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={{ locale, messages }}>{children}</Ctx.Provider>;
}

function useCtx() {
  const v = useContext(Ctx);
  if (!v) throw new Error("I18nProvider missing");
  return v;
}

export const useMessages = (): Messages => useCtx().messages;
export const useLocale = (): Locale => useCtx().locale;
