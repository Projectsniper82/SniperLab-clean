
import { Buffer } from 'buffer';
import BN from 'bn.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { NATIVE_MINT } from '@solana/spl-token';
import * as web3 from '@solana/web3.js';

(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;

function createWalletAdapter(web3, wallet) {
  let kp = null;
  let pk = null;
  if (wallet instanceof web3.Keypair) {
    kp = wallet;
    pk = wallet.publicKey;
  } else if (wallet?.secretKey) {
    try {
      const sk = wallet.secretKey instanceof Uint8Array ? wallet.secretKey : Uint8Array.from(wallet.secretKey);
      kp = web3.Keypair.fromSecretKey(sk);
      pk = kp.publicKey;
    } catch (_) {}
  }
  if (!pk && wallet?.publicKey) {
    try { pk = new web3.PublicKey(wallet.publicKey.toString()); } catch (_) {}
  }
  if (!pk) throw new Error('Invalid wallet for adapter');
  const signTx = async (tx) => {
    if (kp) {
      if (tx instanceof web3.VersionedTransaction) tx.sign([kp]);
      else tx.partialSign(kp);
      return tx;
    }
    return await wallet.signTransaction(tx);
  };
  const signAll = async (txs) => {
    if (kp) {
      txs.forEach((t) => {
        if (t instanceof web3.VersionedTransaction) t.sign([kp]);
        else t.partialSign(kp);
      });
      return txs;
    }
    return await wallet.signAllTransactions(txs);
  };
  return { publicKey: pk, signTransaction: signTx, signAllTransactions: signAll, get connected() { return true; } };
}

async function executeJupiterSwap({ wallet, connection, inputMint, outputMint, amount, slippageBps = 50, priorityFeeMicroLamports = 1000 }) {
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount.toString()}&slippageBps=${slippageBps}`;
  const quoteResponse = await (await fetch(quoteUrl)).json();
  if (!quoteResponse || quoteResponse.error) {
    throw new Error(`Failed to get quote from Jupiter: ${quoteResponse?.error || 'No route found'}`);
  }
  const swapResp = await (await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: priorityFeeMicroLamports,
      asLegacyTransaction: true,
    })
  })).json();
  if (!swapResp || !swapResp.swapTransaction) {
    throw new Error(`Failed to get transaction from Jupiter: ${swapResp?.error || 'Unknown error'}`);
  }
  const tx = web3.VersionedTransaction.deserialize(Buffer.from(swapResp.swapTransaction, 'base64'));
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 5 });
  const latest = await connection.getLatestBlockhashAndContext('confirmed');
  await connection.confirmTransaction({ signature: sig, blockhash: latest.value.blockhash, lastValidBlockHeight: latest.value.lastValidBlockHeight }, 'confirmed');
  return sig;
}

async function executeRaydiumSwap({ wallet, connection, inputMint, outputMint, amount, slippageBps = 50 }) {
  const sdk = await Raydium.load({
    connection,
    owner: wallet.publicKey,
    cluster: 'devnet',
    disableFeatureCheck: true,
  });

  const pools = await sdk.api.fetchPoolByMints({
    mint1: inputMint.toBase58(),
    mint2: outputMint.toBase58(),
  });
  const poolId = pools?.data?.[0]?.id;
  if (!poolId) throw new Error('Pool not found');

  const swapParams = {
    inputMint,
    outputMint,
    amount: typeof amount === 'object' ? amount.toNumber() : amount,
    swapMode: 'ExactIn',
    slippageBps,
    owner: wallet.publicKey,
    connection,
    poolId: new web3.PublicKey(poolId),
    txVersion: 'V0',
    unwrapSol: true,
  };

  const { transaction, signers } = await sdk.swap(swapParams);
  if (signers && signers.length) transaction.sign(signers);
  const signed = await wallet.signTransaction(transaction);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 5 });
  const latest = await connection.getLatestBlockhashAndContext('confirmed');
  await connection.confirmTransaction({ signature: sig, blockhash: latest.value.blockhash, lastValidBlockHeight: latest.value.lastValidBlockHeight }, 'confirmed');
  return sig;
}

function createTradeApi(wallet, ctx, log) {
   // This function automatically routes devnet trades through Raydium and mainnet through Jupiter. User strategies do not need to know or specify which is used.
  const retrySwap = async (fn, isDevnet) => {
    let attempt = 0;
    let lastErr;
    let delayMs = isDevnet ? 2000 : 500;
    while (attempt < 3) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        log(`swap attempt ${attempt + 1} failed: ${e.message}`);
        if (e.message && e.message.toLowerCase().includes('amount') && e.message.toLowerCase().includes('too low')) {
          if (fn.amountBn && fn.amountBn.gtn(1)) {
            fn.amountBn = fn.amountBn.divn(2);
            log('decreasing amount and retrying');
          } else {
            break;
          }
        }
        await new Promise(res => setTimeout(res, delayMs));
        delayMs *= 2;
      }
      attempt++;
    }
    throw lastErr;
  };

  return {
    buy: async (amount, opts = {}) => {
      log(`[trade] Attempting buy: amount=${amount}, opts=${JSON.stringify(opts)}`);
      const decimals = ctx.token?.decimals || 0;
      let amountBn = new BN(Math.round(amount * 10 ** decimals));
      const slippageBps = opts.slippageBps || 50;
       try {
        if (ctx.network.startsWith('mainnet')) {
          log('Using Jupiter helper for buy');
          const result = await retrySwap(() => executeJupiterSwap({
            wallet,
            connection: ctx.connection,
            inputMint: NATIVE_MINT,
            outputMint: new ctx.web3.PublicKey(ctx.token.address),
            amount: amountBn,
            slippageBps,
            priorityFeeMicroLamports: opts.priorityFeeMicroLamports || 1000
          }), false);
          log('[trade] Buy succeeded, result=' + JSON.stringify(result));
          return result;
        } else {
          log('Using Raydium helper for buy');
          const fn = () => executeRaydiumSwap({
            wallet,
            connection: ctx.connection,
            inputMint: NATIVE_MINT,
            outputMint: new ctx.web3.PublicKey(ctx.token.address),
            amount: amountBn,
            slippageBps
          });
          fn.amountBn = amountBn;
          const result = await retrySwap(fn, true);
          log('[trade] Buy succeeded, result=' + JSON.stringify(result));
          return result;
        }
      } catch (e) {
        log('[trade] Buy failed: ' + (e?.message || e));
        throw e;
      }
    },
    sell: async (amount, opts = {}) => {
      log(`[trade] Attempting sell: amount=${amount}, opts=${JSON.stringify(opts)}`);
      const decimals = ctx.token?.decimals || 0;
      let amountBn = new BN(Math.round(amount * 10 ** decimals));
      const slippageBps = opts.slippageBps || 50;
      try {
        if (ctx.network.startsWith('mainnet')) {
          log('Using Jupiter helper for sell');
          const result = await retrySwap(() => executeJupiterSwap({
            wallet,
            connection: ctx.connection,
            inputMint: new ctx.web3.PublicKey(ctx.token.address),
            outputMint: NATIVE_MINT,
            amount: amountBn,
            slippageBps,
            priorityFeeMicroLamports: opts.priorityFeeMicroLamports || 1000
          }), false);
          log('[trade] Sell succeeded, result=' + JSON.stringify(result));
          return result;
        } else {
          log('Using Raydium helper for sell');
          const fn = () => executeRaydiumSwap({
            wallet,
            connection: ctx.connection,
            inputMint: new ctx.web3.PublicKey(ctx.token.address),
            outputMint: NATIVE_MINT,
            amount: amountBn,
            slippageBps
          });
          fn.amountBn = amountBn;
          const result = await retrySwap(fn, true);
          log('[trade] Sell succeeded, result=' + JSON.stringify(result));
          return result;
        }
      } catch (e) {
        log('[trade] Sell failed: ' + (e?.message || e));
        throw e;
      }
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
        const { rpcUrl, network, isAdvancedMode, systemState, token, market, ...restContext } = context;
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    const detectedNetwork = network || (rpcUrl.includes('mainnet') ? 'mainnet-beta' : 'devnet');
    const workerContext = { ...restContext, rpcUrl, network: detectedNetwork, connection, web3, token, market, isAdvancedMode };
    if (systemState) workerContext.systemState = systemState;

    if (!token?.address) {
      self.postMessage({ log: '[worker] Warning: no token configured in context' });
    }
    
    const wallets = bots.map((sk) => {
      try {
        const kp = web3.Keypair.fromSecretKey(Uint8Array.from(sk));
        return createWalletAdapter(web3, kp);
      } catch (_) {
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

    log(`[worker] Preparing to run strategy (${mode}), bots=${wallets.length}`);

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
