
import { Buffer } from 'buffer';
import BN from 'bn.js';
import { NATIVE_MINT } from '@solana/spl-token';
import * as web3 from '@solana/web3.js';
import { swapRaydiumTokens } from '../utils/raydiumSdkAdapter.js';
import { executeJupiterSwap } from '../utils/jupiterSwapUtil';
import { createWalletAdapter } from '../utils/walletAdapter.js';

globalThis.Buffer = globalThis.Buffer || Buffer;

const pausedWallets = {};

function createTradeApi(wallet, ctx, log) {
   const buildAmount = (amt) => {
    const decimals = ctx.token?.decimals || 0;
    return new BN(Math.round(amt * 10 ** decimals));
  };

  return {
    buy: async (amount, opts = {}) => {
       log(`[trade] buy request: amount=${amount}`);
       const key = wallet.publicKey.toBase58();
      const bal = ctx.walletBalances?.[key];
      const fee = 0.00001;
      if (bal && bal.sol < amount + fee) {
        if (!pausedWallets[key]) {
          pausedWallets[key] = true;
          log(`Wallet ${key} balance too low, bot paused`);
        }
        return;
      }
      pausedWallets[key] = false;
      const amountBn = buildAmount(amount);
      const slippageBps = opts.slippageBps || 50;
       let sig;
      if (ctx.network.startsWith('mainnet')) {
        sig = await executeJupiterSwap({
          wallet,
          connection: ctx.connection,
          inputMint: NATIVE_MINT,
          outputMint: new web3.PublicKey(ctx.token.address),
          amount: amountBn,
          slippageBps,
          priorityFeeMicroLamports: opts.priorityFeeMicroLamports || 1000,
        });
         } else {
        const poolId = opts.poolId || ctx.poolId;
        if (!poolId) {
          log('[trade] Missing poolId for Raydium buy');
          throw new Error('poolId required');
        }
        sig = await swapRaydiumTokens(
          wallet,
          ctx.connection,
          poolId,
          NATIVE_MINT.toBase58(),
          amountBn,
          slippageBps / 10000
        );
      }
      self.postMessage({ balanceUpdate: { wallet: key, solChange: -amount } });
      return sig;

    },
    sell: async (amount, opts = {}) => {
      log(`[trade] sell request: amount=${amount}`);
       const key = wallet.publicKey.toBase58();
      const bal = ctx.walletBalances?.[key];
      if (bal && bal.token < amount) {
        if (!pausedWallets[key]) {
          pausedWallets[key] = true;
          log(`Wallet ${key} balance too low, bot paused`);
        }
        return;
      }
      pausedWallets[key] = false;
      const amountBn = buildAmount(amount);
      const slippageBps = opts.slippageBps || 50;
      let sig;
      if (ctx.network.startsWith('mainnet')) {
       sig = await executeJupiterSwap({
          wallet,
          connection: ctx.connection,
          inputMint: new web3.PublicKey(ctx.token.address),
          outputMint: NATIVE_MINT,
          amount: amountBn,
          slippageBps,
          priorityFeeMicroLamports: opts.priorityFeeMicroLamports || 1000,
        });
         } else {
        const poolId = opts.poolId || ctx.poolId;
        if (!poolId) {
          log('[trade] Missing poolId for Raydium sell');
          throw new Error('poolId required');
        }
        sig = await swapRaydiumTokens(
          wallet,
          ctx.connection,
          poolId,
          ctx.token.address,
          amountBn,
          slippageBps / 10000
        );
      }
    self.postMessage({ balanceUpdate: { wallet: key, tokenChange: -amount } });
      return sig;
    }
  };
}

self.onmessage = async (ev) => {
 const { code, bots = [], context = {}, mode = 'per-bot' } = ev.data || {};
  try {
     self.postMessage({ log: `[worker] Received message: mode=${mode}, bots=${bots.length}` });
    // Provide window polyfill similar to walletCreator
    globalThis.window = self;
    if (!globalThis.Buffer) {
      globalThis.Buffer = Buffer;
    }
        const { rpcUrl, network, isAdvancedMode, systemState, token, market, walletBalances, ...restContext } = context;
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    const detectedNetwork = network || (rpcUrl.includes('mainnet') ? 'mainnet-beta' : 'devnet');
    const workerContext = { ...restContext, rpcUrl, network: detectedNetwork, connection, web3, token, market, isAdvancedMode, walletBalances };
    if (systemState) workerContext.systemState = systemState;

    if (!token?.address) {
      self.postMessage({ log: '[worker] Warning: no token configured in context' });
    }
    
    const wallets = bots.map((sk, i) => {
      try {
        const kp = web3.Keypair.fromSecretKey(Uint8Array.from(sk));
       return createWalletAdapter(kp, connection);
      } catch (err) {
        self.postMessage({ log: `[worker] Failed to load bot ${i}: ${err?.message || err}` });
        return null;
      }
    }).filter(Boolean);

    const log = (msg) => {
      self.postMessage({ log: msg });
    };

    const tradeApis = wallets.map((w) => createTradeApi(w, workerContext, log));

    const exports = {};
   let fn;
    try {
      // Compile the strategy code first so syntax errors are reported clearly
      fn = new Function('exports', 'context', code);
    } catch (compileErr) {
      log(`[worker] Failed to compile strategy: ${compileErr?.message || compileErr}`);
      self.postMessage({ error: compileErr?.message || String(compileErr) });
      return;
    }
    try {
      fn(exports, workerContext);
    } catch (execErr) {
      log(`[worker] Error during strategy initialization: ${execErr?.message || execErr}`);
      self.postMessage({ error: execErr?.message || String(execErr) });
      return;
    }

    log(`[worker] Preparing to run strategy (${mode}), wallets=${wallets.length}`);

    if (typeof exports.strategy !== 'function') {
      log('[worker] No strategy function exported');
      return;
    }

    if (wallets.length === 0) {
      log('[worker] No bots provided – nothing to do.');
      return;
    }

    if (mode === 'group') {
       log('[worker] Running group mode strategy');
      const botContexts = wallets.map((wallet, i) => ({
        wallet,
        publicKey: wallet.publicKey,
        market: workerContext.market,
        buy: tradeApis[i].buy,
        sell: tradeApis[i].sell,
        log: (m) => log(`[${wallet.publicKey.toBase58()}] ${m}`)
      }));
      const groupCtx = { ...workerContext, bots: botContexts };
      try {
        await exports.strategy(log, groupCtx);
        log('[worker] Group strategy complete');
      } catch (err) {
         log(`[worker] Error in group strategy: ${err?.message || err}`);
      }
    } else {
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        log(`[worker] Running per-bot strategy for bot ${wallet.publicKey.toBase58()}`);
        try {
          const ctxWithApi = { ...workerContext, buy: tradeApis[i].buy, sell: tradeApis[i].sell };
          await exports.strategy(wallet, log, ctxWithApi);
        } catch (err) {
          log(`[worker] Error in bot ${wallet.publicKey.toBase58()}: ${err?.message || err}`);
        }
      }
    }
  } catch (err) {
    const msg = err?.message || err;
    self.postMessage({ log: `[worker] Unhandled error: ${msg}` });
    if (err?.stack) {
      self.postMessage({ log: err.stack });
    }
    self.postMessage({ error: msg || String(err) });
  }
};

export {};
