'use client';

import React, { useState } from 'react';
import AdvancedModeModal from './AdvancedModeModal';
import { useGlobalLogs } from '@/context/GlobalLogContext';
import { useBotContext } from '@/context/BotContext';
import { UserStrategy } from '@/context/BotLogicContext';

const DEFAULT_PRESET = `
// On devnet, context.minTradeAmount is the minimum allowed trade size for the selected token/pool.
// Use this value for all trades; you can randomize or override it in your logic.
/**
 * Default Strategy (Per-Bot Mode)
 * Runs for each bot individually. Buys 0.01 if price is under 0.5.
 * Context:
 * - market: { lastPrice, ... }
 * - buy(amount, options?) – auto-routed (Jupiter on Mainnet, Raydium on Devnet)
 * - sell(amount, options?)
 * - log(msg)
 */
exports.strategy = async (wallet, log, context) => {
log('[strategy] Default per-bot strategy start for ' + wallet.publicKey.toBase58());
  log('[strategy] Market state: ' + JSON.stringify(context.market));
  if (!context.token?.address) {
    log('no token configured');
    return;
  }
  if (context.market.lastPrice < 0.5) {
  log('[strategy] Buying token');
    await context.buy(0.01);
    log('Bought 0.01');
     } else {
    log('No buy: price >= 0.5');
  }
    log('[strategy] Default per-bot strategy complete');
};`;

const MARKET_MAKER_PRESET = `
// On devnet, context.minTradeAmount is the minimum allowed trade size for the selected token/pool.
// Use this value for all trades; you can randomize or override it in your logic.
/**
 * Market Maker Strategy (Per-Bot Mode)
 * Buys below and sells above a price spread.
 * Context:
 * - market: { lastPrice, avgPrice }
 * - buy/sell/log as above.
 */
exports.strategy = async (wallet, log, context) => {
log('[strategy] Market maker per-bot strategy start for ' + wallet.publicKey.toBase58());
  log('[strategy] Market state: ' + JSON.stringify(context.market));
  const spread = 0.05;
  const { lastPrice, avgPrice = lastPrice } = context.market;
  if (lastPrice < avgPrice * (1 - spread)) {
  log('[strategy] Maker buy');
    await context.buy(0.01, { slippage: 0.3 });
    log(\`Market maker buy at \${lastPrice}\`);
  } else if (lastPrice > avgPrice * (1 + spread)) {
   log('[strategy] Maker sell');
    await context.sell(0.01, { slippage: 0.3 });
    log(\`Market maker sell at \${lastPrice}\`);
  } else {
    log('No trade (within spread)');
  }
    log('[strategy] Market maker per-bot strategy complete');
};`;

const DEFAULT_GROUP_PRESET = `
// On devnet, context.minTradeAmount is the minimum allowed trade size for the selected token/pool.
// Use this value for all trades; you can randomize or override it in your logic.
/**
 * Default Strategy (Group Mode)
 * Runs once, loops through all bots, buys 0.01 if price < 0.5.
 * Context:
 * - bots: Array of bot contexts ({ wallet, publicKey, market, buy, sell, log })
 * - log(msg)
 */
exports.strategy = async (log, context) => {
  log('[strategy] Group strategy running. Bots: ' + context.bots.length);
  for (const bot of context.bots) {
    log('[strategy] Bot ' + bot.publicKey.toBase58() + ' market.lastPrice=' + bot.market.lastPrice);
    if (bot.market.lastPrice < 0.5) {
      log('[strategy] Bot ' + bot.publicKey.toBase58() + ' is about to BUY');
      await bot.buy(0.01);
      bot.log('Group buy for bot ' + bot.publicKey.toBase58());
    } else {
      bot.log('No buy: price >= 0.5');
    }
  }
  log('[strategy] Group default strategy complete');
};`;

const GROUP_MARKET_MAKER_PRESET = `
// On devnet, context.minTradeAmount is the minimum allowed trade size for the selected token/pool.
// Use this value for all trades; you can randomize or override it in your logic.
/**
 * Market Maker Strategy (Group Mode)
 * Loops through all bots, buys below and sells above spread.
 * Context:
 * - bots: see above.
 */
exports.strategy = async (log, context) => {
  log('[strategy] Group market maker strategy running');
  const spread = 0.05;
  for (const bot of context.bots) {
    const lastPrice = bot.market.lastPrice;
    const avgPrice = bot.market.avgPrice || lastPrice;
    log('[strategy] Bot ' + bot.publicKey.toBase58() + ' lastPrice=' + lastPrice);
    if (lastPrice < avgPrice * (1 - spread)) {
      log('[strategy] Bot ' + bot.publicKey.toBase58() + ' maker BUY');
      await bot.buy(0.01, { slippage: 0.3 });
      bot.log('Market maker buy at ' + lastPrice);
    } else if (lastPrice > avgPrice * (1 + spread)) {
      log('[strategy] Bot ' + bot.publicKey.toBase58() + ' maker SELL');
      await bot.sell(0.01, { slippage: 0.3 });
      bot.log('Market maker sell at ' + lastPrice);
    } else {
      bot.log('No trade (within spread)');
    }
  }
  log('[strategy] Group market maker strategy complete');
};`;


// Define the props for the component
interface GlobalBotControlsProps {
    isLogicEnabled: boolean;
    onToggleLogic: (isEnabled: boolean) => void;
    botCode: string;
    setBotCode: (code: string) => void;
    onSelectPreset: (preset: string) => void;
    executionMode: 'per-bot' | 'group';
    onModeChange: (mode: 'per-bot' | 'group') => void;
    isAdvancedMode: boolean;
    onToggleAdvancedMode: (checked: boolean) => void;
    userStrategies: UserStrategy[];
    onSaveCurrentStrategy: (name: string) => void;
    onLoadStrategy: (id: string) => void;
    onDeleteStrategy: (id: string) => void;
}

export default function GlobalBotControls({
    isLogicEnabled,
    onToggleLogic,
    botCode,
    setBotCode,
    onSelectPreset,
    executionMode,
    onModeChange,
    isAdvancedMode,
    onToggleAdvancedMode,
    userStrategies,
    onSaveCurrentStrategy,
    onLoadStrategy,
    onDeleteStrategy,
}: GlobalBotControlsProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [showAdvancedModal, setShowAdvancedModal] = useState(false);
    const { startTrading, stopTrading, getSystemState } = useBotContext();
    const { append } = useGlobalLogs();
    const handleModeChange = (value: 'per-bot' | 'group') => {
        onModeChange(value);
        const trimmed = botCode.trim();
        const isDefault =
            trimmed === DEFAULT_PRESET.trim() ||
            trimmed === DEFAULT_GROUP_PRESET.trim();
        const isMaker =
            trimmed === MARKET_MAKER_PRESET.trim() ||
            trimmed === GROUP_MARKET_MAKER_PRESET.trim();
        if (isDefault) {
            onSelectPreset(value === 'per-bot' ? DEFAULT_PRESET : DEFAULT_GROUP_PRESET);
        } else if (isMaker) {
            onSelectPreset(value === 'per-bot' ? MARKET_MAKER_PRESET : GROUP_MARKET_MAKER_PRESET);
        }
    };

    const handleToggle = (checked: boolean) => {
        onToggleLogic(checked);
        if (checked) startTrading(); else stopTrading();
    };

    const handleAdvancedChange = (checked: boolean) => {
        if (checked) {
            setShowAdvancedModal(true);
        } else {
            onToggleAdvancedMode(false);
        }
    };

    return (
        <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
            { }
            <div 
                className="p-4 cursor-pointer flex justify-between items-center"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <h2 className="text-xl font-bold text-white">
                    Global Bot Controls
                </h2>
                <span className={`transition-transform transform text-white ${isExpanded ? 'rotate-180' : ''}`}>
                    ▼
                </span>
            </div>
            
            {/* Content is conditionally rendered based on the expanded state */}
            {isExpanded && (
                <div className="p-4 border-t border-gray-600 space-y-4">
                    <div className="flex items-center justify-between">
                        <label htmlFor="auto-trade-toggle" className="font-semibold text-gray-200">
                            Automated Trading Logic
                        </label>
                        <div className="flex items-center cursor-pointer">
                            <div className="relative">
                                <input
                                    type="checkbox"
                                    id="auto-trade-toggle"
                                    className="absolute inset-0 opacity-0 cursor-pointer"
                                    checked={isLogicEnabled}
                                    onChange={(e) => handleToggle(e.target.checked)} 
                                />
                                <div className={`block ${isLogicEnabled ? 'bg-green-600' : 'bg-gray-600'} w-14 h-8 rounded-full`}></div>
                                <div className={`dot absolute left-1 top-1 bg-white w-6 h-6 rounded-full transition-transform ${isLogicEnabled ? 'translate-x-6' : ''}`}></div>
                            </div>
                            <div className="ml-3 text-white font-bold">{isLogicEnabled ? 'ON' : 'OFF'}</div>
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-semibold text-gray-200 mb-1">Bot Code</label>
                        <textarea
                            className="w-full bg-gray-900 text-gray-200 p-2 rounded-md text-sm font-mono"
                            rows={6}
                            value={botCode}
                            onChange={(e) => setBotCode(e.target.value)}
                        />
                        <button
                            className="mt-2 px-2 py-1 text-sm bg-blue-700 rounded-md"
                            onClick={() => {
                                const name = prompt('Enter a name for this strategy:');
                                if (name) onSaveCurrentStrategy(name);
                            }}
                        >
                            Save Current Strategy
                        </button>
                    </div>

                    <div>
                        <h4 className="font-semibold text-gray-200 mb-1">Presets</h4>
                        <button
                            className="px-2 py-1 text-sm bg-gray-700 rounded-md"
                            onClick={() => onSelectPreset(executionMode === 'per-bot' ? DEFAULT_PRESET : DEFAULT_GROUP_PRESET)}
                        >
                            Use Default Template
                        </button>
                        <button
                            className="px-2 py-1 text-sm bg-gray-700 rounded-md ml-2"
                            onClick={() =>
                                onSelectPreset(
                                    executionMode === 'per-bot'
                                        ? MARKET_MAKER_PRESET
                                        : GROUP_MARKET_MAKER_PRESET
                                )
                            }
                        >
                            Market Maker Logic
                        </button>
                    </div>

                    <div className="flex items-center space-x-2">
                        <input
                            id="advanced-toggle"
                            type="checkbox"
                            checked={isAdvancedMode}
                              onChange={(e) => handleAdvancedChange(e.target.checked)}
                        />
                        <label htmlFor="advanced-toggle" className="text-sm text-gray-200">Advanced Mode</label>
                        <select
                            className="ml-4 bg-gray-700 text-white text-xs rounded"
                            value={executionMode}
                            onChange={(e) => handleModeChange(e.target.value as 'per-bot' | 'group')}
                        >
                            <option value="per-bot">Per-Bot Mode</option>
                            <option value="group">Group Mode</option>
                        </select>
                    </div>
                    {isAdvancedMode && (
                        <p className="text-xs text-red-400">
                            Advanced mode executes custom code and may have compliance risks.
                        </p>
                    )}
                    <div>
                        <h4 className="font-semibold text-gray-200 mb-1">My Strategies</h4>
                        {userStrategies.length === 0 ? (
                            <p className="text-sm text-gray-400">No saved strategies.</p>
                        ) : (
                            <ul className="space-y-1">
                                {userStrategies.map((s) => (
                                    <li key={s.id} className="flex justify-between items-center">
                                        <span className="text-sm text-gray-200">{s.name}</span>
                                        <div className="space-x-1">
                                            <button
                                                className="px-1 py-0.5 text-xs bg-gray-700 rounded-md"
                                                onClick={() => onLoadStrategy(s.id)}
                                            >
                                                Load
                                            </button>
                                            <button
                                                className="px-1 py-0.5 text-xs bg-red-700 rounded-md"
                                                onClick={() => onDeleteStrategy(s.id)}
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            )}
            {showAdvancedModal && (
                <AdvancedModeModal
                    onConfirm={() => {
                        onToggleAdvancedMode(true);
                        const state = getSystemState();
                        const botCount = state.allBots.length;
                        const tradeTotal = Object.values(state.tradeCounts).reduce(
                          (a, b) => a + b,
                          0
                        );
                        append(
                          `Advanced mode enabled. ${botCount} bots and ${tradeTotal} total trades exposed via context.systemState.`
                        );
                        setShowAdvancedModal(false);
                    }}
                    onCancel={() => setShowAdvancedModal(false)}
                />
            )}
        </div>
    );
}