import { getSimulatedPool } from './simulatedPoolStore';
import type { NetworkType } from '../context/NetworkContext';

/**
 * Calculate the minimum SOL amount that returns a non-zero output
 * when swapping against the given pool. Only applies on devnet.
 */
export function calculateMinTradeAmount(tokenAddress: string, network: NetworkType): number | null {
  if (network !== 'devnet') return null;
  const pool = getSimulatedPool();
  if (!pool || pool.tokenAddress !== tokenAddress.toLowerCase()) return null;

  const tokenReserve = pool.tokenAmount;
  const solReserve = pool.solAmount;
  const tokenDecimals = pool.tokenDecimals ?? 9;

  if (tokenReserve <= 0 || solReserve <= 0) return null;

  let amount = 0.000001; // Start at 0.000001 SOL
  for (let i = 0; i < 20; i++) {
    const inputWithFee = amount * 0.997;
    const output = (inputWithFee * tokenReserve) / (solReserve + inputWithFee);
    if (output * Math.pow(10, tokenDecimals) >= 1) {
      return parseFloat(amount.toFixed(6));
    }
    amount *= 2;
  }

  return null;
}