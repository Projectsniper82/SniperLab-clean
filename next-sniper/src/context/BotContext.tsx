'use client';

import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
} from 'react';
import { useGlobalLogs } from './GlobalLogContext';
import type { NetworkType } from './NetworkContext';
import { useNetwork } from './NetworkContext';
import { useChartData } from './ChartDataContext';
import { useToken } from './TokenContext';
import { useWalletBalances } from './WalletBalanceContext';
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { getSimulatedPool } from '../utils/simulatedPoolStore';
import { calculateMinTradeAmount } from '../utils/minTradeAmount';

// Template used when initializing new bot code in the editor
export const DEFAULT_BOT_CODE = `
// On devnet, context.minTradeAmount is set automatically by the app
// and is always the minimum viable trade amount for the current token/pool.
// Preset code always uses this value directly, and does not include any randomness.
// You may copy this code and add your own randomization or logic in your own strategies.
// Smart users may randomize or modify minTradeAmount for their custom logic. See documentation for advanced usage.
// When Advanced Mode is enabled, context.walletBalances maps each bot wallet
// address to its current balances.
// When Advanced Mode is enabled, context.walletBalances provides current SOL
// and token balances for each bot wallet keyed by address.
/**
 * Default Strategy (Per-Bot Mode)
 * Runs for each bot individually. Buys minTradeAmount on devnet
 * or 0.01 on mainnet if price is under 0.5.
 * Context:
 *   - market: { lastPrice, ... }
 *   - buy(amount, options?) – auto-routed (Jupiter on Mainnet, Raydium on Devnet)
 *   - sell(amount, options?)
 *   - log(msg)
 */
exports.strategy = async (wallet, log, context) => {
  if (!context.token?.address) {
    log('no token configured');
    return;
  }
  if (context.market.lastPrice < 0.5) {
   if (context.network === 'devnet') {
      if (typeof context.minTradeAmount !== 'number') {
        log('Cannot trade: minTradeAmount not set');
        return;
      }
      log('Using min trade amount: ' + context.minTradeAmount);
      await context.buy(context.minTradeAmount);
      log('Bought min trade amount');
    } else {
      await context.buy(0.01);
      log('Bought 0.01 (mainnet)');
    }
  }
};`;

export const DEFAULT_GROUP_BOT_CODE = `
// On devnet, context.minTradeAmount is set automatically by the app
// and is always the minimum viable trade amount for the current token/pool.
// Preset code always uses this value directly, and does not include any randomness.
// You may copy this code and add your own randomization or logic in your own strategies.
// Smart users may randomize or modify minTradeAmount for their custom logic. See documentation for advanced usage.
/**
 * Default Strategy (Group Mode)
 * Runs once, loops through all bots, buys minTradeAmount on devnet
 * or 0.01 on mainnet if price < 0.5.
 * Context:
 *   - bots: Array of bot contexts ({ wallet, publicKey, market, buy, sell, log })
 *   - log(msg)
 */
exports.strategy = async (log, context) => {
  for (const bot of context.bots) {
    if (bot.market.lastPrice < 0.5) {
      if (context.network === 'devnet') {
      if (typeof context.minTradeAmount !== 'number') {
        log('Cannot trade: minTradeAmount not set');
        return;
      }
      log('Using min trade amount: ' + context.minTradeAmount);
      await bot.buy(context.minTradeAmount);
      bot.log('Group buy for bot ' + bot.publicKey.toBase58());
      } else {
        await bot.buy(0.01);
        bot.log('Group buy for bot ' + bot.publicKey.toBase58() + ' (0.01 mainnet)');
      }
    }
  }
};`;

export interface BotInstance {
  id: string;
  /**
   * Secret key bytes for the wallet. This must be exactly 64 bytes so the
   * worker can reconstruct a Keypair instance.
   */
  secretKey: number[];
}

// Map each network to its associated trading bots. The keys must exactly match
// NetworkContext's `NetworkType` so we can safely index with the current
// network value throughout the app.
export type BotsByNetwork = Record<NetworkType, BotInstance[]>;

export interface TradeIntervalConfig {
  mode: 'fixed' | 'random';
  fixed: number; // seconds
  min: number; // seconds
  max: number; // seconds
}


interface BotContextState {
  allBotsByNetwork: BotsByNetwork;
  setAllBotsByNetwork: React.Dispatch<React.SetStateAction<BotsByNetwork>>;
  botCode: string;
  setBotCode: React.Dispatch<React.SetStateAction<string>>;
  executionMode: 'per-bot' | 'group';
  setExecutionMode: React.Dispatch<React.SetStateAction<'per-bot' | 'group'>>;
  isAdvancedMode: boolean;
  setIsAdvancedMode: React.Dispatch<React.SetStateAction<boolean>>;
  isTradingActive: boolean;
  setIsTradingActive: React.Dispatch<React.SetStateAction<boolean>>;
  startTrading: () => void;
  stopTrading: () => void;
  minTradeAmount: number | null;
  setMinTradeAmount: React.Dispatch<React.SetStateAction<number | null>>;
  tradeIntervalConfig: TradeIntervalConfig;
  setTradeIntervalConfig: (cfg: TradeIntervalConfig) => void;
  getSystemState: () => { allBots: BotInstance[]; tradeCounts: Record<string, number> };
}

export const BotContext = createContext<BotContextState | undefined>(undefined);

export const BotProvider = ({ children }: { children: React.ReactNode }) => {
  const [allBotsByNetwork, setAllBotsByNetwork] = useState<BotsByNetwork>({
    devnet: [],
    'mainnet-beta': [],
  });
  const { network, rpcUrl, connection } = useNetwork();
  const { lastPrice, currentMarketCap, currentLpValue, solUsdPrice } =
    useChartData();
  const { tokenAddress, tokenDecimals, setTokenDecimals, isLpActive, setTokenAddress } = useToken();
  const { balances: walletBalances, updateAfterTrade } = useWalletBalances();

  const loadBotCode = (net: NetworkType) => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(`botCode-${net}`);
      if (saved) return saved;
    }
    return DEFAULT_BOT_CODE;
  };

  const [botCodeByNetwork, setBotCodeByNetwork] = useState<Record<NetworkType, string>>({
    devnet: loadBotCode('devnet'),
    'mainnet-beta': loadBotCode('mainnet-beta'),
  });

  const botCode = botCodeByNetwork[network];
  const setBotCode = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (val) => {
      setBotCodeByNetwork((prev) => {
        const current = prev[network];
        const newValue = typeof val === 'function' ? (val as any)(current) : val;
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(`botCode-${network}`, newValue);
        }
        return { ...prev, [network]: newValue };
      });
    },
    [network]
  );
  const [executionMode, setExecutionMode] = useState<'per-bot' | 'group'>('per-bot');
  const [isAdvancedMode, setIsAdvancedMode] = useState(false);
  const [isTradingActive, setIsTradingActive] = useState(false);
  const isTradingActiveRef = useRef(isTradingActive);
  const [minTradeAmount, setMinTradeAmount] = useState<number | null>(null);
  const defaultInterval: TradeIntervalConfig = { mode: 'fixed', fixed: 5, min: 1, max: 2 };
  const loadInterval = (net: NetworkType): TradeIntervalConfig => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(`tradeInterval-${net}`);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          return { ...defaultInterval, ...parsed };
        } catch {}
      }
    }
    return defaultInterval;
  };

  const [tradeIntervalsByNetwork, setTradeIntervalsByNetwork] = useState<Record<NetworkType, TradeIntervalConfig>>({
    devnet: loadInterval('devnet'),
    'mainnet-beta': loadInterval('mainnet-beta'),
  });

  const tradeIntervalConfig = tradeIntervalsByNetwork[network];
  const tradeIntervalRef = useRef<TradeIntervalConfig>(tradeIntervalConfig);
  const setTradeIntervalConfig = useCallback(
    (cfg: TradeIntervalConfig) => {
      setTradeIntervalsByNetwork((prev) => {
        const updated = { ...prev, [network]: cfg };
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(`tradeInterval-${network}`, JSON.stringify(cfg));
        }
        return updated;
      });
    },
    [network]
  );
  const tradeCountsRef = useRef<Record<string, number>>({});
  const workerRef = useRef<Worker | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const runBotLogicRef = useRef<(() => void) | null>(null);
  const { append } = useGlobalLogs();

  const lastLpValueRef = useRef<number>(0);

  const updateMinTrade = useCallback(() => {
    if (!tokenAddress) {
      setMinTradeAmount((prev) => {
        if (prev !== null) {
          append('[app] No token selected. Minimum trade amount is not available.');
          return null;
        }
        return prev;
      });
      return;
    }
   const result = calculateMinTradeAmount(tokenAddress, network);

    if (!result) {
      setMinTradeAmount((prev) => {
        if (prev !== null) {
          append('[app] minTradeAmount unavailable');
          return null;
        }
        return prev;
      });
      return;
    }

    setMinTradeAmount((prev) => {
      if (prev !== result.amount) {
        append(`[app] Min trade calculated: ${result.amount} SOL`);
        if (result.usedFallback) {
          append('[app] WARNING: Pool too shallow, using fallback min trade amount: 0.01 SOL');
        }
       return result.amount
      }
      return prev;
    });
  }, [tokenAddress, network, append]);

  const getSystemState = useCallback(() => {
    return {
      allBots: Object.values(allBotsByNetwork).flat(),
      tradeCounts: { ...tradeCountsRef.current },
    };
  }, [allBotsByNetwork]);

  const runBotLogic = useCallback(() => {
    if (!workerRef.current) {
      // Load the worker via a static URL so Turbopack can bundle it
      workerRef.current = new Worker(
        new URL('../workers/bot-worker.js', import.meta.url),
        { type: 'module' }
      );
      workerRef.current.onmessage = (ev) => {
        const { log, error, balanceUpdate } = ev.data || {};
        if (log) append(log);
        if (error) append(`error: ${error}`);
         if (balanceUpdate) {
          const { wallet, solChange = 0, tokenChange = 0 } = balanceUpdate;
          try {
            updateAfterTrade(network, connection, new PublicKey(wallet), solChange, tokenChange, tokenAddress);
          } catch (e) {
            console.error('balance update failed', e);
          }
        }
      };
      workerRef.current.onerror = (e) => {
        append(`error: ${e.message}`);
      };
      append('[app] Worker created');
    }
    const bots = allBotsByNetwork[network] || [];
    const botSecrets = bots.map((b) =>
      b.secretKey instanceof Uint8Array ? b.secretKey : Uint8Array.from(b.secretKey)
    );
    if (bots.length === 0) {
      append('[app] Warning: no bots configured');
    }
    if (!tokenAddress) {
      append('[app] Warning: no token selected');
    }
    bots.forEach((b) => {
      tradeCountsRef.current[b.id] = (tradeCountsRef.current[b.id] || 0) + 1;
    });
    const systemState = getSystemState();
    const context: any = {
      rpcUrl,
      network,
      token: { address: tokenAddress, decimals: tokenDecimals ?? undefined },
      isLpActive,
      market: {
        lastPrice,
        currentMarketCap,
        currentLpValue,
        solUsdPrice,
      },
      isAdvancedMode,
      minTradeAmount,
      walletBalances,
    };

   if (network === 'devnet') {
      const pool = getSimulatedPool();
      if (pool) {
        context.poolId = pool.raydiumPoolId || pool.id;
        if (pool.tokenDecimals !== undefined) {
          context.token.decimals = pool.tokenDecimals;
        }
      }
    } 
    if (isAdvancedMode) {
      context.systemState = systemState;
 append(`[app] Launching worker with ${botSecrets.length} bot(s)`);
      append(
        JSON.stringify(botSecrets.map((s) => Buffer.from(s).toString('base64')))
      );
    }
    workerRef.current.postMessage({
      code: botCode,
      bots: botSecrets,
      context,
      mode: executionMode,
    });
  }, [
    allBotsByNetwork,
    botCode,
    network,
    rpcUrl,
    lastPrice,
    currentMarketCap,
    currentLpValue,
    solUsdPrice,
    isAdvancedMode,
    executionMode,
    tokenAddress,
    isLpActive,
    minTradeAmount,
    walletBalances,
  ]);

  const startTrading = useCallback(() => {
    updateMinTrade();
     isTradingActiveRef.current = true;
    setIsTradingActive(true);
    append('[app] Trading started');
  }, [updateMinTrade, append]);
  const stopTrading = useCallback(() => {
     isTradingActiveRef.current = false;
    setIsTradingActive(false);
    append('[app] Trading stopped');
  }, []);

  useEffect(() => {
    runBotLogicRef.current = runBotLogic;
  }, [runBotLogic]);

   useEffect(() => {
    isTradingActiveRef.current = isTradingActive;
  }, [isTradingActive]);

  useEffect(() => {
    updateMinTrade();
  }, [tokenAddress, network, updateMinTrade]);

   const previousNetworkRef = useRef<NetworkType>(network);
  useEffect(() => {
    if (previousNetworkRef.current !== network) {
      stopTrading();
      setTokenAddress('');
      setTokenDecimals(null);
      previousNetworkRef.current = network;
    }
  }, [network, stopTrading, setTokenAddress, setTokenDecimals]);

  useEffect(() => {
    if (network !== 'devnet') {
     setMinTradeAmount((prev) => (prev !== null ? null : prev));
      lastLpValueRef.current = 0;
      return;
    }

    if (!currentLpValue || currentLpValue === lastLpValueRef.current) {
      return;
    }

    if (lastLpValueRef.current === 0) {
      lastLpValueRef.current = currentLpValue;
      return;
    }
    
    const diff = Math.abs(currentLpValue - lastLpValueRef.current) / lastLpValueRef.current;
    if (diff >= 0.04) {
      lastLpValueRef.current = currentLpValue;
      updateMinTrade();
    }
  }, [currentLpValue, network, updateMinTrade]);

  const scheduleNext = useCallback(() => {
    if (!isTradingActiveRef.current) return;
    const cfg = tradeIntervalRef.current;
    const delaySec =
      cfg.mode === 'fixed'
        ? cfg.fixed
        : cfg.min + Math.random() * (cfg.max - cfg.min);
    const delayMs = delaySec * 1000;
    intervalRef.current = setTimeout(() => {
      if (!isTradingActiveRef.current) return;
      runBotLogicRef.current?.();
      scheduleNext();
    }, delayMs);
    }, []);


  useEffect(() => {
    tradeIntervalRef.current = tradeIntervalConfig;
    if (!isTradingActiveRef.current) return;
    if (intervalRef.current) {
      clearTimeout(intervalRef.current);
    }
    scheduleNext();
   }, [tradeIntervalConfig, scheduleNext]);


  useEffect(() => {
    if (isTradingActive) {
    runBotLogicRef.current?.();
      scheduleNext();
    } else {
      if (intervalRef.current) {
        clearTimeout(intervalRef.current);
        intervalRef.current = null;
      }
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
        append('[app] Worker terminated');
      }
    }
    return () => {
      if (intervalRef.current) clearTimeout(intervalRef.current);
      if (workerRef.current) {
        workerRef.current.terminate();
        append('[app] Worker terminated');
      }
    };
  }, [isTradingActive, scheduleNext]);

  const value: BotContextState = {
    allBotsByNetwork,
    setAllBotsByNetwork,
    botCode,
    setBotCode,
    executionMode,
    setExecutionMode,
    isAdvancedMode,
    setIsAdvancedMode,
    isTradingActive,
    setIsTradingActive,
    startTrading,
    stopTrading,
    minTradeAmount,
    setMinTradeAmount,
    tradeIntervalConfig,
    setTradeIntervalConfig,
    getSystemState,
  };

  return <BotContext.Provider value={value}>{children}</BotContext.Provider>;
};

export const useBotContext = () => {
  const ctx = useContext(BotContext);
  if (!ctx) throw new Error('useBotContext must be used within BotProvider');
  return ctx;
};
