'use client';

import React, { createContext, useContext, useRef, useCallback, useMemo } from 'react';

interface BotWalletReloadCtx {
  reloadWallets: () => void;
  registerReloader: (fn: () => void) => void;
}

const BotWalletReloadContext = createContext<BotWalletReloadCtx | undefined>(undefined);

export const BotWalletReloadProvider = ({ children }: { children: React.ReactNode }) => {
  const reloadRef = useRef<() => void>(() => {});

  const registerReloader = useCallback((fn: () => void) => {
    reloadRef.current = fn;
 }, []);

  const reloadWallets = useCallback(() => {
    reloadRef.current();
  }, []);

  const value = useMemo(() => ({ reloadWallets, registerReloader }), [reloadWallets, registerReloader]);

  return (
    <BotWalletReloadContext.Provider value={value}>
      {children}
    </BotWalletReloadContext.Provider>
  );
};

export const useBotWalletReload = () => {
  const ctx = useContext(BotWalletReloadContext);
  if (!ctx) throw new Error('useBotWalletReload must be used within BotWalletReloadProvider');
  return ctx;
};