import { getSimulatedPool } from './simulatedPoolStore';
import type { NetworkType } from '../context/NetworkContext';

/**
 * Calculate the minimum SOL amount that returns a non-zero output
 * when swapping against the given pool. Only applies on devnet.
 */
export interface MinTradeResult {
  amount: number;
  usedFallback: boolean;
}

/**
 * Return the estimated SOL amount needed to buy a single token
 * from the simulated pool. Falls back to 0.01 SOL if reserves
 * are missing or the calculation yields an invalid result.
 */
export function calculateMinTradeAmount(
  tokenAddress: string,
  network: NetworkType
): MinTradeResult | null {
  if (network !== 'devnet') return null;

  const pool = getSimulatedPool();
  if (!pool || pool.tokenAddress !== tokenAddress.toLowerCase()) return null;

  const tokenReserve = pool.tokenAmount;
  const solReserve = pool.solAmount;
  const tokenDecimals = pool.tokenDecimals ?? 9;

 const fallback = { amount: 0.01, usedFallback: true } as MinTradeResult;

  if (tokenReserve <= 0 || solReserve <= 0) return fallback;

  const oneToken = 1 / Math.pow(10, tokenDecimals);
  const denominator = 0.997 * (tokenReserve - oneToken);
  if (denominator <= 0) return fallback;

  const rawAmount = (oneToken * solReserve) / denominator;
  if (!isFinite(rawAmount) || rawAmount <= 0) return fallback;

  const rounded = parseFloat(Math.max(rawAmount, 0.01).toFixed(6));
  return { amount: rounded, usedFallback: false };
}