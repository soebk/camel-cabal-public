// Camel Cabal — gated social client. Powered by ebk.tech.
const CABAL_API = "https://<your-api-domain>/cabal";
const CABAL_TOKEN_KEY = "cabal.token";
const CABAL_WALLET_KEY = "cabal.wallet";

window.cabalState = {
    token: localStorage.getItem(CABAL_TOKEN_KEY) || null,
    wallet: localStorage.getItem(CABAL_WALLET_KEY) || null,
    me: null,
    peers: [],
    peersByWallet: {},
    activePeer: null,
    sub: "feed",
    pollers: {},
    seen: { feed: 0, group: 0, dm: 0 },
    canvas: { w: 100, h: 100, palette: [], cooldown_ms: 3000, color: 5, lastSync: 0, pixelCanvas: null, pixelCtx: null, lastPlace: 0 },
};

function $(id) { return document.getElementById(id); }
function escHtml(s) { return (s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

// ── URL auto-embed renderer (inline media, no external link clutter) ─
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|heic|heif)(\?|#|$)/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i;
const AUDIO_EXT_RE = /\.(mp3|ogg|wav|m4a)(\?|#|$)/i;
const CABAL_UPLOAD_PREFIX = "https://ebk.tech/cabal-uploads/";
function ytId(u) {
    try {
        const url = new URL(u);
        if (url.hostname.includes("youtu.be")) return url.pathname.slice(1).split("/")[0];
        if (url.hostname.includes("youtube.com")) {
            if (url.pathname === "/watch") return url.searchParams.get("v");
            const m = url.pathname.match(/^\/(embed|shorts)\/([^/?#]+)/);
            if (m) return m[2];
        }
    } catch {}
    return null;
}
function tweetId(u) {
    try {
        const url = new URL(u);
        if (!/^(www\.)?(twitter|x)\.com$/i.test(url.hostname)) return null;
        const m = url.pathname.match(/\/status(?:es)?\/(\d+)/);
        return m ? m[1] : null;
    } catch { return null; }
}
function renderRichText(text) {
    if (!text) return "";
    const parts = [];
    const matches = [...text.matchAll(URL_RE)];
    let cursor = 0;
    const embeds = [];
    for (const m of matches) {
        const url = m[0];
        const start = m.index;
        if (start > cursor) parts.push(escHtml(text.slice(cursor, start)));
        const safe = encodeURI(url);
        const yt = ytId(url);
        const isUpload = url.startsWith(CABAL_UPLOAD_PREFIX);
        // Treat cabal-uploads as media even if extension is missing/unknown.
        const isImg = IMG_EXT_RE.test(url) || (isUpload && /\.(png|jpe?g|gif|webp|avif|svg|bmp|heic|heif)$/i.test(url.split("?")[0]));
        const isVid = VIDEO_EXT_RE.test(url) || (isUpload && /\.(mp4|webm|mov|m4v|ogv)$/i.test(url.split("?")[0]));
        const isAud = AUDIO_EXT_RE.test(url);
        if (isImg) {
            embeds.push(`<a href="${safe}" target="_blank" rel="noopener" class="cabal-img-link"><img class="cabal-inline-img" src="${safe}" alt="" loading="lazy"></a>`);
            // URL itself: don't render — image stands alone
        } else if (isVid) {
            embeds.push(`<video class="cabal-inline-video" src="${safe}" controls preload="metadata" loading="lazy" playsinline></video>`);
        } else if (isAud) {
            embeds.push(`<audio class="cabal-inline-audio" src="${safe}" controls preload="metadata"></audio>`);
        } else if (yt) {
            embeds.push(`<div class="cabal-yt"><iframe src="https://www.youtube.com/embed/${escHtml(yt)}" frameborder="0" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`);
        } else {
            const display = url.length > 60 ? url.slice(0, 57) + "…" : url;
            parts.push(`<a href="${safe}" target="_blank" rel="noopener" class="cabal-link">${escHtml(display)}</a>`);
        }
        cursor = start + url.length;
    }
    if (cursor < text.length) parts.push(escHtml(text.slice(cursor)));
    const textPart = parts.join("").trim();
    return (textPart || "") + (embeds.length ? `<div class="cabal-embeds">${embeds.join("")}</div>` : "");
}

// Image upload helper — used by feed + group composers.
async function uploadImageFile(file, statusEl) {
    if (!file) return null;
    const ct = file.type || "application/octet-stream";
    if (!/^(image|video|audio)\//.test(ct)) { if (statusEl) statusEl.textContent = "only image / video / audio allowed"; return null; }
    const cap = ct.startsWith("image/") ? 8 * 1024 * 1024 : 25 * 1024 * 1024;
    if (file.size > cap) { if (statusEl) statusEl.textContent = `too big (max ${cap/1024/1024}MB)`; return null; }
    if (statusEl) statusEl.textContent = "uploading…";
    try {
        const r = await api("/upload", { method: "POST", body: JSON.stringify({ content_type: ct, size: file.size }) });
        const put = await fetch(r.upload_url, { method: "PUT", headers: { "Content-Type": ct, "Cache-Control": "max-age=2592000" }, body: file });
        if (!put.ok) throw new Error("S3 PUT " + put.status);
        if (statusEl) statusEl.textContent = "";
        return r.public_url;
    } catch (e) {
        if (statusEl) statusEl.textContent = "upload failed: " + e.message;
        return null;
    }
}
function bindImageUpload(inputId, textEl, statusEl) {
    const input = $(inputId);
    if (!input) return;
    input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        input.value = "";
        if (!file) return;
        const url = await uploadImageFile(file, statusEl);
        if (url) {
            const cur = textEl.value;
            textEl.value = (cur ? cur.replace(/\s*$/, "") + "\n" : "") + url + "\n";
            textEl.focus();
        }
    });
    // paste image directly
    textEl.addEventListener("paste", async (e) => {
        const items = (e.clipboardData || {}).items || [];
        for (const it of items) {
            if (it.kind === "file" && /^image\//.test(it.type)) {
                e.preventDefault();
                const file = it.getAsFile();
                const url = await uploadImageFile(file, statusEl);
                if (url) {
                    const cur = textEl.value;
                    textEl.value = (cur ? cur.replace(/\s*$/, "") + "\n" : "") + url + "\n";
                }
                return;
            }
        }
    });
}
function fmtTime(ms) {
    const d = new Date(ms); const diff = (Date.now() - ms) / 1000;
    if (diff < 60) return Math.max(0,Math.floor(diff)) + "s ago";
    if (diff < 3600) return Math.floor(diff/60) + "m ago";
    if (diff < 86400) return Math.floor(diff/3600) + "h ago";
    return d.toLocaleString();
}
function shortAddr(a) { return a ? a.slice(0,6) + "…" + a.slice(-4) : ""; }
function deriveCamelId(wallet) {
    return "Camel-" + (wallet||"").slice(2,6).toUpperCase() + (wallet||"").slice(-4).toUpperCase();
}
function pfpFor(wallet, fallbackImage) {
    const w = (wallet||"").toLowerCase();
    const me = cabalState.me;
    if (me && w === cabalState.wallet && me.pfp_image) return me.pfp_image;
    const peer = cabalState.peersByWallet[w];
    if (peer && peer.pfp_image) return peer.pfp_image;
    return fallbackImage || "";
}
function authorLabel(wallet, _camelId, handle, postPfp) {
    const name = (handle && handle.trim()) ? handle.trim() : shortAddr(wallet);
    const img = pfpFor(wallet, postPfp);
    const avatar = img
        ? `<img class="cabal-avatar" src="${escHtml(img)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<span class="cabal-avatar cabal-avatar-empty">▣</span>`;
    return `${avatar}<span class="author-handle">${escHtml(name)}</span>`;
}
function resolveAuthor(wallet, fallbackId, fallbackHandle) {
    const w = (wallet||"").toLowerCase();
    if (w === cabalState.wallet && cabalState.me) {
        return { camel_id: cabalState.me.camel_id || fallbackId || deriveCamelId(w), handle: cabalState.me.handle || fallbackHandle || "" };
    }
    const peer = cabalState.peersByWallet[w];
    if (peer) return { camel_id: peer.camel_id || fallbackId || deriveCamelId(w), handle: peer.handle || fallbackHandle || "" };
    return { camel_id: fallbackId || deriveCamelId(w), handle: fallbackHandle || "" };
}

async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers||{}) };
    if (cabalState.token) headers["Authorization"] = "Bearer " + cabalState.token;
    const r = await fetch(CABAL_API + path, { ...opts, headers });
    let j = {};
    try { j = await r.json(); } catch {}
    if (r.status === 401) { cabalLogout(); throw new Error(j.error || "session expired — sign in again"); }
    if (!r.ok) { const e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; e.body = j; throw e; }
    return j;
}

function setGateStatus(msg, kind) {
    const el = $("cabal-gate-status"); if (!el) return;
    el.textContent = msg; el.className = "swap-status" + (kind ? " " + kind : "");
}
function flash(target, msg, kind) {
    const el = $(target); if (!el) return;
    el.textContent = msg; el.className = "cabal-flash " + (kind || "");
    setTimeout(() => { if (el.textContent === msg) { el.textContent = ""; el.className = "cabal-flash"; } }, 4000);
}

// micro-web3 wallet bridge — EIP-6963 multi-wallet detection, falls back to direct ethereum.
let _walletSvc = null;
async function microWeb3Connect() {
    if (!window.microWeb3 || !window.microact) return null;
    try {
        if (!_walletSvc) {
            const eb = new microact.EventBus();
            _walletSvc = new microWeb3.WalletService(eb);
            await _walletSvc.initialize();
        }
        const available = _walletSvc.getAvailableWallets() || [];
        if (!available.length) return null;
        // Prefer metamask if multiple wallets are detected; else first.
        const mm = available.find(w => (w.type || w.legacyType || "").toLowerCase() === "metamask");
        const pick = mm || available[0];
        const type = pick.type || pick.legacyType;
        if (!type) return null;
        await _walletSvc.connect(type);
        const { provider: ethersProvider, signer } = _walletSvc.getProviderAndSigner();
        if (!ethersProvider || !signer) return null;
        const address = (_walletSvc.getAddress() || await signer.getAddress()).toLowerCase();
        return { provider: ethersProvider, signer, address, walletType: type };
    } catch (e) {
        console.warn("[cabal] microWeb3 connect failed, falling back:", e);
        return null;
    }
}

async function cabalLogin() {
    if (!window.ethereum && !window.microWeb3) { setGateStatus("No wallet detected. Install MetaMask.", "err"); return; }
    try {
        setGateStatus("Connecting…");
        let provider, signer, wallet;
        const mw = await microWeb3Connect();
        if (mw) {
            provider = mw.provider; signer = mw.signer; wallet = mw.address;
            console.log("[cabal] connected via microWeb3:", mw.walletType);
        } else {
            provider = new ethers.providers.Web3Provider(window.ethereum, "any");
            await provider.send("eth_requestAccounts", []);
            signer = provider.getSigner();
            wallet = (await signer.getAddress()).toLowerCase();
        }
        const net = await provider.getNetwork();
        if (net.chainId !== 1) {
            try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }); }
            catch { setGateStatus("Switch to Ethereum mainnet.", "err"); return; }
        }

        setGateStatus("Fetching nonce…");
        const nonce = await api(`/nonce?wallet=${wallet}`);

        setGateStatus("Sign the message in your wallet…");
        const signature = await signer.signMessage(nonce.message);

        setGateStatus("Verifying signature & balance…");
        const r = await fetch(CABAL_API + "/verify", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wallet, signature, challenge: nonce.challenge }),
        });
        const j = await r.json();
        if (!r.ok) {
            if (j.error === "insufficient $CAMEL") {
                const have = BigInt(j.balance) / 10n**18n;
                const nfts = Number(have / 1000000n);
                setGateStatus(`You hold ${have.toLocaleString()} $CAMEL (~${nfts} NFT${nfts===1?'':'s'}). Need 1 CAMEL NFT to enter.`, "err"); return;
            }
            setGateStatus("Auth failed: " + (j.error || r.status), "err"); return;
        }
        cabalState.token = j.token;
        cabalState.wallet = j.wallet;
        cabalState.me = j;
        localStorage.setItem(CABAL_TOKEN_KEY, j.token);
        localStorage.setItem(CABAL_WALLET_KEY, j.wallet);
        cabalEnter();
    } catch (e) { setGateStatus("Failed: " + (e.message || e), "err"); }
}

function cabalLogout() {
    cabalState.token = null; cabalState.wallet = null; cabalState.me = null;
    localStorage.removeItem(CABAL_TOKEN_KEY); localStorage.removeItem(CABAL_WALLET_KEY);
    Object.values(cabalState.pollers).forEach(clearInterval); cabalState.pollers = {};
    if ($("cabal-gate")) $("cabal-gate").style.display = "block";
    if ($("cabal-app"))  $("cabal-app").style.display  = "none";
    setGateStatus("Session ended.", "");
}

function renderMeHeader() {
    const me = cabalState.me; if (!me) return;
    const handle = (me.handle || "").trim();
    const name = handle || shortAddr(me.wallet);
    const img = me.pfp_image
        ? `<img class="cabal-avatar cabal-me-avatar" src="${escHtml(me.pfp_image)}" alt="" title="${escHtml(me.pfp_name||'')}" onerror="this.style.display='none'">`
        : `<span class="cabal-avatar cabal-me-avatar cabal-avatar-empty">▣</span>`;
    $("cabal-me-id").innerHTML = img + `<span class="author-handle">${escHtml(name)}</span>`;
    if ($("cabal-me-addr")) $("cabal-me-addr").textContent = shortAddr(me.wallet);
    if ($("cabal-handle")) $("cabal-handle").value = handle;
    const badge = $("cabal-x-badge");
    if (badge) {
        if (me.x_handle) {
            badge.style.display = "inline-block";
            badge.innerHTML = `<a href="https://x.com/${escHtml(me.x_handle)}" target="_blank" rel="noopener">@${escHtml(me.x_handle)}</a>`;
            const xb = $("connect-x"); if (xb) xb.textContent = "X linked ✓";
        } else {
            badge.style.display = "none";
            const xb = $("connect-x"); if (xb) xb.textContent = "connect X";
        }
    }
}

// ── PFP picker — Alchemy for owned NFTs, server validates ownership ─
const ALCHEMY_NFT = "https://eth-mainnet.g.alchemy.com/nft/v3/demo/getNFTsForOwner";
const CAMEL_MIRROR = "0x9f2F3E04c67AD0854A6b225d5FDdBaE513dF0fCC";
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const CAMEL_IMG_BASE = "bafybeihmyehthelvcbwzee6pzmtintyhi6jufw5jz5qwcu7v7xuixe7ffu";
let cachedOwnedCamels = null;

function camelImageUrl(tokenId) {
    return `${IPFS_GATEWAY}${CAMEL_IMG_BASE}/${tokenId}.webp`;
}

async function fetchOwnedCamels(wallet) {
    if (cachedOwnedCamels) return cachedOwnedCamels;
    const all = [];
    let pageKey = "";
    try {
        for (let i = 0; i < 10; i++) {  // up to 1000 NFTs
            const url = `${ALCHEMY_NFT}?owner=${wallet}&contractAddresses[]=${CAMEL_MIRROR}&pageSize=100&withMetadata=true${pageKey ? "&pageKey=" + encodeURIComponent(pageKey) : ""}`;
            const r = await fetch(url);
            if (!r.ok) throw new Error("alchemy " + r.status);
            const j = await r.json();
            for (const n of (j.ownedNfts || [])) {
                const tid = n.tokenId;
                const img = (n.image && (n.image.cachedUrl || n.image.thumbnailUrl || n.image.originalUrl)) || camelImageUrl(tid);
                all.push({ token_id: tid, name: n.name || `Camel #${tid}`, image: img });
            }
            pageKey = j.pageKey || "";
            if (!pageKey) break;
        }
    } catch (e) { console.warn("[cabal] alchemy fetch failed", e); }
    all.sort((a,b) => { try { return Number(BigInt(a.token_id) - BigInt(b.token_id)); } catch { return 0; } });
    cachedOwnedCamels = all;
    return all;
}

async function pickPfp(token_id, image_url, name) {
    try {
        const me = await api("/pfp", { method: "POST", body: JSON.stringify({ token_id, image_url, name }) });
        cabalState.me = me;
        renderMeHeader();
        cabalLoadFeed();
        cabalLoadCamels();
        flash("cabal-handle-flash", "pfp set", "ok");
        return true;
    } catch (e) {
        flash("cabal-handle-flash", "pfp failed: " + e.message, "err");
        return false;
    }
}

async function autoSelectPfpIfMissing() {
    if (cabalState.me && cabalState.me.pfp_image) return;
    const owned = await fetchOwnedCamels(cabalState.wallet);
    if (!owned.length) return;
    const c = owned[0];
    await pickPfp(c.token_id, c.image, c.name);
}

function startXConnect(mode) {
    if (!cabalState.token) {
        flash("cabal-handle-flash", "sign in first, then try X again", "err");
        return;
    }
    const m = (mode === "link_only") ? "link_only" : "avatar";
    location.href = `${CABAL_API}/x/redirect?token=${encodeURIComponent(cabalState.token)}&mode=${m}`;
}

async function openPfpPicker() {
    let modal = $("pfp-modal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "pfp-modal";
        modal.className = "pfp-modal";
        modal.innerHTML = `
            <div class="pfp-modal-inner">
                <div class="pfp-modal-header">
                    <span>choose a camel · only camels you own</span>
                    <div class="pfp-modal-actions">
                        <button class="cabal-mini-btn" id="pfp-x-link">link X (keep camel pfp)</button>
                        <button class="cabal-mini-btn primary" id="pfp-x-connect">use X avatar</button>
                        <button class="cabal-mini-btn" id="pfp-modal-close">close</button>
                    </div>
                </div>
                <div id="pfp-modal-body" class="pfp-grid"><div class="cabal-empty">loading…</div></div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
        $("pfp-modal-close").addEventListener("click", () => modal.remove());
        $("pfp-x-connect").addEventListener("click", () => startXConnect("avatar"));
        $("pfp-x-link").addEventListener("click", () => startXConnect("link_only"));
    }
    const body = $("pfp-modal-body");
    const owned = await fetchOwnedCamels(cabalState.wallet);
    if (!owned.length) {
        body.innerHTML = `<div class="cabal-empty">no camels found for this wallet · holdings may be syncing</div>`;
        return;
    }
    const cur = cabalState.me && String(cabalState.me.pfp_token_id || "");
    body.innerHTML = owned.map(c => `
        <button class="pfp-tile ${cur===String(c.token_id)?'active':''}" data-tid="${escHtml(c.token_id)}" data-img="${escHtml(c.image)}" data-name="${escHtml(c.name)}">
            ${c.image ? `<img src="${escHtml(c.image)}" alt="" loading="lazy">` : '<span class="cabal-avatar-empty">▣</span>'}
            <div class="pfp-tile-name">${escHtml(c.name)}</div>
        </button>`).join("");
    body.querySelectorAll(".pfp-tile").forEach(el => {
        el.addEventListener("click", async () => {
            body.querySelectorAll(".pfp-tile").forEach(t => t.classList.remove("active"));
            el.classList.add("active");
            const ok = await pickPfp(el.dataset.tid, el.dataset.img, el.dataset.name);
            if (ok) setTimeout(() => modal.remove(), 400);
        });
    });
}

async function cabalEnter() {
    $("cabal-gate").style.display = "none";
    $("cabal-app").style.display = "block";
    // Bind sub-tabs directly (in addition to document-level delegate) so they always work.
    document.querySelectorAll(".cabal-sub[data-sub]").forEach(a => {
        a.onclick = (e) => { e.preventDefault(); cabalSwitchSub(a.dataset.sub); };
    });
    if ($("cabal-logout")) $("cabal-logout").onclick = (e) => { e.preventDefault(); cabalLogout(); };
    try {
        const me = await api("/me");
        cabalState.me = me;
        renderMeHeader();
    } catch (e) { return; }
    await cabalLoadCamels();
    await cabalLoadFeed();
    autoSelectPfpIfMissing();  // background — sets pfp on first login if owned
    cabalSwitchSub(cabalSubFromHash());
    window.addEventListener("hashchange", () => cabalSwitchSub(cabalSubFromHash()));
    startPolling();
}

function startPolling() {
    Object.values(cabalState.pollers).forEach(clearInterval);
    cabalState.pollers = {
        feed:   setInterval(() => { if (cabalState.sub === "feed")  cabalLoadFeed();  }, 5000),
        group:  setInterval(() => { if (cabalState.sub === "group") cabalLoadGroup(); }, 4000),
        camels: setInterval(cabalLoadCamels, 30000),
        canvas: setInterval(() => { if (cabalState.sub === "board") cabalLoadCanvas(true); }, 4000),
        cdtimer: setInterval(updateCanvasCooldown, 500),
    };
}

async function cabalSaveHandle() {
    const h = $("cabal-handle").value.trim();
    try {
        const me = await api("/me", { method: "POST", body: JSON.stringify({ handle: h }) });
        cabalState.me = me;
        renderMeHeader();
        flash("cabal-handle-flash", "saved", "ok");
        cabalLoadCamels();
        cabalLoadFeed();
    } catch (e) { flash("cabal-handle-flash", "save failed: " + e.message, "err"); }
}

const VALID_SUBS = ["feed","group","camels","board","arcade","profile"];
function cabalSwitchSub(name) {
    if (!VALID_SUBS.includes(name)) name = "feed";
    console.log("[cabal] switch →", name);
    cabalState.sub = name;
    document.querySelectorAll(".cabal-sub").forEach(a => a.classList.toggle("active", a.dataset.sub === name));
    VALID_SUBS.forEach(k => {
        const el = $("cabal-sub-" + k);
        if (el) el.style.display = (k === name) ? "block" : "none";
    });
    if (name === "group") cabalLoadGroup();
    if (name === "board") cabalLoadCanvas(false);
    if (name === "arcade" && window.arcadeBoot) window.arcadeBoot();
    if (name !== "arcade" && window.arcadeStop) window.arcadeStop();
    if (name === "profile") {
        const w = profileWalletFromHash();
        if (w) loadProfile(w);
    }
}
function cabalSubFromHash() {
    const h = (location.hash || "").replace("#","");
    if (h.startsWith("u/")) return "profile";
    return VALID_SUBS.includes(h) ? h : "feed";
}
function profileWalletFromHash() {
    const h = (location.hash || "").replace("#","");
    return h.startsWith("u/") ? h.slice(2).toLowerCase() : null;
}

async function loadProfile(wallet) {
    const pane = $("cabal-sub-profile");
    if (!pane) return;
    pane.innerHTML = `<div class="cabal-empty">loading profile…</div>`;
    try {
        const u = await api("/profile/" + wallet);
        const camels = await fetchProfileCamels(wallet);
        const handle = (u.handle || "").trim();
        const name = handle || shortAddr(wallet);
        const pfp = u.pfp_image
            ? `<img class="cabal-profile-pfp" src="${escHtml(u.pfp_image)}" onerror="this.style.display='none'">`
            : `<div class="cabal-profile-pfp cabal-avatar-empty">▣</div>`;
        const xBadge = u.x_handle ? `<a class="cabal-x-badge" href="https://x.com/${escHtml(u.x_handle)}" target="_blank" rel="noopener">@${escHtml(u.x_handle)} on X</a>` : '';
        const lastSeen = u.last_seen ? fmtTime(u.last_seen * 1000) : "—";
        const memberSince = u.joined_at ? new Date(u.joined_at*1000).toLocaleDateString() : "—";
        const collectionGrid = camels.length
            ? `<div class="cabal-profile-grid">${camels.map(c => `
                <div class="cabal-profile-camel" title="${escHtml(c.name)}">
                    ${c.image ? `<img src="${escHtml(c.image)}" loading="lazy">` : '<span class="cabal-avatar-empty">▣</span>'}
                    <div class="cabal-profile-camel-name">#${escHtml(c.token_id)}</div>
                </div>`).join("")}</div>`
            : `<div class="cabal-empty">no camels found</div>`;
        const postsHtml = (u.posts || []).slice(0, 20).map(p => `
            <div class="cabal-card">
                <div class="cabal-card-meta"><span class="cabal-card-time">${fmtTime(p.ts)}</span></div>
                <div class="cabal-card-body">${renderRichText(p.text)}</div>
            </div>`).join("") || `<div class="cabal-empty">no posts yet</div>`;
        pane.innerHTML = `
            <a class="cabal-profile-back" href="#feed">← back to feed</a>
            <div class="cabal-profile-card">
                ${pfp}
                <div class="cabal-profile-meta">
                    <div class="cabal-profile-name">${escHtml(name)}</div>
                    <div class="cabal-profile-addr">${shortAddr(wallet)} · <a href="https://etherscan.io/address/${escHtml(wallet)}" target="_blank" rel="noopener" class="cabal-link">etherscan</a></div>
                    ${xBadge}
                    <div class="cabal-profile-stats">last online ${lastSeen} · joined ${memberSince} · ${camels.length} camels</div>
                </div>
            </div>
            <div class="cabal-profile-section-h">collection · ${camels.length} camels</div>
            ${collectionGrid}
            <div class="cabal-profile-section-h">recent posts</div>
            ${postsHtml}
        `;
    } catch (e) {
        pane.innerHTML = `<a class="cabal-profile-back" href="#feed">← back</a><div class="cabal-empty">profile load failed: ${escHtml(e.message)}</div>`;
    }
}

async function fetchProfileCamels(wallet) {
    try {
        const url = `${ALCHEMY_NFT}?owner=${wallet}&contractAddresses[]=${CAMEL_MIRROR}&pageSize=100&withMetadata=true`;
        const r = await fetch(url);
        if (!r.ok) return [];
        const j = await r.json();
        return (j.ownedNfts || []).map(n => ({
            token_id: n.tokenId, name: n.name || `Camel #${n.tokenId}`,
            image: (n.image && (n.image.cachedUrl || n.image.thumbnailUrl)) || camelImageUrl(n.tokenId),
        })).sort((a,b)=>{ try{return Number(BigInt(a.token_id)-BigInt(b.token_id));}catch{return 0;} });
    } catch { return []; }
}

// ── feed ──────────────────────────────────────────────────────
async function cabalLoadFeed() {
    try {
        const r = await api("/feed");
        const items = r.items || [];
        const list = $("feed-list");
        const me = cabalState.wallet;
        list.innerHTML = items.slice().reverse().map(it => {
            const a = resolveAuthor(it.wallet, it.camel_id, it.handle);
            const liked = (it.liked_by || []).map(s => s.toLowerCase()).includes(me);
            const isMine = (it.wallet||"").toLowerCase() === me;
            return `<div class="cabal-card" data-ts="${it.ts}">
                <div class="cabal-card-meta">
                    <a class="cabal-card-author cabal-profile-link" href="#u/${escHtml(it.wallet||"")}">${authorLabel(it.wallet, a.camel_id, a.handle, it.pfp_image)}</a>
                    <span class="cabal-card-addr">${shortAddr(it.wallet)}</span>
                    <span class="cabal-card-time">${fmtTime(it.ts)}</span>
                </div>
                <div class="cabal-card-body">${renderRichText(it.text)}</div>
                <div class="cabal-card-actions">
                    <button class="cabal-like-btn ${liked?'liked':''}" data-ts="${it.ts}" data-on="${liked?'0':'1'}">${liked?'♥':'♡'} <span class="cabal-like-count">${it.likes || 0}</span></button>
                    ${isMine ? `<button class="cabal-del-btn" data-ts="${it.ts}">delete</button>` : ''}
                </div>
            </div>`;
        }).join("") || `<div class="cabal-empty">no posts yet · be the first camel</div>`;
    } catch (e) { flash("feed-flash", "feed load failed: " + e.message, "err"); }
}

async function toggleLike(ts, on) {
    try {
        const r = await api("/like", { method: "POST", body: JSON.stringify({ ts, on }) });
        const card = document.querySelector(`.cabal-card[data-ts="${ts}"]`);
        if (!card) return cabalLoadFeed();
        const btn = card.querySelector(".cabal-like-btn");
        btn.classList.toggle("liked", on);
        btn.dataset.on = on ? "0" : "1";
        btn.firstChild && (btn.firstChild.textContent = on ? "♥ " : "♡ ");
        const cnt = card.querySelector(".cabal-like-count");
        if (cnt) cnt.textContent = r.likes || 0;
    } catch (e) { flash("feed-flash", "like failed: " + e.message, "err"); }
}

async function deletePost(ts) {
    if (!confirm("Delete this post?")) return;
    try {
        await api("/feed", { method: "DELETE", body: JSON.stringify({ ts }) });
        const card = document.querySelector(`.cabal-card[data-ts="${ts}"]`);
        if (card) card.remove();
        flash("feed-flash", "deleted", "ok");
    } catch (e) { flash("feed-flash", "delete failed: " + e.message, "err"); }
}

async function cabalPostFeed() {
    const text = $("feed-text").value.trim();
    if (!text) return;
    const btn = $("feed-post"); btn.disabled = true; const orig = btn.textContent; btn.textContent = "posting…";
    try {
        await api("/feed", { method: "POST", body: JSON.stringify({ text }) });
        $("feed-text").value = "";
        flash("feed-flash", "posted", "ok");
        await cabalLoadFeed();
    } catch (e) { flash("feed-flash", "post failed: " + e.message, "err"); }
    finally { btn.disabled = false; btn.textContent = orig; }
}

// ── group ─────────────────────────────────────────────────────
async function cabalLoadGroup() {
    try {
        const r = await api("/group");
        const items = r.items || [];
        const list = $("group-list");
        const me = cabalState.wallet;
        list.innerHTML = items.map(it => {
            const mine = (it.wallet||"").toLowerCase() === me;
            const a = resolveAuthor(it.wallet, it.camel_id, it.handle);
            return `<div class="chat-msg ${mine?"mine":""}">
                <div class="chat-meta">${authorLabel(it.wallet, a.camel_id, a.handle, it.pfp_image)} · ${fmtTime(it.ts)}</div>
                <div class="chat-body">${renderRichText(it.text)}</div>
            </div>`;
        }).join("") || `<div class="cabal-empty">no chatter · the desert is quiet</div>`;
        list.scrollTop = list.scrollHeight;
    } catch (e) {}
}

async function cabalSendGroup() {
    const text = $("group-text").value.trim(); if (!text) return;
    const btn = $("group-send"); btn.disabled = true;
    try { await api("/group", { method: "POST", body: JSON.stringify({ text }) }); $("group-text").value = ""; cabalLoadGroup(); }
    catch (e) { flash("group-flash", "send failed: " + e.message, "err"); }
    finally { btn.disabled = false; }
}

// ── camels list ───────────────────────────────────────────────
async function cabalLoadCamels() {
    try {
        const r = await api("/camels");
        const items = r.items || [];
        cabalState.peersByWallet = {};
        for (const c of items) cabalState.peersByWallet[(c.wallet||"").toLowerCase()] = c;
        cabalState.peers = items.filter(c => (c.wallet||"").toLowerCase() !== cabalState.wallet);
        $("camels-list").innerHTML = items.map(c => {
            const a = resolveAuthor(c.wallet, c.camel_id, c.handle);
            return `<div class="cabal-card">
                <div class="cabal-card-meta">
                    <span class="cabal-card-author">${authorLabel(c.wallet, a.camel_id, a.handle)}</span>
                    <span class="cabal-card-addr">${shortAddr(c.wallet)}</span>
                    <span class="cabal-card-time">last seen ${fmtTime((c.last_seen||0)*1000)}</span>
                </div>
                <div class="cabal-card-body">
                    ${(c.wallet||"").toLowerCase() === cabalState.wallet ? '<em>this is you</em>' : ''}
                </div>
            </div>`;
        }).join("") || `<div class="cabal-empty">no camels yet</div>`;
        if ($("nav-camel-count")) $("nav-camel-count").textContent = items.length;
    } catch (e) {}
}

// ── DMs ───────────────────────────────────────────────────────
function cabalSelectPeer(peer) {
    cabalState.activePeer = peer;
    const a = resolveAuthor(peer);
    $("dm-peer-name").innerHTML = authorLabel(peer, a.camel_id, a.handle) + " · " + shortAddr(peer);
    $("dm-text").disabled = false; $("dm-send").disabled = false;
    document.querySelectorAll("#dm-peers li").forEach(li => li.classList.toggle("active", li.dataset.peer === peer));
    cabalLoadDM();
    cabalSwitchSub("dms");
}

async function cabalLoadDM() {
    if (!cabalState.activePeer) return;
    try {
        const r = await api(`/dm/${cabalState.activePeer}`);
        const items = r.items || [];
        const me = cabalState.wallet;
        $("dm-list").innerHTML = items.map(it => {
            const mine = (it.from||"").toLowerCase() === me;
            const a = resolveAuthor(it.from, it.from_camel_id, it.from_handle);
            return `<div class="chat-msg ${mine?"mine":""}">
                <div class="chat-meta">${mine?"you":authorLabel(it.from, a.camel_id, a.handle, it.from_pfp_image)} · ${fmtTime(it.ts)}</div>
                <div class="chat-body">${escHtml(it.text)}</div>
            </div>`;
        }).join("") || `<div class="cabal-empty">no messages yet</div>`;
        $("dm-list").scrollTop = $("dm-list").scrollHeight;
    } catch (e) {}
}

async function cabalSendDM() {
    const text = $("dm-text").value.trim(); if (!text || !cabalState.activePeer) return;
    const btn = $("dm-send"); btn.disabled = true;
    try { await api(`/dm/${cabalState.activePeer}`, { method: "POST", body: JSON.stringify({ text }) }); $("dm-text").value = ""; cabalLoadDM(); }
    catch (e) { flash("dm-flash", "send failed: " + e.message, "err"); }
    finally { btn.disabled = false; }
}

// ── canvas / drawing board ────────────────────────────────────
async function cabalLoadCanvas(incremental) {
    try {
        const since = incremental ? cabalState.canvas.lastSync : 0;
        const r = await api(since ? `/canvas?since=${since}` : `/canvas`);
        if (r.palette && r.palette.length) {
            cabalState.canvas.palette = r.palette;
            cabalState.canvas.w = r.w; cabalState.canvas.h = r.h;
            cabalState.canvas.cooldown_ms = r.cooldown_ms || cabalState.canvas.cooldown_ms;
        }
        cabalState.canvas.lastSync = r.now_ms || Date.now();
        ensureCanvas();
        renderPalette();
        applyPixels(r.pixels || [], !incremental);
    } catch (e) { flash("board-flash", "board load failed: " + e.message, "err"); }
}

function ensureCanvas() {
    if (cabalState.canvas.pixelCanvas) return;
    const c = $("camel-canvas");
    if (!c) return;
    c.width = cabalState.canvas.w;
    c.height = cabalState.canvas.h;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#050a05";
    ctx.fillRect(0,0,c.width,c.height);
    cabalState.canvas.pixelCanvas = c; cabalState.canvas.pixelCtx = ctx;

    const place = (ev) => {
        const rect = c.getBoundingClientRect();
        const t = (ev.touches && ev.touches[0]) || ev;
        const x = Math.floor(((t.clientX - rect.left) / rect.width)  * c.width);
        const y = Math.floor(((t.clientY - rect.top)  / rect.height) * c.height);
        if (x < 0 || x >= c.width || y < 0 || y >= c.height) return;
        placePixel(x, y);
    };
    c.addEventListener("click", place);
}
function applyPixels(pixels, clearFirst) {
    const ctx = cabalState.canvas.pixelCtx; if (!ctx) return;
    if (clearFirst) {
        ctx.fillStyle = "#050a05";
        ctx.fillRect(0,0,cabalState.canvas.w,cabalState.canvas.h);
    }
    for (const p of pixels) {
        const [x, y, color] = p;
        ctx.fillStyle = cabalState.canvas.palette[color] || "#fff";
        ctx.fillRect(x, y, 1, 1);
    }
}
function renderPalette() {
    const el = $("canvas-palette"); if (!el) return;
    if (el.dataset.rendered === String(cabalState.canvas.palette.length)) return;
    el.innerHTML = cabalState.canvas.palette.map((c, i) =>
        `<button class="pal-swatch ${i===cabalState.canvas.color?'active':''}" data-color="${i}" style="background:${c}"></button>`
    ).join("");
    el.dataset.rendered = String(cabalState.canvas.palette.length);
}
async function placePixel(x, y) {
    const remain = cabalState.canvas.cooldown_ms - (Date.now() - cabalState.canvas.lastPlace);
    if (remain > 0) { flash("board-flash", `cooldown · ${(remain/1000).toFixed(1)}s`, "err"); return; }
    try {
        const r = await api("/canvas", { method: "POST", body: JSON.stringify({ x, y, color: cabalState.canvas.color }) });
        cabalState.canvas.lastPlace = Date.now();
        applyPixels([[r.x, r.y, r.color, r.ts]], false);
    } catch (e) {
        if (e.status === 429) {
            const wait = (e.body && e.body.wait_ms) || cabalState.canvas.cooldown_ms;
            cabalState.canvas.lastPlace = Date.now() - (cabalState.canvas.cooldown_ms - wait);
            flash("board-flash", `cooldown · ${(wait/1000).toFixed(1)}s`, "err");
        } else flash("board-flash", "place failed: " + e.message, "err");
    }
}
function updateCanvasCooldown() {
    const el = $("board-cooldown"); if (!el) return;
    const remain = cabalState.canvas.cooldown_ms - (Date.now() - cabalState.canvas.lastPlace);
    if (remain > 0) { el.textContent = `cooldown ${(remain/1000).toFixed(1)}s`; el.className = "cabal-flash err"; }
    else { el.textContent = "ready · place a pixel"; el.className = "cabal-flash ok"; }
}

// ── boot ──────────────────────────────────────────────────────
function handleXReturn() {
    const p = new URLSearchParams(location.search);
    if (p.get("x_connected") === "1") {
        history.replaceState(null, "", location.pathname + location.hash);
        // cabalEnter (called after) will fetch /me and re-render. Just queue the flash
        // for after that completes so the user sees the new @handle in the message.
        setTimeout(() => {
            const x = cabalState.me && cabalState.me.x_handle;
            console.log("[cabal] x return; me =", cabalState.me);
            flash("cabal-handle-flash", x ? `connected as @${x}` : "X connected", "ok");
        }, 1200);
    } else if (p.get("x_error")) {
        flash("cabal-handle-flash", "x failed: " + p.get("x_error"), "err");
        history.replaceState(null, "", location.pathname + location.hash);
    }
}

function cabalInit() {
    if (!$("cabal-connect")) return;  // not on a cabal page
    console.log("[cabal] init v=15");
    handleXReturn();
    $("cabal-connect").addEventListener("click", cabalLogin);
    $("cabal-handle-save").addEventListener("click", cabalSaveHandle);
    $("feed-post").addEventListener("click", cabalPostFeed);
    $("group-send").addEventListener("click", cabalSendGroup);
    $("group-text").addEventListener("keydown", e => { if (e.key === "Enter") cabalSendGroup(); });
    bindImageUpload("feed-image",  $("feed-text"),  $("feed-flash"));
    bindImageUpload("group-image", $("group-text"), $("group-flash"));
    document.addEventListener("click", e => {
        const pfpBtn = e.target.closest("#pfp-change, .cabal-me-avatar");
        if (pfpBtn) { e.preventDefault(); openPfpPicker(); return; }
        const xBtn = e.target.closest("#connect-x");
        if (xBtn) { e.preventDefault(); startXConnect("link_only"); return; }
        const likeBtn = e.target.closest(".cabal-like-btn");
        if (likeBtn) { e.preventDefault(); toggleLike(parseInt(likeBtn.dataset.ts,10), likeBtn.dataset.on === "1"); return; }
        const delBtn = e.target.closest(".cabal-del-btn");
        if (delBtn) { e.preventDefault(); deletePost(parseInt(delBtn.dataset.ts,10)); return; }
        const profLink = e.target.closest(".cabal-profile-link");
        if (profLink) { /* hash router takes it */ return; }
        const logout = e.target.closest("#cabal-logout");
        if (logout) { e.preventDefault(); cabalLogout(); return; }
        const sub = e.target.closest(".cabal-sub");
        if (sub && sub.dataset.sub) { e.preventDefault(); cabalSwitchSub(sub.dataset.sub); return; }
        const link = e.target.closest(".cabal-dm-link");
        if (link) { e.preventDefault(); cabalSelectPeer(link.dataset.peer); return; }
        const peerLi = e.target.closest("#dm-peers li[data-peer]");
        if (peerLi) cabalSelectPeer(peerLi.dataset.peer);
        const swatch = e.target.closest(".pal-swatch");
        if (swatch) {
            cabalState.canvas.color = parseInt(swatch.dataset.color, 10);
            document.querySelectorAll(".pal-swatch").forEach(s => s.classList.toggle("active", s === swatch));
        }
    });
    if (cabalState.token && cabalState.wallet) cabalEnter();
}

document.addEventListener("DOMContentLoaded", cabalInit);
