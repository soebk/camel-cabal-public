"""
ebk-camel-cabal — gated social backend for $CAMEL holders.
Routes (mounted at <your-api-domain>/cabal/*):
  GET  /cabal/nonce?wallet=0x...
  POST /cabal/verify              {wallet, signature, challenge}
  GET  /cabal/me                  (auth)
  POST /cabal/me                  (auth) {handle}
  GET  /cabal/feed                (auth)
  POST /cabal/feed                (auth) {text}
  GET  /cabal/group               (auth) [?since=ts]
  POST /cabal/group               (auth) {text}
  GET  /cabal/dm/{peer}           (auth) [?since=ts]
  POST /cabal/dm/{peer}           (auth) {text}
  GET  /cabal/camels              (auth)
"""
import os, json, time, hmac, hashlib, base64, secrets, urllib.request, decimal, uuid
import boto3
s3 = boto3.client("s3", region_name="us-east-1")
UPLOAD_BUCKET = "<S3_BUCKET>"
UPLOAD_PREFIX = "cabal-uploads/"
UPLOAD_PUBLIC_BASE = "https://<your-domain>/cabal-uploads/"
UPLOAD_MAX_BYTES_IMAGE = 8 * 1024 * 1024   # 8 MB
UPLOAD_MAX_BYTES_VIDEO = 25 * 1024 * 1024  # 25 MB
UPLOAD_ALLOWED = {
    # images
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg",
    "image/gif": "gif", "image/webp": "webp", "image/avif": "avif",
    "image/bmp": "bmp", "image/x-bmp": "bmp",
    "image/svg+xml": "svg", "image/heic": "heic", "image/heif": "heif",
    # videos (browser-renderable)
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "video/x-m4v": "m4v", "video/ogg": "ogv",
    # audio (rare but cheap to allow)
    "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav",
}
from boto3.dynamodb.conditions import Key
from eth_account.messages import encode_defunct
from eth_account import Account

REGION = "us-east-1"
ddb = boto3.resource("dynamodb", region_name=REGION)
T_USERS  = ddb.Table("camel_users")
T_FEED   = ddb.Table("camel_feed")
T_GROUP  = ddb.Table("camel_group")
T_DM     = ddb.Table("camel_dm")
T_CANVAS = ddb.Table("camel_canvas")
T_DONATE = ddb.Table("camel_donations")
T_SCORES = ddb.Table("camel_scores")
ARCADE_GAMES = {"snake", "tetris", "flappy", "minesweeper", "pacman", "galaga"}
SCORE_MAX    = 100_000_000  # sanity cap
DEV_WALLET   = "0xf62290b1e405f03628a4b6ba025ad5b655cce8a2"  # donation recipient
NOTE_MAX     = 500

CANVAS_W = 100
CANVAS_H = 100
PIXEL_COOLDOWN_MS = 3000   # 1 pixel every 3 seconds per wallet
PALETTE = [
    "#000000","#1d1d1d","#3d3d3d","#7a7a7a","#bcbcbc","#ffffff",
    "#7d2222","#d33","#ff8a3c","#fee36a","#4cd44c","#1f6f1f",
    "#3c8aff","#214a91","#a85bd1","#ff66c4",
]

CAMEL_TOKEN  = "0x000Caba1002917B27300d7b67Be2d1C51B93bF00"
CAMEL_MIRROR = "0x9f2F3E04c67AD0854A6b225d5FDdBaE513dF0fCC"  # ERC721 mirror

# X (Twitter) OAuth 1.0a — uses Consumer API key + secret. Free tier supports this.
X_API_KEY       = os.environ.get("X_API_KEY", "")
X_API_SECRET    = os.environ.get("X_API_SECRET", "")
X_REDIRECT_URI  = "https://<your-api-domain>/cabal/x/callback"
X_RETURN_URL    = "https://<your-domain>/cabal/"
X_AUTH_TTL      = 600
MIN_HOLD_WEI = 1_000_000 * 10**18           # 1,000,000 $CAMEL
ETH_RPC      = os.environ.get("ETH_RPC", "https://ethereum-rpc.publicnode.com")
HMAC_KEY     = os.environ.get("CABAL_HMAC_KEY", "change-me").encode()
NONCE_TTL    = 600
SESSION_TTL  = 86400
TEXT_MAX     = 2000
HANDLE_MAX   = 24

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
}

def resp(code, body=None):
    return {
        "statusCode": code,
        "headers": {**CORS, "Content-Type": "application/json"},
        "body": json.dumps(body if body is not None else {}, default=_json_default),
    }

def _json_default(o):
    if isinstance(o, decimal.Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    raise TypeError

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def b64u_dec(s):
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def sign_token(payload):
    body = b64u(json.dumps(payload, separators=(",", ":")).encode())
    sig  = b64u(hmac.new(HMAC_KEY, body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"

def verify_token(tok):
    try:
        body, sig = tok.split(".")
        expected = b64u(hmac.new(HMAC_KEY, body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected): return None
        payload = json.loads(b64u_dec(body))
        if payload.get("exp", 0) < int(time.time()): return None
        return payload
    except Exception:
        return None

def auth_wallet(event):
    hdrs = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    auth = hdrs.get("authorization", "")
    if not auth.startswith("Bearer "): return None
    p = verify_token(auth[7:])
    if not p or "w" not in p: return None
    wallet = p["w"].lower()
    try:
        T_USERS.update_item(
            Key={"wallet": wallet},
            UpdateExpression="SET last_seen = :n",
            ExpressionAttributeValues={":n": int(time.time())},
        )
    except Exception as e:
        print(f"[auth] last_seen bump failed: {e}")
    return wallet

def rpc_call(method, params):
    req = urllib.request.Request(
        ETH_RPC,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "ebk-camel-cabal/1.0"},
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read())

def camel_balance(wallet):
    addr = wallet.lower().replace("0x", "").rjust(64, "0")
    data = "0x70a08231" + addr
    res = rpc_call("eth_call", [{"to": CAMEL_TOKEN, "data": data}, "latest"])
    if "result" not in res or res["result"] in (None, "0x"): return 0
    return int(res["result"], 16)

def nft_owner(token_id):
    # ownerOf(uint256) selector 0x6352211e
    tid = hex(int(token_id))[2:].rjust(64, "0")
    data = "0x6352211e" + tid
    res = rpc_call("eth_call", [{"to": CAMEL_MIRROR, "data": data}, "latest"])
    if "result" not in res or res["result"] in (None, "0x"): return None
    raw = res["result"]
    return ("0x" + raw[-40:]).lower()

def short_camel_id(wallet):
    return "Camel-" + wallet[2:6].upper() + wallet[-4:].upper()

def ensure_user(wallet, balance_wei):
    now = int(time.time())
    T_USERS.update_item(
        Key={"wallet": wallet},
        UpdateExpression="SET last_seen = :n, balance_wei = :b, joined_at = if_not_exists(joined_at, :n), camel_id = if_not_exists(camel_id, :c)",
        ExpressionAttributeValues={":n": now, ":b": str(balance_wei), ":c": short_camel_id(wallet)},
    )

def get_user(wallet):
    return T_USERS.get_item(Key={"wallet": wallet}).get("Item") or {}

def handle_nonce(event):
    wallet = (event.get("queryStringParameters") or {}).get("wallet", "").lower()
    if not wallet.startswith("0x") or len(wallet) != 42:
        return resp(400, {"error": "bad wallet"})
    nonce = secrets.token_hex(16)
    exp   = int(time.time()) + NONCE_TTL
    msg = (f"Welcome to the Camel Cabal.\n\n"
           f"Sign this message to prove you hold $CAMEL. This is not a transaction and costs nothing.\n\n"
           f"Wallet: {wallet}\n"
           f"Nonce: {nonce}\n"
           f"Expires: {exp}")
    challenge_token = sign_token({"w": wallet, "n": nonce, "exp": exp, "kind": "challenge"})
    return resp(200, {"message": msg, "challenge": challenge_token})

def handle_verify(event):
    body = json.loads(event.get("body") or "{}")
    wallet    = body.get("wallet", "").lower()
    signature = body.get("signature", "")
    challenge = body.get("challenge", "")
    p = verify_token(challenge)
    if not p or p.get("kind") != "challenge" or p["w"] != wallet:
        return resp(400, {"error": "bad challenge"})
    msg = (f"Welcome to the Camel Cabal.\n\n"
           f"Sign this message to prove you hold $CAMEL. This is not a transaction and costs nothing.\n\n"
           f"Wallet: {wallet}\n"
           f"Nonce: {p['n']}\n"
           f"Expires: {p['exp']}")
    try:
        recovered = Account.recover_message(encode_defunct(text=msg), signature=signature).lower()
    except Exception as e:
        return resp(400, {"error": f"signature recover failed: {e}"})
    if recovered != wallet:
        return resp(401, {"error": "signature does not match wallet"})
    bal = camel_balance(wallet)
    if bal < MIN_HOLD_WEI:
        return resp(403, {"error": "insufficient $CAMEL", "balance": str(bal), "required": str(MIN_HOLD_WEI)})
    ensure_user(wallet, bal)
    sess = sign_token({"w": wallet, "exp": int(time.time()) + SESSION_TTL, "kind": "sess"})
    return resp(200, {"token": sess, **_user_view(get_user(wallet), wallet), "balance_wei": str(bal)})

def _user_view(u, wallet):
    return {
        "wallet": wallet, "camel_id": u.get("camel_id"), "handle": u.get("handle"),
        "joined_at": u.get("joined_at"), "last_seen": u.get("last_seen"),
        "pfp_token_id": u.get("pfp_token_id"), "pfp_image": u.get("pfp_image"),
        "pfp_name": u.get("pfp_name"),
        "x_handle": u.get("x_handle"), "x_name": u.get("x_name"), "x_avatar": u.get("x_avatar"),
    }

def handle_me(event, wallet):
    if event["requestContext"]["http"]["method"] == "POST":
        body = json.loads(event.get("body") or "{}")
        h = (body.get("handle") or "").strip()[:HANDLE_MAX]
        if h:
            T_USERS.update_item(Key={"wallet": wallet}, UpdateExpression="SET handle = :h", ExpressionAttributeValues={":h": h})
    return resp(200, _user_view(get_user(wallet), wallet))

def _x_pq(s): return urllib.parse.quote(str(s), safe="")

def _x_oauth1_sign(method, url, params, consumer_secret, token_secret=""):
    sorted_params = sorted(params.items())
    encoded = "&".join(f"{_x_pq(k)}={_x_pq(v)}" for k, v in sorted_params)
    base = f"{method.upper()}&{_x_pq(url)}&{_x_pq(encoded)}"
    key = f"{_x_pq(consumer_secret)}&{_x_pq(token_secret)}"
    sig = hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()
    return base64.b64encode(sig).decode()

def _x_oauth1_header(method, url, body_params, token=None, token_secret="", extra=None):
    oauth = {
        "oauth_consumer_key": X_API_KEY,
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_version": "1.0",
    }
    if token: oauth["oauth_token"] = token
    if extra: oauth.update(extra)
    sig_params = {**oauth, **(body_params or {})}
    sig = _x_oauth1_sign(method, url, sig_params, X_API_SECRET, token_secret)
    oauth["oauth_signature"] = sig
    return "OAuth " + ", ".join(f'{_x_pq(k)}="{_x_pq(v)}"' for k, v in sorted(oauth.items()))

def handle_x_redirect(event):
    """OAuth 1.0a — request_token then redirect to /oauth/authenticate."""
    qs = event.get("queryStringParameters") or {}
    tok = qs.get("token", "")
    mode = (qs.get("mode") or "avatar").lower()
    payload = verify_token(tok)
    if not payload or payload.get("kind") != "sess":
        return resp(401, {"error": "invalid cabal session"})
    wallet = payload["w"].lower()
    if not X_API_KEY or not X_API_SECRET:
        return resp(500, {"error": "X OAuth 1.0a not configured"})
    # Sign a wallet+mode token to embed in callback as state
    state_token = sign_token({"w": wallet, "m": mode, "exp": int(time.time()) + X_AUTH_TTL, "kind": "x1"})
    callback = f"{X_REDIRECT_URI}?state={state_token}"
    auth_header = _x_oauth1_header("POST", "https://api.twitter.com/oauth/request_token", None, extra={"oauth_callback": callback})
    req = urllib.request.Request(
        "https://api.twitter.com/oauth/request_token",
        method="POST",
        headers={"Authorization": auth_header, "User-Agent": "ebk-camel-cabal/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body_text = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception: pass
        print(f"[x] request_token http {e.code}: {body}")
        return _x_redirect_back(f"x_error=req_{e.code}")
    except Exception as e:
        print(f"[x] request_token failed: {e}")
        return _x_redirect_back("x_error=req_net")
    parsed = dict(urllib.parse.parse_qsl(body_text))
    if parsed.get("oauth_callback_confirmed") != "true":
        print(f"[x] callback not confirmed: {body_text}")
        return _x_redirect_back("x_error=cb_unconfirmed")
    auth_url = f"https://api.twitter.com/oauth/authenticate?oauth_token={parsed['oauth_token']}"
    return {"statusCode": 302, "headers": {**CORS, "Location": auth_url}, "body": ""}

def handle_x_callback(event):
    qs = event.get("queryStringParameters") or {}
    state = qs.get("state", "")
    oauth_token = qs.get("oauth_token", "")
    oauth_verifier = qs.get("oauth_verifier", "")
    if qs.get("denied") or not oauth_token or not oauth_verifier:
        return _x_redirect_back("x_error=denied")
    p = verify_token(state)
    if not p or p.get("kind") != "x1":
        return _x_redirect_back("x_error=bad_state")
    wallet = p["w"].lower()
    # Exchange request_token + verifier for access_token + screen_name
    body_params = {"oauth_verifier": oauth_verifier}
    auth_header = _x_oauth1_header(
        "POST", "https://api.twitter.com/oauth/access_token",
        body_params, token=oauth_token,
    )
    body = urllib.parse.urlencode(body_params).encode()
    req = urllib.request.Request(
        "https://api.twitter.com/oauth/access_token",
        method="POST",
        data=body,
        headers={
            "Authorization": auth_header,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "ebk-camel-cabal/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            txt = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        bbody = ""
        try: bbody = e.read().decode("utf-8", errors="replace")[:500]
        except Exception: pass
        print(f"[x] access_token http {e.code}: {bbody}")
        return _x_redirect_back(f"x_error=acc_{e.code}")
    except Exception as e:
        print(f"[x] access_token failed: {e}")
        return _x_redirect_back("x_error=acc_net")
    parsed = dict(urllib.parse.parse_qsl(txt))
    handle = parsed.get("screen_name") or ""
    user_id = parsed.get("user_id") or ""
    if not handle:
        print(f"[x] access_token missing screen_name: {txt}")
        return _x_redirect_back("x_error=no_handle")
    # Avatar: use unavatar.io (free CORS-friendly proxy that resolves x.com avatars by username)
    img = f"https://unavatar.io/x/{handle}"
    name = handle  # OAuth 1.0a doesn't return display name; use handle
    mode = (p.get("m") or "avatar")
    # Auto-set the cabal handle to the X username if the camel doesn't already have one set.
    cur_user = T_USERS.get_item(Key={"wallet": wallet}).get("Item") or {}
    cur_handle = (cur_user.get("handle") or "").strip()
    if mode == "link_only":
        if cur_handle:
            T_USERS.update_item(
                Key={"wallet": wallet},
                UpdateExpression="SET x_handle = :h, x_name = :xn, x_avatar = :i",
                ExpressionAttributeValues={":h": handle, ":xn": name, ":i": img},
            )
        else:
            T_USERS.update_item(
                Key={"wallet": wallet},
                UpdateExpression="SET handle = :uh, x_handle = :h, x_name = :xn, x_avatar = :i",
                ExpressionAttributeValues={":uh": (handle or "")[:HANDLE_MAX], ":h": handle, ":xn": name, ":i": img},
            )
    else:
        if cur_handle:
            T_USERS.update_item(
                Key={"wallet": wallet},
                UpdateExpression="SET pfp_image = :i, pfp_name = :n, pfp_token_id = :t, x_handle = :h, x_name = :xn, x_avatar = :i",
                ExpressionAttributeValues={":i": img, ":n": name or handle or "x avatar", ":t": "x:" + (handle or ""), ":h": handle, ":xn": name},
            )
        else:
            T_USERS.update_item(
                Key={"wallet": wallet},
                UpdateExpression="SET handle = :uh, pfp_image = :i, pfp_name = :n, pfp_token_id = :t, x_handle = :h, x_name = :xn, x_avatar = :i",
                ExpressionAttributeValues={":uh": (handle or "")[:HANDLE_MAX], ":i": img, ":n": name or handle or "x avatar", ":t": "x:" + (handle or ""), ":h": handle, ":xn": name},
            )
    return _x_redirect_back("x_connected=1")

def _x_redirect_back(query):
    return {"statusCode": 302, "headers": {**CORS, "Location": f"{X_RETURN_URL}?{query}"}, "body": ""}

def handle_pfp(event, wallet):
    body = json.loads(event.get("body") or "{}")
    try:
        token_id = int(body.get("token_id"))
    except Exception:
        return resp(400, {"error": "token_id required"})
    image  = (body.get("image_url") or "").strip()[:600]
    name   = (body.get("name") or "").strip()[:80]
    if not image.startswith(("http://", "https://", "ipfs://")):
        return resp(400, {"error": "image_url must be http(s)://… or ipfs://…"})
    try:
        owner = nft_owner(token_id)
    except Exception as e:
        return resp(502, {"error": f"rpc failed: {e}"})
    if not owner or owner.lower() != wallet.lower():
        return resp(403, {"error": "you do not own that camel", "owner": owner})
    T_USERS.update_item(
        Key={"wallet": wallet},
        UpdateExpression="SET pfp_token_id=:t, pfp_image=:i, pfp_name=:n",
        ExpressionAttributeValues={":t": str(token_id), ":i": image, ":n": name or f"Camel #{token_id}"},
    )
    return resp(200, _user_view(get_user(wallet), wallet))

def post_message(table, pk_attr, pk_val, wallet, text):
    text = (text or "").strip()
    if not text or len(text) > TEXT_MAX:
        return resp(400, {"error": f"text length 1..{TEXT_MAX}"})
    ts = int(time.time() * 1000)
    u = get_user(wallet)
    item = {
        pk_attr: pk_val, "ts": ts, "wallet": wallet, "text": text,
        "camel_id": u.get("camel_id") or short_camel_id(wallet),
        "handle": u.get("handle") or "",
        "pfp_image": u.get("pfp_image") or "",
        "pfp_name": u.get("pfp_name") or "",
    }
    table.put_item(Item=item)
    return resp(200, item)

def list_since(table, pk_attr, pk_val, since_ms=0, limit=100):
    if since_ms:
        r = table.query(
            KeyConditionExpression=Key(pk_attr).eq(pk_val) & Key("ts").gt(since_ms),
            ScanIndexForward=True, Limit=limit,
        )
        items = r.get("Items", [])
    else:
        r = table.query(KeyConditionExpression=Key(pk_attr).eq(pk_val), ScanIndexForward=False, Limit=50)
        items = r.get("Items", [])
        items.reverse()
    # Convert string-set likes to plain list for JSON serialisation
    for it in items:
        if isinstance(it.get("liked_by"), set):
            it["liked_by"] = sorted(it["liked_by"])
            it["likes"] = len(it["liked_by"])
        else:
            it["likes"] = 0; it["liked_by"] = []
    return items

def _hydrate_authors(items, key="wallet"):
    wallets = list({(it.get(key) or "").lower() for it in items if it.get(key)})
    if not wallets: return items
    users = {}
    for w in wallets:
        try:
            u = T_USERS.get_item(Key={"wallet": w}).get("Item") or {}
            users[w] = u
        except Exception: pass
    for it in items:
        w = (it.get(key) or "").lower()
        u = users.get(w)
        if not u: continue
        if u.get("pfp_image"): it["pfp_image"] = u["pfp_image"]
        if u.get("handle"):    it["handle"]    = u["handle"]
    return items

def handle_feed(event, wallet):
    method = event["requestContext"]["http"]["method"]
    if method == "POST":
        body = json.loads(event.get("body") or "{}")
        return post_message(T_FEED, "shard", "FEED", wallet, body.get("text"))
    if method == "DELETE":
        body = json.loads(event.get("body") or "{}")
        try: ts = int(body.get("ts"))
        except Exception: return resp(400, {"error": "ts required"})
        try:
            r = T_FEED.get_item(Key={"shard": "FEED", "ts": ts}).get("Item")
        except Exception as e:
            return resp(500, {"error": str(e)})
        if not r: return resp(404, {"error": "post not found"})
        if (r.get("wallet") or "").lower() != wallet.lower():
            return resp(403, {"error": "not your post"})
        T_FEED.delete_item(Key={"shard": "FEED", "ts": ts})
        return resp(200, {"deleted": True, "ts": ts})
    since = int((event.get("queryStringParameters") or {}).get("since", 0))
    return resp(200, {"items": _hydrate_authors(list_since(T_FEED, "shard", "FEED", since))})

def handle_like(event, wallet):
    body = json.loads(event.get("body") or "{}")
    try: ts = int(body.get("ts"))
    except Exception: return resp(400, {"error": "ts required"})
    on = bool(body.get("on", True))
    try:
        if on:
            T_FEED.update_item(
                Key={"shard": "FEED", "ts": ts},
                UpdateExpression="ADD liked_by :w",
                ExpressionAttributeValues={":w": set([wallet])},
                ConditionExpression="attribute_exists(#t)",
                ExpressionAttributeNames={"#t": "ts"},
            )
        else:
            T_FEED.update_item(
                Key={"shard": "FEED", "ts": ts},
                UpdateExpression="DELETE liked_by :w",
                ExpressionAttributeValues={":w": set([wallet])},
                ConditionExpression="attribute_exists(#t)",
                ExpressionAttributeNames={"#t": "ts"},
            )
    except Exception as e:
        return resp(404, {"error": str(e)})
    item = T_FEED.get_item(Key={"shard": "FEED", "ts": ts}).get("Item") or {}
    likes = item.get("liked_by") or set()
    return resp(200, {"ts": ts, "likes": len(likes), "liked_by": sorted(likes)})

def handle_profile(event, _wallet, target):
    target = target.lower()
    if not target.startswith("0x") or len(target) != 42:
        return resp(400, {"error": "bad wallet"})
    u = T_USERS.get_item(Key={"wallet": target}).get("Item") or {}
    if not u: return resp(404, {"error": "no such camel"})
    # last 20 posts
    r = T_FEED.query(
        KeyConditionExpression=Key("shard").eq("FEED"),
        FilterExpression=Key("wallet").eq(target),
        ScanIndexForward=False, Limit=200,
    )
    posts = [p for p in r.get("Items", []) if (p.get("wallet") or "").lower() == target][:20]
    return resp(200, {
        **_user_view(u, target),
        "posts": posts,
        "x_handle": u.get("x_handle"),
    })

def handle_group(event, wallet):
    method = event["requestContext"]["http"]["method"]
    if method == "POST":
        body = json.loads(event.get("body") or "{}")
        return post_message(T_GROUP, "shard", "GLOBAL", wallet, body.get("text"))
    since = int((event.get("queryStringParameters") or {}).get("since", 0))
    return resp(200, {"items": _hydrate_authors(list_since(T_GROUP, "shard", "GLOBAL", since))})

def pair_id(a, b):
    a, b = sorted([a.lower(), b.lower()])
    return hashlib.sha256(f"{a}|{b}".encode()).hexdigest()[:32]

def handle_dm(event, wallet, peer):
    peer = peer.lower()
    if not peer.startswith("0x") or len(peer) != 42:
        return resp(400, {"error": "bad peer"})
    pid = pair_id(wallet, peer)
    method = event["requestContext"]["http"]["method"]
    if method == "POST":
        body = json.loads(event.get("body") or "{}")
        text = (body.get("text") or "").strip()
        if not text or len(text) > TEXT_MAX:
            return resp(400, {"error": f"text length 1..{TEXT_MAX}"})
        ts = int(time.time() * 1000)
        u = get_user(wallet)
        item = {
            "pair_id": pid, "ts": ts, "from": wallet, "to": peer, "text": text,
            "from_camel_id": u.get("camel_id") or short_camel_id(wallet),
            "from_handle": u.get("handle") or "",
        }
        T_DM.put_item(Item=item)
        return resp(200, item)
    since = int((event.get("queryStringParameters") or {}).get("since", 0))
    return resp(200, {"items": list_since(T_DM, "pair_id", pid, since), "peer": peer})

def handle_upload(event, wallet):
    """Returns a presigned S3 PUT URL for an image. Auth required."""
    body = json.loads(event.get("body") or "{}")
    ct = (body.get("content_type") or "").lower().strip()
    size = int(body.get("size") or 0)
    if ct not in UPLOAD_ALLOWED:
        return resp(400, {"error": f"unsupported content_type: {ct}", "allowed": sorted(UPLOAD_ALLOWED)})
    is_video = ct.startswith("video/") or ct.startswith("audio/")
    cap = UPLOAD_MAX_BYTES_VIDEO if is_video else UPLOAD_MAX_BYTES_IMAGE
    if size <= 0 or size > cap:
        return resp(400, {"error": f"size must be 1..{cap} bytes for {ct}"})
    ext = UPLOAD_ALLOWED[ct]
    key = f"{UPLOAD_PREFIX}{int(time.time())}-{uuid.uuid4().hex[:12]}.{ext}"
    url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": UPLOAD_BUCKET, "Key": key,
            "ContentType": ct, "CacheControl": "max-age=2592000",
        },
        ExpiresIn=300, HttpMethod="PUT",
    )
    return resp(200, {
        "upload_url": url,
        "public_url": UPLOAD_PUBLIC_BASE + key.split("/", 1)[1],
        "content_type": ct,
        "max_bytes": cap,
    })

def handle_donate(event):
    """Public endpoint — no auth required. Verifies on-chain tx then stores."""
    method = event["requestContext"]["http"]["method"]
    if method == "GET":
        # Public donor wall — newest first, last 100
        r = T_DONATE.query(
            KeyConditionExpression=Key("shard").eq("DON"),
            ScanIndexForward=False, Limit=100,
        )
        return resp(200, {"items": r.get("Items", []), "recipient": DEV_WALLET})
    body = json.loads(event.get("body") or "{}")
    tx_hash = (body.get("tx_hash") or "").strip().lower()
    note    = (body.get("note") or "").strip()[:NOTE_MAX]
    if not tx_hash.startswith("0x") or len(tx_hash) != 66:
        return resp(400, {"error": "bad tx_hash"})
    try:
        tx = rpc_call("eth_getTransactionByHash", [tx_hash]).get("result")
        rc = rpc_call("eth_getTransactionReceipt", [tx_hash]).get("result")
    except Exception as e:
        return resp(502, {"error": f"rpc failed: {e}"})
    if not tx:
        return resp(404, {"error": "tx not found yet — try again in a few seconds"})
    if not rc or rc.get("status") != "0x1":
        return resp(400, {"error": "tx not confirmed or reverted"})
    if (tx.get("to") or "").lower() != DEV_WALLET:
        return resp(400, {"error": "tx recipient is not the dev wallet"})
    value_wei = int(tx.get("value", "0x0"), 16)
    if value_wei <= 0:
        return resp(400, {"error": "tx has zero value"})
    sender = (tx.get("from") or "").lower()
    # Idempotent: tx_hash uniqueness checked by overwriting same record (sk=ts is fine for ordering, dedup via filter on read)
    existing = T_DONATE.scan(
        FilterExpression=Key("tx_hash").eq(tx_hash),
        Limit=1,
    ).get("Items", [])
    if existing:
        return resp(200, existing[0])
    item = {
        "shard": "DON", "ts": int(time.time() * 1000),
        "tx_hash": tx_hash, "wallet": sender, "amount_wei": str(value_wei),
        "note": note, "block": tx.get("blockNumber"),
    }
    T_DONATE.put_item(Item=item)
    return resp(200, item)

def handle_scores(event, wallet):
    """Per-game leaderboard. Sort key 'score_ts' = zero-padded inverted score + ts so DDB query sorts top-first."""
    method = event["requestContext"]["http"]["method"]
    qs = event.get("queryStringParameters") or {}
    game = (qs.get("game") or "").lower()
    if game and game not in ARCADE_GAMES:
        return resp(400, {"error": "unknown game", "games": sorted(ARCADE_GAMES)})

    if method == "POST":
        body = json.loads(event.get("body") or "{}")
        g = (body.get("game") or "").lower()
        if g not in ARCADE_GAMES:
            return resp(400, {"error": "unknown game"})
        try: score = int(body.get("score"))
        except Exception: return resp(400, {"error": "score required"})
        if score < 0 or score > SCORE_MAX:
            return resp(400, {"error": f"score out of range 0..{SCORE_MAX}"})
        u = get_user(wallet)
        ts = int(time.time() * 1000)
        # Sort key: inverted-score (desc) + ts (asc tiebreak). Using zero-padded width 12 = up to 1e12.
        inv = (10**12) - score
        sk = f"{inv:012d}#{ts}"
        item = {
            "game": g, "score_ts": sk,
            "wallet": wallet, "score": score, "ts": ts,
            "handle": u.get("handle") or "",
            "pfp_image": u.get("pfp_image") or "",
            "meta": (body.get("meta") or {}),
        }
        T_SCORES.put_item(Item=item)
        return resp(200, item)

    def hydrate(rows, key="wallet"):
        wallets = list({(r.get(key) or "").lower() for r in rows if r.get(key)})
        if not wallets: return rows
        users = {}
        for w in wallets:
            try:
                u = T_USERS.get_item(Key={"wallet": w}).get("Item") or {}
                users[w] = u
            except Exception: pass
        for r in rows:
            w = (r.get(key) or "").lower()
            u = users.get(w)
            if not u: continue
            if u.get("pfp_image"): r["pfp_image"] = u["pfp_image"]
            if u.get("handle"):    r["handle"]    = u["handle"]
            if u.get("x_handle"):  r["x_handle"]  = u["x_handle"]
        return rows

    # GET — leaderboard
    if qs.get("scope") == "global":
        # Aggregate best per (wallet, game), then sum to a single total per wallet.
        best = {}  # wallet -> {game -> {score, handle, pfp_image, x_handle}}
        for g in sorted(ARCADE_GAMES):
            r = T_SCORES.query(KeyConditionExpression=Key("game").eq(g), Limit=200)
            for it in r.get("Items", []):
                w = (it.get("wallet") or "").lower()
                cur = best.setdefault(w, {})
                prev = cur.get(g)
                sc = int(it.get("score", 0) or 0)
                if not prev or sc > prev["score"]:
                    cur[g] = {
                        "score": sc, "handle": it.get("handle") or "",
                        "pfp_image": it.get("pfp_image") or "",
                    }
        rows = []
        for wallet, by_game in best.items():
            total = sum(v["score"] for v in by_game.values())
            sample = next(iter(by_game.values()))
            rows.append({
                "wallet": wallet,
                "total": total,
                "games_played": len(by_game),
                "by_game": {g: v["score"] for g, v in by_game.items()},
                "handle": sample["handle"],
                "pfp_image": sample["pfp_image"],
            })
        rows.sort(key=lambda r: -r["total"])
        return resp(200, {"items": hydrate(rows[:50]), "games": sorted(ARCADE_GAMES)})

    if not game:
        # Top 5 across each game
        out = {}
        for g in sorted(ARCADE_GAMES):
            r = T_SCORES.query(KeyConditionExpression=Key("game").eq(g), Limit=5)
            out[g] = r.get("Items", [])
        return resp(200, {"games": out})
    r = T_SCORES.query(KeyConditionExpression=Key("game").eq(game), Limit=50)
    return resp(200, {"game": game, "items": hydrate(r.get("Items", []))})

def handle_canvas(event, wallet):
    method = event["requestContext"]["http"]["method"]
    if method == "POST":
        body = json.loads(event.get("body") or "{}")
        try:
            x = int(body.get("x")); y = int(body.get("y")); color = int(body.get("color"))
        except Exception:
            return resp(400, {"error": "x,y,color required ints"})
        if not (0 <= x < CANVAS_W and 0 <= y < CANVAS_H):
            return resp(400, {"error": f"out of bounds (0..{CANVAS_W-1})"})
        if not (0 <= color < len(PALETTE)):
            return resp(400, {"error": "bad color index"})
        now_ms = int(time.time() * 1000)
        u = get_user(wallet)
        last = int(u.get("last_pixel_ts", 0) or 0)
        wait = PIXEL_COOLDOWN_MS - (now_ms - last)
        if wait > 0:
            return resp(429, {"error": "cooldown", "wait_ms": wait})
        T_USERS.update_item(
            Key={"wallet": wallet},
            UpdateExpression="SET last_pixel_ts = :n",
            ExpressionAttributeValues={":n": now_ms},
        )
        T_CANVAS.put_item(Item={"shard": "C", "xy": f"{x:03d}:{y:03d}", "x": x, "y": y, "color": color, "wallet": wallet, "ts": now_ms})
        return resp(200, {"x": x, "y": y, "color": color, "ts": now_ms, "next_in_ms": PIXEL_COOLDOWN_MS})

    # GET — full board (compact). Optional ?since=ms returns only pixels placed after that ts.
    since = int((event.get("queryStringParameters") or {}).get("since", 0))
    out = []
    last_eval = None
    while True:
        kwargs = {"KeyConditionExpression": Key("shard").eq("C"), "Limit": 1000}
        if last_eval: kwargs["ExclusiveStartKey"] = last_eval
        r = T_CANVAS.query(**kwargs)
        for it in r.get("Items", []):
            ts = int(it.get("ts", 0))
            if since and ts <= since: continue
            out.append([int(it["x"]), int(it["y"]), int(it["color"]), ts])
        last_eval = r.get("LastEvaluatedKey")
        if not last_eval: break
    return resp(200, {
        "w": CANVAS_W, "h": CANVAS_H, "palette": PALETTE,
        "cooldown_ms": PIXEL_COOLDOWN_MS, "pixels": out,
        "now_ms": int(time.time() * 1000),
    })

def handle_camels(event, wallet):
    r = T_USERS.scan(Limit=200)
    out = [{
        "wallet": it.get("wallet"),
        "camel_id": it.get("camel_id"),
        "handle": it.get("handle"),
        "joined_at": it.get("joined_at"),
        "last_seen": it.get("last_seen"),
        "pfp_image": it.get("pfp_image"),
        "pfp_name": it.get("pfp_name"),
        "x_handle": it.get("x_handle"),
    } for it in r.get("Items", [])]
    out.sort(key=lambda x: -(x.get("last_seen") or 0))
    return resp(200, {"items": out})

def lambda_handler(event, context):
    rc = event.get("requestContext", {}).get("http", {})
    method = rc.get("method", "")
    path = event.get("rawPath", "") or rc.get("path", "")
    if method == "OPTIONS":
        return resp(200)
    try:
        if path.endswith("/cabal/nonce") and method == "GET":
            return handle_nonce(event)
        if path.endswith("/cabal/verify") and method == "POST":
            return handle_verify(event)
        if path.endswith("/cabal/donate"):
            return handle_donate(event)
        # Public reads of leaderboard
        if path.endswith("/cabal/scores") and method == "GET":
            return handle_scores(event, None)
        if path.endswith("/cabal/x/redirect"):
            return handle_x_redirect(event)
        if path.endswith("/cabal/x/callback"):
            return handle_x_callback(event)

        wallet = auth_wallet(event)
        if not wallet:
            return resp(401, {"error": "unauthenticated"})

        if path.endswith("/cabal/me"):
            return handle_me(event, wallet)
        if path.endswith("/cabal/pfp"):
            return handle_pfp(event, wallet)
        if path.endswith("/cabal/feed"):
            return handle_feed(event, wallet)
        if path.endswith("/cabal/like"):
            return handle_like(event, wallet)
        if "/cabal/profile/" in path:
            target = path.rsplit("/", 1)[-1]
            return handle_profile(event, wallet, target)
        if path.endswith("/cabal/group"):
            return handle_group(event, wallet)
        if path.endswith("/cabal/camels"):
            return handle_camels(event, wallet)
        if path.endswith("/cabal/canvas"):
            return handle_canvas(event, wallet)
        if path.endswith("/cabal/scores"):
            return handle_scores(event, wallet)
        if path.endswith("/cabal/upload"):
            return handle_upload(event, wallet)
        if "/cabal/dm/" in path:
            peer = path.rsplit("/", 1)[-1]
            return handle_dm(event, wallet, peer)
        return resp(404, {"error": "not found", "path": path})
    except Exception as e:
        return resp(500, {"error": str(e)})
