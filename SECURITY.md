# Security model

## Threat model

The site has two trust tiers:

1. **Public surface** (`/camel/`, donation wall, leaderboard reads, OG metadata) — no auth, anyone can view, no privileged action.
2. **Cabal members** (`/cabal/` writes, arcade score POST, post/like, drawing board) — must hold ≥ 1 CAMEL NFT (1,000,000 $CAMEL on the DN404, via the ERC-721 mirror).

Adversaries we defend against:
- Members posting content **on behalf of another wallet** → SIWE signature binds session to a wallet.
- Non-holders bypassing the gate → server re-checks balance on every sign-in (RPC `balanceOf`).
- A holder claiming a Camel they don't own as their PFP → server re-checks `ownerOf(tokenId)` on every PFP write.
- Fake donation notes → server requires a real on-chain tx hash, verifies recipient + status + non-zero value via `eth_getTransactionByHash` + `eth_getTransactionReceipt` before persisting.
- Score-submission spoofing → score POSTs require a valid cabal session (JWT). We don't claim it's anti-cheat — see "What we don't defend against" below.

## Auth: Sign-In With Ethereum (SIWE-flavored)

```
GET  /cabal/nonce?wallet=0x…
POST /cabal/verify   { wallet, signature, challenge }
     ↓
     { token: <HMAC-SHA256 JWT, 24h>, wallet, balance_wei, ... }
```

1. Client requests a nonce. Server issues a **signed challenge token** containing `{ wallet, nonce, exp }` HMAC'd with `CABAL_HMAC_KEY`. The expiry is 10 min. No DB write — the token *is* the state.
2. Client asks the wallet to sign a fixed message:
   ```
   Welcome to the Camel Cabal.
   Sign this message to prove you hold $CAMEL. This is not a transaction and costs nothing.
   Wallet: 0x…
   Nonce: …
   Expires: …
   ```
   (EIP-191 personal_sign)
3. Server verifies the challenge token matches the wallet, recovers the signer via `eth_account.Account.recover_message(encode_defunct(...))`, ensures it equals the claimed wallet, then queries balance and gates.
4. Returns a session JWT (`HMAC-SHA256` of base64url(payload) — payload contains `{ wallet, exp, kind:"sess" }`, 24h TTL).

There's no refresh token: members re-sign after 24h. Cheap, easy to revoke (rotate `CABAL_HMAC_KEY` and every JWT becomes invalid).

## Gating: balance, not membership list

The gate is **whatever `balanceOf(wallet) ≥ 1_000_000 * 10**18`** says at sign-in time. No allowlist, no merkle root, no centralized membership. If a holder transfers their NFT, their next sign-in fails. Existing 24h sessions remain valid until expiry — that's the trade-off for not requiring per-request RPC calls.

For PFPs the check is per-write: every `POST /cabal/pfp` calls `ownerOf(tokenId)` on the mirror contract and 403s if it doesn't match the session wallet. So you can't claim a Camel you sold (or never owned).

## Storage rules

- **No private keys**, anywhere. The site never sees a key.
- **No off-chain identity beyond a 24-char handle and an X username** (which the user explicitly consents to via OAuth).
- **All bodies are public** to other members: feed posts, group chat, donation notes, drawing pixels, scores. Members are warned in the UI that "everything you post is public".
- **Uploads**: server issues short-lived (5-min) presigned PUTs to a public-read S3 prefix. Whitelist of MIME types (image/png, jpg, gif, webp, avif, svg, bmp, heic, heif; video/mp4, webm, mov, m4v, ogv; audio/mp3, ogg, wav). Cap: 8 MB image, 25 MB video. Random key (`<ts>-<uuidv4 first 12 chars>.<ext>`) — no enumeration.

## CORS / API surface

- API Gateway HTTP API v2 with native CORS.
- `AllowOrigins`: production domains + localhost dev only.
- `AllowMethods`: GET, POST, DELETE, OPTIONS.
- Lambda permission scoped to `/cabal/*` and `/cabal/*/*` only.

## Rate limits

- **Drawing board**: 1 pixel / 3000 ms / wallet, server-enforced (`last_pixel_ts` on the user row, returns 429 with `wait_ms`).
- **Score**: max 1e8 sanity cap to refuse obviously-fake submissions.
- **Donations**: nothing — actual ETH must move on-chain to register a note.
- **Feed/group/like**: not rate limited at the app layer (DynamoDB throughput on PAY_PER_REQUEST is the natural ceiling; could add token-bucket later if abused).

## What we don't defend against

- **Arcade score cheating.** Anyone can hand-craft an authenticated POST to `/cabal/scores` with whatever number they want. A real anti-cheat pass would require server-side replay of game inputs or a signed game-event log. Out of scope for v1; the leaderboard is for vibes.
- **Users sharing their JWT.** A leaked token is valid until expiry. Mitigation: short TTL, key rotation on incident.
- **DNS/MITM at the edge.** We trust HTTPS + CloudFront. No client-side cert pinning (would break browser usage).
- **Censorship-resistant storage.** The cabal is hosted; pulling a DNS record kills it. The data is mirrored in DynamoDB and S3, not on-chain. If you need real censorship-resistance, you'd want IPFS + ENS + on-chain-only state — different product.

## Operational hygiene

- Secrets live only in **Lambda environment variables** + the AWS console. They are never committed to source. The repo's `policy.json` and `lambda_function.py` reference them by name (`os.environ.get(...)`).
- The HMAC key is generated once with `secrets.token_urlsafe(48)` at deploy time. Rotating it invalidates every session — used as the panic button.
- Logs go to CloudWatch. Errors from external APIs (Twitter, RPC) are logged with a `[x]` / `[auth]` prefix and a 500-char truncated body for debug, never the request token or signature.
