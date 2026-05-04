# Integration notes — micro-web3

Looked at [`monygroupcorp/micro-web3`](https://github.com/monygroupcorp/micro-web3). It's a vanilla-JS Web3 toolkit (no React, paired with `microact`) — good fit conceptually since this site is also vanilla. Below is what I think *could* drop in cleanly vs. what's already a fine match for what we have.

## What our site needs from a Web3 layer

| Concern | Current implementation | Where micro-web3 fits |
|---|---|---|
| Wallet detection / connect | Inline `ethers.providers.Web3Provider(window.ethereum)` in `cabal.js` and `app.js`. Single wallet (whatever wins `window.ethereum`). | `WalletService` adds **EIP-6963 multi-wallet discovery**, MetaMask / Rabby / Rainbow / Phantom / Coinbase / Trust / OKX detection, and a wallet-picker modal. Worth swapping in. |
| Read-only ownership / balance checks | Server does `eth_call balanceOf` over Chainstack at sign-in; client does `ownerOf` indirectly via Alchemy. | `BlockchainService` + `ContractCache` give TTL-cached reads against any RPC. **Removes the Alchemy dependency** for the PFP picker — we can hit a public RPC client-side and cache. Server still does its independent `ownerOf` for write authorization (security boundary stays). |
| Multi-RPC failover | None — one Chainstack endpoint. | `BlockchainService` rotates RPCs and falls back. |
| IPFS image rendering | Hard-coded `https://ipfs.io/ipfs/<cid>/<id>.webp` for the Camel collection. | `IpfsService` + `IpfsImage` add gateway rotation (Cloudflare, Pinata, nftstorage, etc.) — useful when ipfs.io is rate-limited. |
| Swap UI | We deep-link to Uniswap. | `SwapInterface` is V4-aware. **Could replace the deep-link** with on-site swap once we want to take a fee skim. |

## What I would NOT migrate

- **Auth (SIWE)** stays server-side. The on-chain check is the easy half; the rest is JWT / state / cooldowns / DDB writes — all cleaner in Lambda.
- **Gated writes** stay server-side. Browser-only ownership checks are spoofable; the server's independent `ownerOf` re-check on PFP writes (and `balanceOf` re-check on sign-in) is the security boundary.
- **Score submission, feed, drawing board, X OAuth** — none of these have a public-good replacement in micro-web3. They need DynamoDB + signed JWT.

## What I would migrate

### 1. Wallet connect → `WalletService` (medium)

Today: `new ethers.providers.Web3Provider(window.ethereum)`. Single wallet.
After: EIP-6963 discovery, picker modal, easy multi-wallet UX.

Touch points:
- `cabal.js#cabalLogin` (sign-in flow)
- `app.js#connectWallet` (donate flow)

Gain: real multi-wallet support, fewer "wallet not detected" complaints.

### 2. Camel collection lookup → `BlockchainService` + `ContractCache` (medium)

Today: `cabal.js#fetchOwnedCamels` → Alchemy demo endpoint, paginated.
After: client-side iteration over Transfer events filtered by `to=wallet`, cached. **Eliminates Alchemy** as a runtime dependency.

Caveat: Transfer-event scan is heavier than a single Alchemy call (one `eth_getLogs` per ~10k blocks, plus an `ownerOf` per token to confirm current ownership). For a wallet with many camels this could be 10-20 RPC calls vs. 1. Worth it if Alchemy's free tier hits limits or you want a self-hosted-only stack; otherwise keep Alchemy.

### 3. IPFS gateway rotation → `IpfsService` (small)

Today: hard-coded `ipfs.io`.
After: tries Cloudflare → ipfs.io → nftstorage → pinata. Reduces broken images when one gateway is rate-limited.

### 4. Optional: swap on-site → `SwapInterface` (large)

Today: button opens app.uniswap.org with token pre-filled.
After: on-site swap with a cabal fee skim (e.g. 0.5% to dev wallet).

Real engineering — V4 routing is non-trivial. Defer unless you want the fee.

## What integration would actually look like

For the wallet connect swap, roughly:

```js
// 1. add to /camel/index.html and /cabal/index.html
<script src="https://unpkg.com/microact@latest/dist/microact.umd.js"></script>
<script src="https://unpkg.com/micro-web3@latest/dist/micro-web3.umd.js"></script>

// 2. in cabal.js, replace cabalLogin's provider setup:
const eventBus = new microact.EventBus();
const wallet = new microWeb3.WalletService(eventBus);
await wallet.initialize();
await wallet.connect();             // shows EIP-6963 modal, returns address
const signer = wallet.getSigner();   // ethers.Signer, drop-in
// rest of SIWE flow unchanged
```

micro-web3 is ESM; for vanilla pages we'd need either a bundled UMD build or a small rollup wrapper. Looking at `rollup.config.cjs`, the package is set up to produce both — fine.

## Trust boundary unchanged

Even if we migrate everything client-side: **the server still re-validates** `balanceOf` at sign-in and `ownerOf` at PFP write. Browser data is convenience UI; the gate is the Lambda. micro-web3 is for the experience layer, not the auth layer.

---

Open to PRs. Happy to land #1 and #3 quickly if you want a smaller surface to read first.
