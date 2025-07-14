export function toLamports(amount: number, decimals: number): number {
  return Math.floor(amount * 10 ** decimals);
  }

/**
 * Format a large number for display.
 * Mirrors the behaviour of the JavaScript util so that consumers can
 * import from this TypeScript module without issues.
 *
 * @param number - The numeric value to format
 * @param maxDecimals - Maximum decimal places to show
 */
export function formatNumber(number: number, maxDecimals = 2): string {
  if (typeof number !== 'number') return '0';

  if (number < 1e3) return number.toFixed(maxDecimals);
  if (number < 1e6) return `${(number / 1e3).toFixed(maxDecimals)}K`;
  if (number < 1e9) return `${(number / 1e6).toFixed(maxDecimals)}M`;
  return `${(number / 1e9).toFixed(maxDecimals)}B`;
}