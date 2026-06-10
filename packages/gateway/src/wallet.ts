// @postcall/gateway — BSV testnet wallet for the Gateway
//
// Manages the gateway's BSV wallet: UTXO tracking, P2C transaction construction,
// and broadcasting to BSV testnet via WhatsOnChain API.

import {
  type TxInput,
  buildP2CTransaction,
  pubkeyToAddress,
  privkeyToWif,
  wifToPrivkey,
  privToCompressedPub,
  p2pkhScriptFromPub,
  fromHex,
  DUST_SATOSHIS,
} from '@postcall/protocol';

// ---- WhatsOnChain API ----

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/test';

interface WocUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

// ---- types ----

export interface WalletStatus {
  readonly address: string;
  readonly wif: string;
  readonly balance: bigint;
  readonly utxoCount: number;
  readonly network: 'testnet';
  readonly funded: boolean;
  readonly explorerUrl: string;
  readonly faucets: string[];
}

export interface BroadcastResult {
  readonly txid: string;
  readonly hex: string;
  readonly fee: bigint;
  readonly explorerUrl: string;
}

// ---- GatewayWallet ----

export class GatewayWallet {
  readonly priv: Uint8Array;
  readonly pubCompressed: Uint8Array;
  readonly address: string;
  readonly wif: string;

  private utxos: TxInput[] = [];
  private pendingSpends = new Set<string>(); // "txid:vout" strings
  private txQueue: Promise<void> = Promise.resolve();

  constructor(wifOrPriv?: string) {
    if (wifOrPriv) {
      if (wifOrPriv.length === 64 && /^[0-9a-fA-F]+$/.test(wifOrPriv)) {
        // Raw hex private key
        this.priv = fromHex(wifOrPriv);
      } else {
        // WIF
        const decoded = wifToPrivkey(wifOrPriv);
        if (!decoded.testnet) console.warn('[wallet] WARNING: WIF is mainnet key, using on testnet');
        this.priv = decoded.priv;
      }
    } else {
      // Generate new key
      this.priv = globalThis.crypto.getRandomValues(new Uint8Array(32));
    }

    this.pubCompressed = privToCompressedPub(this.priv);
    this.address = pubkeyToAddress(this.pubCompressed, true);
    this.wif = privkeyToWif(this.priv, true, true);
  }

  /** Fetch UTXOs from WhatsOnChain. */
  async refreshUtxos(): Promise<void> {
    try {
      const url = `${WOC_BASE}/address/${this.address}/unspent`;
      const resp = await fetch(url);
      if (!resp.ok) {
        console.error(`[wallet] WoC UTXO fetch failed: ${resp.status} ${resp.statusText}`);
        return;
      }
      const data = await resp.json() as WocUtxo[];
      const lockingScript = p2pkhScriptFromPub(this.pubCompressed);

      this.utxos = data.map(u => ({
        txid: u.tx_hash,
        vout: u.tx_pos,
        value: BigInt(u.value),
        scriptPubKey: lockingScript,
      }));

      // Remove any pending spends that are now confirmed
      this.utxos = this.utxos.filter(u => !this.pendingSpends.has(`${u.txid}:${u.vout}`));

      console.log(`[wallet] ${this.utxos.length} UTXOs, balance: ${this.getBalance()} satoshis`);
    } catch (err) {
      console.error('[wallet] UTXO refresh error:', err);
    }
  }

  getBalance(): bigint {
    return this.utxos.reduce((sum, u) => sum + u.value, 0n);
  }

  getUtxoCount(): number {
    return this.utxos.length;
  }

  isFunded(): boolean {
    return this.utxos.length > 0 && this.getBalance() > DUST_SATOSHIS * 2n;
  }

  getStatus(): WalletStatus {
    return {
      address: this.address,
      wif: this.wif,
      balance: this.getBalance(),
      utxoCount: this.utxos.length,
      network: 'testnet',
      funded: this.isFunded(),
      explorerUrl: `https://test.whatsonchain.com/address/${this.address}`,
      faucets: [
        'https://bsvfaucet.com',
        'https://scrypt.io/faucet',
        'https://witnessonchain.com/faucet/tbsv',
      ],
    };
  }

  /**
   * Build and broadcast a P2C commitment transaction.
   * Serializes concurrent calls to avoid double-spending the same UTXO.
   */
  async broadcastP2C(p2cPubCompressed: Uint8Array): Promise<BroadcastResult | null> {
    // Queue transactions to prevent double-spend
    return new Promise<BroadcastResult | null>((resolve) => {
      this.txQueue = this.txQueue.then(async () => {
        try {
          const result = await this._broadcastP2CInner(p2cPubCompressed);
          resolve(result);
        } catch (err) {
          console.error('[wallet] broadcast error:', err);
          resolve(null);
        }
      });
    });
  }

  private async _broadcastP2CInner(p2cPubCompressed: Uint8Array): Promise<BroadcastResult | null> {
    // Select best UTXO (largest value)
    const available = this.utxos
      .filter(u => !this.pendingSpends.has(`${u.txid}:${u.vout}`))
      .sort((a, b) => (b.value > a.value ? 1 : -1));

    if (available.length === 0) {
      // Try refreshing UTXOs
      await this.refreshUtxos();
      const refreshed = this.utxos
        .filter(u => !this.pendingSpends.has(`${u.txid}:${u.vout}`))
        .sort((a, b) => (b.value > a.value ? 1 : -1));
      if (refreshed.length === 0) {
        console.warn('[wallet] no UTXOs available for broadcast');
        return null;
      }
    }

    const utxo = this.utxos
      .filter(u => !this.pendingSpends.has(`${u.txid}:${u.vout}`))
      .sort((a, b) => (b.value > a.value ? 1 : -1))[0];

    if (!utxo) return null;

    // Build transaction
    const built = buildP2CTransaction(
      this.priv,
      this.pubCompressed,
      utxo,
      p2cPubCompressed,
    );

    // Mark UTXO as spent
    this.pendingSpends.add(`${utxo.txid}:${utxo.vout}`);
    this.utxos = this.utxos.filter(u => !(u.txid === utxo.txid && u.vout === utxo.vout));

    // Add change output as new UTXO (if it exists)
    if (built.outputs.length > 1) {
      const changeOutput = built.outputs[1]!;
      this.utxos.push({
        txid: built.txid,
        vout: 1,
        value: changeOutput.value,
        scriptPubKey: changeOutput.scriptPubKey,
      });
    }

    // Broadcast to WhatsOnChain
    const txid = await this._broadcast(built.hex);
    if (!txid) {
      // Rollback: restore UTXO, remove change
      this.pendingSpends.delete(`${utxo.txid}:${utxo.vout}`);
      this.utxos = this.utxos.filter(u => u.txid !== built.txid);
      this.utxos.push(utxo);
      return null;
    }

    return {
      txid,
      hex: built.hex,
      fee: built.fee,
      explorerUrl: `https://test.whatsonchain.com/tx/${txid}`,
    };
  }

  private async _broadcast(txHex: string): Promise<string | null> {
    try {
      const url = `${WOC_BASE}/tx/raw`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex: txHex }),
      });

      const text = await resp.text();

      if (!resp.ok) {
        console.error(`[wallet] broadcast failed: ${resp.status} ${text}`);
        return null;
      }

      // WoC returns the txid as plain text (with possible quotes)
      const txid = text.replace(/"/g, '').trim();
      console.log(`[wallet] broadcast OK: ${txid}`);
      return txid;
    } catch (err) {
      console.error('[wallet] broadcast network error:', err);
      return null;
    }
  }

  /** Start periodic UTXO refresh. Returns the interval ID for cleanup. */
  startPeriodicRefresh(intervalMs = 60_000): ReturnType<typeof setInterval> {
    return setInterval(() => this.refreshUtxos(), intervalMs);
  }
}
