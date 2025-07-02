import { Buffer } from './libs/buffer.js';

const bnPromise = import('https://cdn.jsdelivr.net/npm/bn.js@5.2.2/+esm');
const splPromise = import('https://cdn.jsdelivr.net/npm/@solana/spl-token@0.4.13/+esm');


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

function createTradeApi(wallet, ctx, log) {
  return {
    buy: async (amount, opts = {}) => {
      const BN = (await bnPromise).default;
      const { NATIVE_MINT } = await splPromise;
      const decimals = ctx.token?.decimals || 0;
      const amountBn = new BN(Math.round(amount * 10 ** decimals));
      if (ctx.network.startsWith('mainnet')) {
        return executeJupiterSwap({
          wallet,
          connection: ctx.connection,
          inputMint: NATIVE_MINT,
          outputMint: new ctx.web3.PublicKey(ctx.token.address),
          amount: amountBn,
          slippageBps: opts.slippageBps || 50,
          priorityFeeMicroLamports: opts.priorityFeeMicroLamports || 1000
        });
      } else {
        log('Devnet buy not implemented');
        return null;
      }
    },
    sell: async (amount, opts = {}) => {
      const BN = (await bnPromise).default;
      const { NATIVE_MINT } = await splPromise;
      const decimals = ctx.token?.decimals || 0;
      const amountBn = new BN(Math.round(amount * 10 ** decimals));
      if (ctx.network.startsWith('mainnet')) {
        return executeJupiterSwap({
          wallet,
          connection: ctx.connection,
          inputMint: new ctx.web3.PublicKey(ctx.token.address),
          outputMint: NATIVE_MINT,
          amount: amountBn,
          slippageBps: opts.slippageBps || 50,
          priorityFeeMicroLamports: opts.priorityFeeMicroLamports || 1000
        });
      } else {
        log('Devnet sell not implemented');
        return null;
      }
    }
  };
}

self.onmessage = async (ev) => {
 const { code, bots = [], context = {} } = ev.data || {};
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

    const exports = {};
    // Execute the provided code in a function scope
    const fn = new Function('exports', 'context', code);
    fn(exports, workerContext);

    if (typeof exports.strategy !== 'function') {
      log('No strategy function exported as "strategy"');
      return;
    }

    for (const wallet of wallets) {
      try {
        const tradeApi = createTradeApi(wallet, workerContext, log);
        const ctxWithApi = { ...workerContext, buy: tradeApi.buy, sell: tradeApi.sell };
        await exports.strategy(wallet, log, ctxWithApi);
      } catch (err) {
        log(`Error executing strategy for ${wallet.publicKey.toBase58()}: ${err?.message || err}`);
      }
    }
  } catch (err) {
    console.error('[bot-worker] Error executing code', err);
    self.postMessage({ error: err.message || String(err) });
  }
};

export {};
