'use client';
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { NetworkType } from './NetworkContext';

interface BalanceInfo {
  sol: number;
  token: number;
  tradeCount: number;
}

interface WalletBalanceCtx {
  balances: Record<string, BalanceInfo>;
  refreshBalance: (
    network: NetworkType,
    connection: Connection,
    wallet: PublicKey,
    tokenMint: string
  ) => Promise<BalanceInfo>;
  updateAfterTrade: (
    network: NetworkType,
    connection: Connection,
    wallet: PublicKey,
    solChange: number,
    tokenChange: number,
    tokenMint: string
  ) => Promise<void>;
}

const WalletBalanceContext = createContext<WalletBalanceCtx | undefined>(undefined);

export const WalletBalanceProvider = ({ children }: { children: React.ReactNode }) => {
  const [balances, setBalances] = useState<Record<string, BalanceInfo>>({});

   const fetchTokenBalance = useCallback(async (
    connection: Connection,
    wallet: PublicKey,
    mint: string,
  ) => {
    try {
      if (!mint) return 0;
      const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet);
      const res = await connection.getTokenAccountBalance(ata, 'confirmed');
      return res.value.uiAmount || 0;
    } catch {
      return 0;
    }
   }, []);

 const refreshBalance = useCallback(async (
    network: NetworkType,
    connection: Connection,
    wallet: PublicKey,
    tokenMint: string
  ): Promise<BalanceInfo> => {
    const lamports = await connection.getBalance(wallet);
    const sol = lamports / 1e9;
    const token = await fetchTokenBalance(connection, wallet, tokenMint);
    const info: BalanceInfo = { sol, token, tradeCount: 0 };
    setBalances((prev) => ({ ...prev, [wallet.toBase58()]: info }));
    return info;
  }, [fetchTokenBalance]);

  const updateAfterTrade = useCallback(async (
    network: NetworkType,
    connection: Connection,
    wallet: PublicKey,
    solChange: number,
    tokenChange: number,
    tokenMint: string
  ) => {
    let tradeCount = 0;
    setBalances((prev) => {
      const existing = prev[wallet.toBase58()] || { sol: 0, token: 0, tradeCount: 0 };
      tradeCount = existing.tradeCount + 1;
      return {
        ...prev,
        [wallet.toBase58()]: {
          sol: existing.sol + solChange,
          token: existing.token + tokenChange,
          tradeCount,
        },
      };
    });

    if (network === 'mainnet-beta' || tradeCount % 5 === 0) {
      await refreshBalance(network, connection, wallet, tokenMint);
    }
  }, [refreshBalance]);

  const contextValue = useMemo(
    () => ({ balances, refreshBalance, updateAfterTrade }),
    [balances, refreshBalance, updateAfterTrade],
  );

  return (
   <WalletBalanceContext.Provider value={contextValue}>
      {children}
    </WalletBalanceContext.Provider>
  );
};

export const useWalletBalances = () => {
  const ctx = useContext(WalletBalanceContext);
  if (!ctx) throw new Error('useWalletBalances must be used within WalletBalanceProvider');
  return ctx;
};