
import { Buffer } from './libs/buffer.js';

const bnPromise = import('https://cdn.jsdelivr.net/npm/bn.js@5.2.2/+esm');
const splPromise = import('https://cdn.jsdelivr.net/npm/@solana/spl-token@0.4.13/+esm');
const raydiumPromise = import('https://cdn.jsdelivr.net/npm/@raydium-io/raydium-sdk-v2@0.1.138-alpha/+esm');


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


// Load web3 once and reuse the promise across messages
const web3Promise = import(
  'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.2/lib/index.browser.esm.js'
);

async function executeJupiterSwap({ wallet, connection, inputMint, outputMint, amount, slippageBps = 50, priorityFeeMicroLamports = 1000 }) {
  const web3 = await web3Promise;
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
  const web3 = await web3Promise;
  const raydium = await raydiumPromise;
  const { Raydium, PublicKey, TxVersion } = raydium;

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
    poolId: new PublicKey(poolId),
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
      const BN = (await bnPromise).default;
      const { NATIVE_MINT } = await splPromise;
      const decimals = ctx.token?.decimals || 0;
      let amountBn = new BN(Math.round(amount * 10 ** decimals));
      const slippageBps = opts.slippageBps || 50;
      if (ctx.network.startsWith('mainnet')) {
        log('Using Jupiter helper for buy');
        return retrySwap(() => executeJupiterSwap({
          wallet,
          connection: ctx.connection,
          inputMint: NATIVE_MINT,
          outputMint: new ctx.web3.PublicKey(ctx.token.address),
          amount: amountBn,
          slippageBps,
          priorityFeeMicroLamports: opts.priorityFeeMicroLamports || 1000
       }), false);
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
        return retrySwap(fn, true);
      }
    },
    sell: async (amount, opts = {}) => {
      const BN = (await bnPromise).default;
      const { NATIVE_MINT } = await splPromise;
      const decimals = ctx.token?.decimals || 0;
      let amountBn = new BN(Math.round(amount * 10 ** decimals));
      const slippageBps = opts.slippageBps || 50;
      if (ctx.network.startsWith('mainnet')) {
       log('Using Jupiter helper for sell');
        return retrySwap(() => executeJupiterSwap({
          wallet,
          connection: ctx.connection,
          inputMint: new ctx.web3.PublicKey(ctx.token.address),
          outputMint: NATIVE_MINT,
          amount: amountBn,
          slippageBps,
          priorityFeeMicroLamports: opts.priorityFeeMicroLamports || 1000
         }), false);
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
        return retrySwap(fn, true);
        return null;
      }
    }
  };
}

self.onmessage = async (ev) => {
 const { code, bots = [], context = {}, mode = 'per-bot' } = ev.data || {};
  try {
    // Provide window polyfill similar to walletCreator
    globalThis.window = self;
    if (!globalThis.Buffer) {
      globalThis.Buffer = Buffer;
    }
    const web3 = await web3Promise;
        const { rpcUrl, network, isAdvancedMode, systemState, token, market, ...restContext } = context;
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    const detectedNetwork = network || (rpcUrl.includes('mainnet') ? 'mainnet-beta' : 'devnet');
    const workerContext = { ...restContext, rpcUrl, network: detectedNetwork, connection, web3, token, market, isAdvancedMode };
    if (systemState) workerContext.systemState = systemState;
    
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
    // Execute the provided code in a function scope
    const fn = new Function('exports', 'context', code);
    fn(exports, workerContext);

    if (typeof exports.strategy !== 'function') {
      log('No strategy function exported as "strategy"');
      return;
    }

    if (mode === 'group') {
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
      } catch (err) {
         log(`Error executing group strategy: ${err?.message || err}`);
      }
    } else {
      for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        try {
          const ctxWithApi = { ...workerContext, buy: tradeApis[i].buy, sell: tradeApis[i].sell };
          await exports.strategy(wallet, log, ctxWithApi);
        } catch (err) {
          log(`Error executing strategy for ${wallet.publicKey.toBase58()}: ${err?.message || err}`);
        }
      }
    }
  } catch (err) {
    console.error('[bot-worker] Error executing code', err);
    self.postMessage({ error: err.message || String(err) });
  }
};

export {};
