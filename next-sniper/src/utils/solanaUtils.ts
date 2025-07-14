export function toLamports(amount: number, decimals: number): number {
  return Math.floor(amount * 10 ** decimals);
}