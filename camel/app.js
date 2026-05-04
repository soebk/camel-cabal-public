const CONTRACT_ADDRESS = "0x000Caba1002917B27300d7b67Be2d1C51B93bF00";
const MIRROR_ADDRESS = "0x9f2F3E04c67AD0854A6b225d5FDdBaE513dF0fCC";
const RPC_URL  = "wss://ethereum-rpc.publicnode.com";
const RPC_HTTP = "https://ethereum-rpc.publicnode.com";
const EXPLORER_URL = "https://etherscan.io";

// Standard ABI for ERC721 and DN404 Base
const ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function mirrorERC721() view returns (address)"
];

let provider;
let contract;
let mirrorContract;
let totalMints = 0;
let totalBurns = 0;
let scarcityChart = null;   // Pie chart instance
let activityChart = null;   // Bar chart instance
const MAX_THEORETICAL_NFTS = 2222; // 2.222B total supply / 1M per NFT
const DEPLOY_BLOCK = 24986373; // Block the Mirror contract was deployed at

// Scarcity Score State
let lastMintCount = 0;
let lastOsFloor = 0;
let lastImpliedFloor = 0;

const statusDot = document.getElementById('connection-status');
const statusText = document.getElementById('status-text');
const totalMintsEl = document.getElementById('total-mints');
const totalBurnsEl = document.getElementById('total-burns');
const latestBlockEl = document.getElementById('latest-block');
const mintsBody = document.getElementById('mints-body');
const emptyState = document.getElementById('empty-state');
const currentSupplyEl = document.getElementById('current-supply');
const unmintableNftsEl = document.getElementById('unmintable-nfts');

// Tab elements
const ROUTES = {
    '#/tracker': { tab: 'tab-mints',  view: 'view-mints'  },
    '#/chart':   { tab: 'tab-chart',  view: 'view-chart'  },
    '#/stats':   { tab: 'tab-stats',  view: 'view-stats'  },
    '#/swap':    { tab: 'tab-swap',   view: 'view-swap'   },
    '#/donate':  { tab: 'tab-donate', view: 'view-donate' },
    '#/cabal':   { tab: 'tab-cabal',  view: 'view-cabal'  },
    '#/links':   { tab: 'tab-links',  view: 'view-links'  },
};

function applyRoute() {
    const hash = ROUTES[location.hash] ? location.hash : '#/tracker';
    Object.values(ROUTES).forEach(r => {
        const tab = document.getElementById(r.tab);
        const view = document.getElementById(r.view);
        if (tab) tab.classList.remove('active-tab');
        if (view) view.style.display = 'none';
    });
    const r = ROUTES[hash];
    document.getElementById(r.tab).classList.add('active-tab');
    document.getElementById(r.view).style.display = 'block';
}

function setupTabs() {
    window.addEventListener('hashchange', applyRoute);
    applyRoute();
    initSwap();
}

// ── DONATE MODULE ────────────────────────────────────────────
const DEV_WALLET   = '0xf62290b1e405f03628a4b6ba025ad5b655cce8a2';
const CAMEL_TOKEN  = '0x000Caba1002917B27300d7b67Be2d1C51B93bF00';
const CABAL_API    = 'https://<your-api-domain>/cabal';

// ── CYPHER AMM V4 (Algebra Integral v1.2) — canon CAMEL/WETH pool ─
const WETH         = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CYPHER_QUOTER = '0x02f22D58d161d1C291ABfe88764d84120f20F723';
const CYPHER_ROUTER = '0x20C5893f69F635f55b0367C519F3f95e59c0b0Ab';
// Deployer for the canon CAMEL/WETH pool — derived from on-chain swap calldata.
const CYPHER_POOL_DEPLOYER = '0xb9783d9bd7022b1fca458518dc0e10646720acf0';
const CYPHER_SLIPPAGE_BPS = 300; // 3%
const CYPHER_QUOTER_ABI = [
    'function quoteExactInputSingle(address tokenIn, address tokenOut, address deployer, uint256 amountIn, uint160 limitSqrtPrice) returns (uint256 amountOut, uint16 fee)',
];
const CYPHER_ROUTER_ABI = [
    'function exactInputSingle(tuple(address tokenIn,address tokenOut,address deployer,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 limitSqrtPrice)) external payable returns (uint256)',
    'function refundNativeToken() external payable',
    'function multicall(bytes[] data) external payable returns (bytes[] memory)',
];

let swapProvider = null;
let swapSigner = null;
let swapAccount = null;
let lastCypherQuote = null;

function setSwapStatus(msg, kind) {
    const el = document.getElementById('donate-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'swap-status' + (kind ? ' ' + kind : '');
}

let _donateWalletSvc = null;
async function _donateMicroWeb3() {
    if (!window.microWeb3 || !window.microact) return null;
    try {
        if (!_donateWalletSvc) {
            const eb = new microact.EventBus();
            _donateWalletSvc = new microWeb3.WalletService(eb);
            await _donateWalletSvc.initialize();
        }
        const available = _donateWalletSvc.getAvailableWallets() || [];
        if (!available.length) return null;
        const mm = available.find(w => (w.type || w.legacyType || '').toLowerCase() === 'metamask');
        const pick = mm || available[0];
        const type = pick.type || pick.legacyType;
        await _donateWalletSvc.connect(type);
        const ps = _donateWalletSvc.getProviderAndSigner();
        return { provider: ps.provider, signer: ps.signer, address: _donateWalletSvc.getAddress() };
    } catch (e) { console.warn('[donate] microWeb3 fallback:', e); return null; }
}

async function connectWallet() {
    if (!window.ethereum && !window.microWeb3) { setSwapStatus('No wallet detected. Install MetaMask.', 'err'); return; }
    try {
        const mw = await _donateMicroWeb3();
        if (mw) {
            swapProvider = mw.provider; swapSigner = mw.signer; swapAccount = mw.address;
        } else {
            swapProvider = new ethers.providers.Web3Provider(window.ethereum, 'any');
            await swapProvider.send('eth_requestAccounts', []);
            swapSigner = swapProvider.getSigner();
            swapAccount = await swapSigner.getAddress();
        }
        const network = await swapProvider.getNetwork();
        if (network.chainId !== 1) {
            try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }); }
            catch { setSwapStatus('Switch to Ethereum mainnet to swap.', 'err'); return; }
            swapProvider = new ethers.providers.Web3Provider(window.ethereum, 'any');
            swapSigner = swapProvider.getSigner();
            swapAccount = await swapSigner.getAddress();
        }
        document.getElementById('donate-connect').textContent = swapAccount.slice(0,6) + '…' + swapAccount.slice(-4);
        document.getElementById('donate-send').disabled = false;
        setSwapStatus('Connected. Set an amount + note, then send.', 'ok');
    } catch (e) { setSwapStatus('Connection rejected: ' + (e.message || e), 'err'); }
}

async function sendDonation() {
    if (!swapSigner) { setSwapStatus('Connect wallet first.', 'err'); return; }
    const ethAmt = parseFloat(document.getElementById('donate-amount').value);
    if (!(ethAmt > 0)) { setSwapStatus('Set an ETH amount first.', 'err'); return; }
    const note = document.getElementById('donate-note').value.trim().slice(0, 500);
    const btn = document.getElementById('donate-send'); btn.disabled = true; const orig = btn.textContent; btn.textContent = 'sending…';
    try {
        const value = ethers.utils.parseEther(ethAmt.toString());
        setSwapStatus(`Confirm ${ethAmt} ETH → dev wallet in your wallet…`);
        const tx = await swapSigner.sendTransaction({ to: DEV_WALLET, value });
        setSwapStatus(`Tx ${tx.hash.slice(0,10)}… mining (1 confirmation).`);
        await tx.wait(1);
        setSwapStatus('Confirmed. Recording note on the wall…');
        const r = await fetch(CABAL_API + '/donate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tx_hash: tx.hash, note })
        });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            setSwapStatus('Tx mined but wall write failed: ' + (j.error || r.status) + ' — your donation is still on-chain.', 'err');
        } else {
            setSwapStatus(`✓ ${ethAmt} ETH donated. Note recorded. Thanks for keeping the lights on.`, 'ok');
            document.getElementById('donate-note').value = '';
            loadDonorWall();
        }
    } catch (e) {
        setSwapStatus('Donation failed: ' + (e.reason || e.message || e), 'err');
    } finally { btn.disabled = false; btn.textContent = orig; }
}

function openCypher() {
    const ethAmt = parseFloat(document.getElementById('swap-eth-amount').value || '0');
    let url = `https://app.cyphereth.com/swap?inputCurrency=ETH&outputCurrency=${CAMEL_TOKEN}`;
    if (ethAmt > 0) url += `&exactAmount=${ethAmt}&exactField=input`;
    window.open(url, '_blank', 'noopener');
}

function setSwapPanel(msg, kind) {
    const el = document.getElementById('swap-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'swap-status' + (kind ? ' ' + kind : '');
}

async function getCypherQuote() {
    const ethStr = document.getElementById('swap-eth-amount').value;
    const ethAmt = parseFloat(ethStr);
    if (!(ethAmt > 0)) { setSwapPanel('Enter an ETH amount.', 'err'); return null; }
    const reader = swapProvider || new ethers.providers.JsonRpcProvider(RPC_HTTP);
    const quoter = new ethers.Contract(CYPHER_QUOTER, CYPHER_QUOTER_ABI, reader);
    const amountIn = ethers.utils.parseEther(ethStr);
    try {
        const out = await quoter.callStatic.quoteExactInputSingle(WETH, CAMEL_TOKEN, CYPHER_POOL_DEPLOYER, amountIn, 0);
        const amountOut = out.amountOut || out[0];
        const fee = (out.fee || out[1]).toString();
        const camel = +ethers.utils.formatUnits(amountOut, 18);
        document.getElementById('swap-out').value = camel.toLocaleString(undefined, { maximumFractionDigits: 4 });
        const nfts = camel / 1_000_000;
        setSwapPanel(`Quote: ${camel.toLocaleString(undefined,{maximumFractionDigits:2})} CAMEL (~${nfts.toFixed(3)} NFTs) · pool fee ${(parseInt(fee,10)/10000).toFixed(2)}% · slippage ${CYPHER_SLIPPAGE_BPS/100}%`, 'ok');
        lastCypherQuote = { amountIn, amountOut, fee };
        return lastCypherQuote;
    } catch (e) {
        setSwapPanel('Quote failed: ' + (e.reason || e.message || e), 'err');
        return null;
    }
}

async function executeCypherSwap() {
    if (!swapSigner) { setSwapPanel('Connect wallet first.', 'err'); return; }
    let q = lastCypherQuote;
    const ethStr = document.getElementById('swap-eth-amount').value;
    const ethAmt = parseFloat(ethStr);
    if (!(ethAmt > 0)) { setSwapPanel('Enter an ETH amount.', 'err'); return; }
    if (!q || !q.amountIn.eq(ethers.utils.parseEther(ethStr))) {
        q = await getCypherQuote();
        if (!q) return;
    }
    const btn = document.getElementById('swap-execute');
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'swapping…';
    try {
        const router = new ethers.Contract(CYPHER_ROUTER, CYPHER_ROUTER_ABI, swapSigner);
        const minOut = q.amountOut.mul(10000 - CYPHER_SLIPPAGE_BPS).div(10000);
        const params = {
            tokenIn: WETH,
            tokenOut: CAMEL_TOKEN,
            deployer: CYPHER_POOL_DEPLOYER,
            recipient: swapAccount,
            deadline: Math.floor(Date.now()/1000) + 600,
            amountIn: q.amountIn,
            amountOutMinimum: minOut,
            limitSqrtPrice: 0,
        };
        const swapData   = router.interface.encodeFunctionData('exactInputSingle', [params]);
        const refundData = router.interface.encodeFunctionData('refundNativeToken');
        setSwapPanel('Confirm in your wallet…');
        const tx = await router.multicall([swapData, refundData], { value: q.amountIn });
        setSwapPanel('Swap tx ' + tx.hash.slice(0,10) + '… mining (1 confirmation).');
        await tx.wait(1);
        setSwapPanel('✓ Swap complete. Welcome to the cabal.', 'ok');
        document.getElementById('swap-out').value = '';
        lastCypherQuote = null;
    } catch (e) {
        setSwapPanel('Swap failed: ' + (e.reason || e.message || e), 'err');
    } finally { btn.disabled = false; btn.textContent = orig; }
}

function escDonateHtml(s) { return (s||'').replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function fmtAgo(ms) {
    const d = (Date.now() - ms) / 1000;
    if (d < 60) return Math.max(0,Math.floor(d)) + 's ago';
    if (d < 3600) return Math.floor(d/60) + 'm ago';
    if (d < 86400) return Math.floor(d/3600) + 'h ago';
    return new Date(ms).toLocaleDateString();
}

async function loadDonorWall() {
    const el = document.getElementById('donate-wall');
    if (!el) return;
    try {
        const r = await fetch(CABAL_API + '/donate');
        const j = await r.json();
        const items = j.items || [];
        if (!items.length) { el.innerHTML = '<div class="cabal-empty">no donations yet · be the first patron</div>'; return; }
        el.innerHTML = items.map(it => {
            const wei = BigInt(it.amount_wei || '0');
            const eth = (Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, '');
            const wallet = (it.wallet||'').toLowerCase();
            const short = wallet ? wallet.slice(0,6) + '…' + wallet.slice(-4) : '?';
            return `<div class="cabal-card">
                <div class="cabal-card-meta">
                    <span class="cabal-card-author">${eth} ETH</span>
                    <span class="cabal-card-addr"><a href="https://etherscan.io/tx/${it.tx_hash}" target="_blank" rel="noopener" style="color:#6fa86f">${short}</a></span>
                    <span class="cabal-card-time">${fmtAgo(it.ts)}</span>
                </div>
                ${it.note ? `<div class="cabal-card-body">${escDonateHtml(it.note)}</div>` : ''}
            </div>`;
        }).join('');
    } catch (e) { el.innerHTML = '<div class="cabal-empty">wall load failed</div>'; }
}

function initSwap() {
    document.getElementById('donate-connect').addEventListener('click', connectWallet);
    document.getElementById('donate-send').addEventListener('click', sendDonation);
    if (document.getElementById('swap-quote'))   document.getElementById('swap-quote').addEventListener('click', getCypherQuote);
    if (document.getElementById('swap-execute')) document.getElementById('swap-execute').addEventListener('click', executeCypherSwap);
    if (document.getElementById('swap-cypher-link')) document.getElementById('swap-cypher-link').addEventListener('click', openCypher);
    loadDonorWall();
    setInterval(loadDonorWall, 60000);
    if (window.ethereum && window.ethereum.selectedAddress) connectWallet();
}

function updateChart(current, mintable, unmintable) {
    Chart.register(ChartDataLabels);
    if (!scarcityChart) {
        const ctx = document.getElementById('scarcityChart').getContext('2d');
        scarcityChart = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: ['Minted NFTs', 'Mintable (LP & CEX)', 'Fractional Dust'],
                datasets: [{
                    data: [current, mintable, unmintable],
                    backgroundColor: ['#007a33', '#f0ad4e', '#d9534f'],
                    borderColor: ['#fff', '#fff', '#fff'],
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom' },
                    title: { display: true, text: 'Total Theoretical NFT Supply Distribution' },
                    datalabels: {
                        formatter: (value, context) => {
                            if (value < 1) return null;
                            const sum = context.chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
                            const percentage = (value * 100 / sum).toFixed(1) + "%";
                            const nftCount = Math.floor(value).toLocaleString() + " NFTs";
                            return percentage + "\n" + nftCount;
                        },
                        color: '#fff',
                        font: { weight: 'bold', size: 13 },
                        textShadowBlur: 4,
                        textShadowColor: '#000',
                        textAlign: 'center'
                    }
                }
            }
        });
    } else {
        scarcityChart.data.datasets[0].data = [current, mintable, unmintable];
        scarcityChart.update();
    }
}

function renderActivityChart(events) {
    const DEPLOY_TIMESTAMP = 1746316800;
    const mintsByDay = {};
    const burnsByDay = {};

    for (const event of events) {
        const secondsSinceDeploy = (event.blockNumber - DEPLOY_BLOCK) * 12;
        const date = new Date((DEPLOY_TIMESTAMP + secondsSinceDeploy) * 1000);
        const dayKey = date.toISOString().slice(0, 10);
        if (event.eventType === 'Mint') mintsByDay[dayKey] = (mintsByDay[dayKey] || 0) + 1;
        else burnsByDay[dayKey] = (burnsByDay[dayKey] || 0) + 1;
    }

    const allDays = [...new Set([...Object.keys(mintsByDay), ...Object.keys(burnsByDay)])].sort();
    const mintData = allDays.map(d => mintsByDay[d] || 0);
    const burnData = allDays.map(d => burnsByDay[d] || 0);
    const labels = allDays.map(d => {
        const [y, m, day] = d.split('-');
        return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    const ctx = document.getElementById('activityChart').getContext('2d');
    if (activityChart) {
        activityChart.data.labels = labels;
        activityChart.data.datasets[0].data = mintData;
        activityChart.data.datasets[1].data = burnData;
        activityChart.update();
        return;
    }
    activityChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Mints', data: mintData, backgroundColor: 'rgba(0, 122, 51, 0.8)', borderColor: '#007a33', borderWidth: 1 },
                { label: 'Burns', data: burnData, backgroundColor: 'rgba(217, 83, 79, 0.75)', borderColor: '#d9534f', borderWidth: 1 }
            ]
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'top' }, datalabels: { display: false } },
            scales: {
                x: { ticks: { maxRotation: 45, minRotation: 30, font: { size: 11 } }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 }, title: { display: true, text: 'NFT Count' } }
            }
        }
    });
}

function updateStatus(status) {
    statusDot.className = `status-dot ${status}`;
    if (status === 'connected') statusText.textContent = "Connected to Ethereum (WSS)";
    else if (status === 'connecting') statusText.textContent = "Connecting to RPC...";
    else statusText.textContent = "Connection Error";
}

function formatAddress(address) {
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

function addEventRow(type, tokenId, walletAddress, txHash) {
    if (emptyState.style.display !== 'none') emptyState.style.display = 'none';
    const row = document.createElement('tr');
    const timeStr = new Date().toLocaleTimeString();
    const typeClass = type === 'Mint' ? 'type-mint' : 'type-burn';
    row.innerHTML = `
        <td class="${typeClass}">${type}</td>
        <td>#${tokenId.toString()}</td>
        <td><a href="${EXPLORER_URL}/address/${walletAddress}" target="_blank" class="link">${formatAddress(walletAddress)}</a></td>
        <td><a href="${EXPLORER_URL}/tx/${txHash}" target="_blank" class="link">${formatAddress(txHash)}</a></td>
        <td>${timeStr}</td>
    `;
    mintsBody.insertBefore(row, mintsBody.firstChild);
    if (mintsBody.children.length > 50) mintsBody.removeChild(mintsBody.lastChild);
}

function showNotification(type, tokenId, address) {
    const container = document.getElementById('notification-container');
    const notification = document.createElement('div');
    notification.className = `notification ${type.toLowerCase()}`;
    
    const title = type === 'Mint' ? 'NEW NFT MINTED' : 'NFT BURNED';
    const addr = formatAddress(address);
    
    notification.innerHTML = `
        <div class="notification-header">
            <span>[${title}]</span>
            <span class="notification-id">ID: #${tokenId}</span>
        </div>
        <div class="notification-body">
            Wallet: ${addr}
        </div>
    `;
    
    container.appendChild(notification);
    
    // Remove after 5 seconds
    setTimeout(() => {
        notification.classList.add('fade-out');
        setTimeout(() => notification.remove(), 500);
    }, 5000);
}

async function initMirrorContract() {
    if (mirrorContract) return;
    try {
        mirrorContract = new ethers.Contract(MIRROR_ADDRESS, [
            "function totalSupply() view returns (uint256)",
            "function balanceOf(address owner) view returns (uint256)",
            "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
        ], provider);
    } catch (e) { console.error("Mirror error", e); }
}

async function updateScarcity() {
    try {
        let currentNftSupply = 0, mintable = 0, unmintable = 0;
        await initMirrorContract();
        if (mirrorContract) {
            const supplyBN = await mirrorContract.totalSupply();
            currentNftSupply = parseInt(supplyBN.toString());
        } else return;
        
        try {
            const MINTABLE_WALLETS = ["0x000000000004444c5dc75cB358380D2e3dE08A90","0x1b337491fb312c3500e1feef56d50bcacee6c7e3","0x23c6f2d70a8af03ba27413fc95c38e89ce6ce89a","0x709cec1b2b9cf5f3229edb515669392a75057d3d","0xd67dee6ab69744b22137d7cd90c504534ff24a5f","0xf62290b1e405f03628a4b6ba025ad5b655cce8a2","0x36c0e9c58c52e261c071dbb8a6ab497990775973"];
            for (const addr of MINTABLE_WALLETS) {
                const erc20BN = await contract.balanceOf(addr);
                const erc20Bal = parseFloat(ethers.utils.formatUnits(erc20BN, 18));
                let nftBal = 0;
                if (mirrorContract) {
                    const nftBN = await mirrorContract.balanceOf(addr);
                    nftBal = parseInt(nftBN.toString());
                }
                mintable += (Math.max(0, erc20Bal - (nftBal * 1000000)) / 1000000);
            }
        } catch (e) { console.warn("Balances error", e); }
        unmintable = Math.max(0, MAX_THEORETICAL_NFTS - currentNftSupply - mintable);
        currentSupplyEl.textContent = currentNftSupply.toLocaleString();
        unmintableNftsEl.textContent = Math.floor(unmintable).toLocaleString();
        updateChart(currentNftSupply, Math.floor(mintable), unmintable);
        lastMintCount = currentNftSupply;
        updateScarcityScore();
    } catch (error) { console.error("Scarcity error", error); }
}

async function init() {
    try {
        setupTabs();
        updateStatus('connecting');
        provider = new ethers.providers.WebSocketProvider(RPC_URL);
        provider.on("error", (tx) => { console.error("Provider Error:", tx); updateStatus('error'); });
        provider.on("block", (blockNumber) => { latestBlockEl.textContent = blockNumber.toString(); });
        contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
        await updateScarcity();

        let allEvents = [];
        let startBlock = DEPLOY_BLOCK;
        const cachedData = localStorage.getItem('camel_events_cache');
        if (cachedData) {
            try {
                const cache = JSON.parse(cachedData);
                allEvents = cache.events;
                startBlock = cache.lastBlock + 1;
                totalMints = allEvents.filter(e => e.eventType === 'Mint').length;
                totalBurns = allEvents.filter(e => e.eventType === 'Burn').length;
                totalMintsEl.textContent = totalMints.toLocaleString();
                totalBurnsEl.textContent = totalBurns.toLocaleString();
                for (const e of allEvents.slice(-50)) addEventRow(e.eventType, e.tokenId, e.address, e.transactionHash);
                renderActivityChart(allEvents);
            } catch (e) { localStorage.removeItem('camel_events_cache'); }
        }

        totalMintsEl.textContent = totalMints > 0 ? totalMints.toLocaleString() : '...';
        totalBurnsEl.textContent = totalBurns > 0 ? totalBurns.toLocaleString() : '...';
        const loadingRow = document.createElement('tr');
        loadingRow.id = "loading-row";
        loadingRow.innerHTML = `<td colspan="5" style="text-align:center; padding: 20px; color: #888; font-style: italic;">⏳ Syncing from block ${startBlock.toLocaleString()}...</td>`;
        mintsBody.appendChild(loadingRow);

        try {
            if (mirrorContract) {
                const currentBlock = await provider.getBlockNumber();
                if (startBlock <= currentBlock) {
                    const CHUNK_SIZE = 5000;
                    for (let s = startBlock; s <= currentBlock; s += CHUNK_SIZE * 3) {
                        const batch = [];
                        for (let k = 0; k < 3; k++) {
                            const bStart = s + (k * CHUNK_SIZE);
                            if (bStart > currentBlock) break;
                            batch.push([bStart, Math.min(bStart + CHUNK_SIZE - 1, currentBlock)]);
                        }
                        await Promise.all(batch.map(async ([start, end]) => {
                            const [m, b] = await Promise.all([
                                mirrorContract.queryFilter(mirrorContract.filters.Transfer(ethers.constants.AddressZero, null, null), start, end),
                                mirrorContract.queryFilter(mirrorContract.filters.Transfer(null, ethers.constants.AddressZero, null), start, end)
                            ]);
                            for (let e of m) allEvents.push({ eventType: 'Mint', blockNumber: e.blockNumber, tokenId: e.args.tokenId.toString(), address: e.args.to, transactionHash: e.transactionHash });
                            for (let e of b) allEvents.push({ eventType: 'Burn', blockNumber: e.blockNumber, tokenId: e.args.tokenId.toString(), address: e.args.from, transactionHash: e.transactionHash });
                        }));
                    }
                    allEvents.sort((a, b) => a.blockNumber - b.blockNumber);
                    localStorage.setItem('camel_events_cache', JSON.stringify({ events: allEvents, lastBlock: currentBlock }));
                }
                document.getElementById('loading-row')?.remove();
                mintsBody.innerHTML = '';
                totalMints = 0; totalBurns = 0;
                for (const e of allEvents) if (e.eventType === 'Mint') totalMints++; else totalBurns++;
                for (const e of allEvents.slice(-50).reverse()) addEventRow(e.eventType, e.tokenId, e.address, e.transactionHash);
                totalMintsEl.textContent = totalMints.toLocaleString();
                totalBurnsEl.textContent = totalBurns.toLocaleString();
                renderActivityChart(allEvents);
            }
        } catch (e) { console.warn("Fetch error", e); }

        if (mirrorContract) {
            mirrorContract.on(mirrorContract.filters.Transfer(ethers.constants.AddressZero, null, null), (f, t, id, ev) => {
                totalMints++; totalMintsEl.textContent = totalMints.toLocaleString();
                addEventRow('Mint', id, t, ev.transactionHash);
                showNotification('Mint', id, t);
                updateScarcity();
            });
            mirrorContract.on(mirrorContract.filters.Transfer(null, ethers.constants.AddressZero, null), (f, t, id, ev) => {
                totalBurns++; totalBurnsEl.textContent = totalBurns.toLocaleString();
                addEventRow('Burn', id, f, ev.transactionHash);
                showNotification('Burn', id, f);
                updateScarcity();
            });
        }
        updateStatus('connected');
        fetchMarketData();
        setInterval(fetchMarketData, 30000);
    } catch (error) { updateStatus('error'); }
}

async function fetchMarketData() {
    let ethPriceUsd = 0, impliedFloorEth = 0;
    try {
        const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/0x000Caba1002917B27300d7b67Be2d1C51B93bF00");
        const data = await res.json();
        if (data.pairs?.[0]) {
            const p = data.pairs[0], pUsd = parseFloat(p.priceUsd), nP = parseFloat(p.priceNative || 0);
            if (nP > 0) ethPriceUsd = pUsd / nP;
            impliedFloorEth = nP * 1000000;
            document.getElementById('token-price').textContent = '$' + pUsd.toFixed(6);
            document.getElementById('implied-nft-price').textContent = '$' + (pUsd * 1000000).toLocaleString(undefined, {minimumFractionDigits: 2});
            document.getElementById('market-cap').textContent = '$' + (p.marketCap ? p.marketCap.toLocaleString() : '---');
            document.getElementById('vol-24h').textContent = '$' + (p.volume.h24 ? p.volume.h24.toLocaleString() : '---');
            document.getElementById('implied-floor-eth').textContent = impliedFloorEth.toFixed(4) + ' ETH';
            document.getElementById('implied-floor-usd').textContent = '$' + (pUsd * 1000000).toLocaleString(undefined, {minimumFractionDigits: 2});
        }
    } catch (e) {}

    try {
        const url = "https://api.opensea.io/api/v2/collections/camelcabal/stats";
        let osData = null;
        try {
            const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
            if (r.ok) osData = await r.json();
        } catch (e) {}
        if (!osData) {
            try {
                const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`);
                const j = await r.json();
                if (j.contents) osData = JSON.parse(j.contents);
            } catch (e) {}
        }
        if (osData?.total?.floor_price != null) {
            const f = osData.total.floor_price;
            lastOsFloor = f; lastImpliedFloor = impliedFloorEth;
            updateScarcityScore();
            document.getElementById('os-floor-eth').textContent = f.toFixed(4) + ' ETH';
            document.getElementById('os-floor-usd').textContent = ethPriceUsd > 0 ? '$' + (f * ethPriceUsd).toLocaleString(undefined, {minimumFractionDigits: 2}) : '---';
            const sig = document.getElementById('floor-signal-val'), desc = document.getElementById('floor-signal-desc');
            if (impliedFloorEth > 0) {
                const sp = ((f - impliedFloorEth) / impliedFloorEth) * 100;
                if (sp > 3) { sig.textContent = `+${sp.toFixed(1)}% Premium`; sig.className = 'floor-val signal-premium'; desc.textContent = 'NFT > Token'; }
                else if (sp < -3) { sig.textContent = `${sp.toFixed(1)}% Discount`; sig.className = 'floor-val signal-discount'; desc.textContent = 'Buy tokens'; }
                else { sig.textContent = `~${sp.toFixed(1)}% Fair`; sig.className = 'floor-val signal-neutral'; desc.textContent = 'NFT ≈ Token'; }
            }
        } else throw new Error();
    } catch (e) {
        document.getElementById('os-floor-eth').textContent = 'API Lag';
        document.getElementById('os-floor-usd').textContent = 'Retrying...';
    }
}

function updateScarcityScore() {
    if (lastMintCount === 0) return;
    const abs = (lastMintCount / MAX_THEORETICAL_NFTS) * 75;
    let prem = 0;
    if (lastOsFloor > 0 && lastImpliedFloor > 0) prem = Math.max(0, Math.min(25, ((lastOsFloor - lastImpliedFloor) / lastImpliedFloor) * 100));
    const score = Math.min(100, Math.round(abs + prem));
    document.getElementById('scarcity-score-val').textContent = score;
    document.getElementById('score-fill').style.width = score + '%';
    const tag = document.getElementById('score-status');
    if (score < 35) { tag.textContent = 'ABUNDANT'; tag.style.backgroundColor = '#888'; }
    else if (score < 65) { tag.textContent = 'BALANCED'; tag.style.backgroundColor = '#f0ad4e'; }
    else if (score < 85) { tag.textContent = 'SCARCE'; tag.style.backgroundColor = '#007a33'; }
    else { tag.textContent = 'HYPER-SCARCE'; tag.style.backgroundColor = '#d9534f'; }
}

document.addEventListener("DOMContentLoaded", init);
