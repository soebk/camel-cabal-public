# Camel Cabal

Source for **CAMEL CABAL TERMINAL** (`/camel/`) and the **/cabal/** members area — a token-gated social space for $CAMEL holders.

```
camel/      DN404 mint tracker, Defined.fi chart, donor wall, Uniswap deeplink
cabal/      gated social: feed, group chat, drawing board, arcade, profiles
backend/    single Python 3.12 Lambda + IAM policy
```

Stack: **vanilla JS** (no framework) on **AWS S3 + CloudFront**, **Python 3.12 Lambda** behind **API Gateway HTTP API v2**, **DynamoDB** for state, **SIWE** auth (HMAC-signed JWT), **Chainstack** RPC (`balanceOf` for gating, `ownerOf` for PFP guard), **Alchemy NFT API** for camel-collection lookups, **OAuth 1.0a** for X attach (free tier compatible — OAuth 2.0 `/2/users/me` is locked behind paid Basic), **Defined.fi** chart embed.

See [`SECURITY.md`](./SECURITY.md) for the threat model and gating logic, and [`INTEGRATION_NOTES.md`](./INTEGRATION_NOTES.md) for thoughts on integrating with [`monygroupcorp/micro-web3`](https://github.com/monygroupcorp/micro-web3).

## Constants

| | |
|---|---|
| Token (DN404) | `0x000Caba1002917B27300d7b67Be2d1C51B93bF00` |
| ERC-721 mirror | `0x9f2F3E04c67AD0854A6b225d5FDdBaE513dF0fCC` |
| Pool (Uniswap V4) | `0x1b337491fb312c3500e1feef56d50bcacee6c7e3` |
| Donation wallet | `0xf62290b1e405f03628a4b6ba025ad5b655cce8a2` |
| Gate threshold | 1 NFT == 1,000,000 $CAMEL (DN404) |

## DynamoDB tables

| Table | PK | SK | Purpose |
|---|---|---|---|
| `camel_users` | wallet | — | handle, pfp, x_handle, last_seen, last_pixel_ts |
| `camel_feed` | shard=`FEED` | ts | broadcast posts, `liked_by` set |
| `camel_group` | shard=`GLOBAL` | ts | group chat |
| `camel_canvas` | shard=`C` | xy | drawing-board pixels |
| `camel_donations` | shard=`DON` | ts | on-chain-verified donor wall |
| `camel_scores` | game | score_ts (inverted) | arcade leaderboards |

## Routes

```
GET  /cabal/nonce?wallet=…           public — start SIWE
POST /cabal/verify                   public — verify sig + balance ≥ 1 NFT, returns JWT
GET  /cabal/me                       auth   — current user
POST /cabal/me                       auth   — set handle
POST /cabal/pfp                      auth   — set Camel pfp (validates ownerOf)
POST /cabal/upload                   auth   — presigned S3 PUT for image/video/audio
GET  /cabal/feed | POST | DELETE     auth   — broadcast feed (delete = own only)
POST /cabal/like                     auth   — toggle like on a post
GET  /cabal/group | POST             auth   — group chat
GET  /cabal/canvas | POST            auth   — drawing board (1 px / 3s, server-enforced)
GET  /cabal/camels                   auth   — list members
GET  /cabal/profile/{wallet}         auth   — profile + recent posts
GET  /cabal/scores  [scope=global]   public — leaderboards
POST /cabal/scores                   auth   — submit score
GET  /cabal/donate                   public — donor wall
POST /cabal/donate                   public — submit tx hash + note (verifies on-chain)
GET  /cabal/x/redirect?token=…       public — start X OAuth 1.0a
GET  /cabal/x/callback               public — exchange request_token, attach @handle
```

## Env vars (Lambda)

```
CABAL_HMAC_KEY     # 48-byte urlsafe random — JWT signing key
ETH_RPC            # any Ethereum mainnet HTTPS RPC
X_API_KEY          # OAuth 1.0a Consumer Key
X_API_SECRET       # OAuth 1.0a Consumer Secret
```

## Deploy

```bash
# Lambda
cd backend
mkdir -p pkg && cp lambda_function.py pkg/
pip3 install --target pkg --platform manylinux2014_x86_64 --python-version 3.12 \
  --only-binary=:all: --upgrade eth-account
cd pkg && find . -name __pycache__ -exec rm -rf {} +
zip -rq ../bundle.zip . && cd ..
aws lambda update-function-code --region us-east-1 \
  --function-name ebk-camel-cabal --zip-file fileb://bundle.zip

# Frontends
aws s3 sync camel/ s3://<S3_BUCKET>/camel/  --cache-control "max-age=60"
aws s3 sync cabal/ s3://<S3_BUCKET>/cabal/  --cache-control "max-age=60"
aws cloudfront create-invalidation --distribution-id <CLOUDFRONT_DIST_ID> --paths "/cabal/*" "/camel/*"
```

Bump `?v=N` on the `<script src="cabal.js?v=…">` tags whenever JS changes — busts browser cache without waiting on the 60s S3 TTL.
