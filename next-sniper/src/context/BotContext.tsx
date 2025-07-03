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


// Template used when initializing new bot code in the editor
export const DEFAULT_BOT_CODE = `
/**
 * Default Strategy (Per-Bot Mode)
 * Runs for each bot individually. Buys 0.01 if price is under 0.5.
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
    await context.buy(0.01);
    log('Bought 0.01');
  }
};`;

export const DEFAULT_GROUP_BOT_CODE = `
/**
 * Default Strategy (Group Mode)
 * Runs once, loops through all bots, buys 0.01 if price < 0.5.
 * Context:
 *   - bots: Array of bot contexts ({ wallet, publicKey, market, buy, sell, log })
 *   - log(msg)
 */
exports.strategy = async (log, context) => {
  for (const bot of context.bots) {
    if (bot.market.lastPrice < 0.5) {
      await bot.buy(0.01);
      bot.log('Group buy for bot ' + bot.publicKey.toBase58());
    }
  }
};`;

export interface BotInstance {
  id: string;
  secret: number[];
}

// Map each network to its associated trading bots. The keys must exactly match
// NetworkContext's `NetworkType` so we can safely index with the current
// network value throughout the app.
export type BotsByNetwork = Record<NetworkType, BotInstance[]>;

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
  getSystemState: () => { allBots: BotInstance[]; tradeCounts: Record<string, number> };
}

export const BotContext = createContext<BotContextState | undefined>(undefined);

export const BotProvider = ({ children }: { children: React.ReactNode }) => {
  const [allBotsByNetwork, setAllBotsByNetwork] = useState<BotsByNetwork>({
    devnet: [],
    'mainnet-beta': [],
  });
  const { network, rpcUrl } = useNetwork();
  const { lastPrice, currentMarketCap, currentLpValue, solUsdPrice } =
    useChartData();
  const { tokenAddress, isLpActive } = useToken();
  const [botCode, setBotCode] = useState(DEFAULT_BOT_CODE);
  const [executionMode, setExecutionMode] = useState<'per-bot' | 'group'>('per-bot');
  const [isAdvancedMode, setIsAdvancedMode] = useState(false);
  const [isTradingActive, setIsTradingActive] = useState(false);
  const tradeCountsRef = useRef<Record<string, number>>({});
  const workerRef = useRef<Worker | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const runBotLogicRef = useRef<(() => void) | null>(null);
  const { append } = useGlobalLogs();

  const getSystemState = useCallback(() => {
    return {
      allBots: Object.values(allBotsByNetwork).flat(),
      tradeCounts: { ...tradeCountsRef.current },
    };
  }, [allBotsByNetwork]);

  const runBotLogic = useCallback(() => {
    if (!workerRef.current) {
      // Use the worker directly from the public folder to avoid Turbopack issues
      workerRef.current = new Worker('/workers/bot-worker.js', { type: 'module' });
      workerRef.current.onmessage = (ev) => {
        const { log, error } = ev.data || {};
        if (log) append(log);
        if (error) append(`error: ${error}`);
      };
      workerRef.current.onerror = (e) => {
        append(`error: ${e.message}`);
      };
      append('[app] Worker created');
    }
    const bots = allBotsByNetwork[network] || [];
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
       token: { address: tokenAddress },
      isLpActive,
      market: {
        lastPrice,
        currentMarketCap,
        currentLpValue,
        solUsdPrice,
      },
      isAdvancedMode,
    };
    if (isAdvancedMode) {
      context.systemState = systemState;
    }
    workerRef.current.postMessage({
      code: botCode,
      bots: bots.map((b) => b.secret),
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
  ]);

  const startTrading = useCallback(() => {
    setIsTradingActive(true);
    append('[app] Trading started');
  }, []);
  const stopTrading = useCallback(() => {
    setIsTradingActive(false);
    append('[app] Trading stopped');
  }, []);

  useEffect(() => {
    runBotLogicRef.current = runBotLogic;
  }, [runBotLogic]);

  useEffect(() => {
    if (isTradingActive) {
     runBotLogicRef.current?.();
      intervalRef.current = setInterval(() => {
        runBotLogicRef.current?.();
      }, 5000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
        append('[app] Worker terminated');
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (workerRef.current) {
        workerRef.current.terminate();
        append('[app] Worker terminated');
      }
    };
  }, [isTradingActive]);

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
    getSystemState,
  };

  return <BotContext.Provider value={value}>{children}</BotContext.Provider>;
};

export const useBotContext = () => {
  const ctx = useContext(BotContext);
  if (!ctx) throw new Error('useBotContext must be used within BotProvider');
  return ctx;
};
