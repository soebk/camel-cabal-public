// Cabal Arcade — Snake, Tetris, Flappy Bird, Minesweeper. Mobile + desktop.
// Uses cabalState.token from cabal.js for score submission.
(function () {
"use strict";
const API = "https://<your-api-domain>/cabal";
let canvas, ctx, raf = 0, currentGame = null, gameInputs = null;

function $a(id) { return document.getElementById(id); }
function getToken() {
    if (window.cabalState && window.cabalState.token) return window.cabalState.token;
    return localStorage.getItem("cabal.token");
}
function isTouch() { return matchMedia("(hover: none), (max-width: 720px)").matches; }

async function submitScore(game, score, meta) {
    const token = getToken();
    if (!token) return { error: "not signed in" };
    try {
        const r = await fetch(API + "/scores", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
            body: JSON.stringify({ game, score, meta: meta || {} }),
        });
        return await r.json();
    } catch (e) { return { error: String(e) }; }
}

async function loadLeaderboard(game) {
    const r = await fetch(API + "/scores?game=" + encodeURIComponent(game));
    return await r.json();
}

// ── shared input plumbing ───────────────────────────────────────
function makeInputs() {
    const state = { down: {}, presses: [], swipe: null };
    function press(k) { state.down[k] = true; state.presses.push(k); }
    function release(k) { state.down[k] = false; }
    document.addEventListener("keydown", arcadeKeyDown);
    document.addEventListener("keyup", arcadeKeyUp);
    function arcadeKeyDown(e) {
        if (!currentGame) return;
        const k = mapKey(e.key);
        if (!k) return;
        e.preventDefault();
        press(k);
    }
    function arcadeKeyUp(e) {
        const k = mapKey(e.key); if (!k) return;
        release(k);
    }
    function mapKey(k) {
        switch (k) {
            case "ArrowUp": case "w": case "W": return "up";
            case "ArrowDown": case "s": case "S": return "down";
            case "ArrowLeft": case "a": case "A": return "left";
            case "ArrowRight": case "d": case "D": return "right";
            case " ": case "Enter": return "fire";
            case "z": case "Z": return "z";
            case "x": case "X": return "x";
        }
        return null;
    }
    // touch d-pad
    document.querySelectorAll("#arcade-pad button[data-pad]").forEach(b => {
        const k = b.dataset.pad;
        const onDown = (e) => { e.preventDefault(); press(k); };
        const onUp   = (e) => { e.preventDefault(); release(k); };
        b.addEventListener("touchstart", onDown, {passive:false});
        b.addEventListener("touchend",   onUp);
        b.addEventListener("touchcancel",onUp);
        b.addEventListener("mousedown",  onDown);
        b.addEventListener("mouseup",    onUp);
        b.addEventListener("mouseleave", onUp);
    });
    // swipe on canvas
    let sx=0, sy=0, st=0;
    canvas.addEventListener("touchstart", e => { const t = e.touches[0]; sx=t.clientX; sy=t.clientY; st=Date.now(); }, {passive:true});
    canvas.addEventListener("touchend", e => {
        const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy, dt = Date.now() - st;
        if (dt > 500) return;
        const ax = Math.abs(dx), ay = Math.abs(dy);
        if (ax < 20 && ay < 20) { state.swipe = "tap"; press("fire"); setTimeout(() => release("fire"), 50); return; }
        if (ax > ay) state.swipe = dx > 0 ? "right" : "left";
        else         state.swipe = dy > 0 ? "down"  : "up";
        press(state.swipe); setTimeout(() => release(state.swipe), 50);
    });
    canvas.addEventListener("click", () => { press("fire"); setTimeout(() => release("fire"), 50); });
    state.consumePresses = () => { const p = state.presses; state.presses = []; return p; };
    state.dispose = () => { document.removeEventListener("keydown", arcadeKeyDown); document.removeEventListener("keyup", arcadeKeyUp); };
    return state;
}

// ── arcade lifecycle ────────────────────────────────────────────
function startGame(name, gameFn) {
    stopGame();
    currentGame = name;
    document.querySelectorAll(".arcade-tile").forEach(t => t.classList.toggle("active", t.dataset.game === name));
    $a("arcade-canvas-wrap").style.display = "block";
    $a("arcade-board").style.display = "block";
    $a("arcade-name").textContent = name.toUpperCase();
    canvas = $a("arcade-canvas");
    ctx = canvas.getContext("2d");
    gameInputs = makeInputs();
    refreshLeaderboard(name);
    gameFn(canvas, ctx, gameInputs);
}
function stopGame() {
    if (raf) cancelAnimationFrame(raf), raf = 0;
    if (gameInputs && gameInputs.dispose) gameInputs.dispose();
    gameInputs = null;
    currentGame = null;
}
function gameOver(name, score, meta) {
    stopGame();
    ctx.fillStyle = "rgba(5,10,5,0.85)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#4cd44c";
    ctx.font = "bold 28px monospace";
    ctx.textAlign = "center";
    ctx.fillText("GAME OVER", canvas.width/2, canvas.height/2 - 10);
    ctx.font = "14px monospace";
    ctx.fillText("score " + score, canvas.width/2, canvas.height/2 + 20);
    ctx.fillStyle = "#9bd09b";
    ctx.fillText("submitting…", canvas.width/2, canvas.height/2 + 50);
    submitScore(name, score, meta).then(r => {
        ctx.fillStyle = "rgba(5,10,5,0.92)";
        ctx.fillRect(0, canvas.height/2 + 35, canvas.width, 30);
        ctx.fillStyle = r && !r.error ? "#4cd44c" : "#d44c4c";
        ctx.fillText(r && !r.error ? "✓ recorded" : ("err: " + (r.error || "?")), canvas.width/2, canvas.height/2 + 55);
        refreshLeaderboard(name);
        loadGlobalLB();
    });
}
async function refreshLeaderboard(game) {
    const lb = $a("arcade-leaderboard");
    if (!lb) return;
    lb.innerHTML = `<div class="arc-lb-h">${game.toUpperCase()} · top 50</div><div class="cabal-empty">loading…</div>`;
    const j = await loadLeaderboard(game);
    const rows = (j.items || []).map((it, i) => {
        const name = (it.handle && it.handle.trim()) || ((it.wallet||"").slice(0,6) + "…" + (it.wallet||"").slice(-4));
        const pfp = it.pfp_image
            ? `<img src="${escA(it.pfp_image)}" class="arc-lb-pfp" onerror="this.style.display='none'">`
            : '';
        return `<div class="arc-lb-row"><span class="arc-lb-rank">${i+1}</span>${pfp}<span class="arc-lb-name">${escA(name)}</span><span class="arc-lb-score">${it.score}</span></div>`;
    }).join("");
    lb.innerHTML = `<div class="arc-lb-h">${game.toUpperCase()} · top 50</div>` + (rows || `<div class="cabal-empty">no scores yet · play to claim #1</div>`);
}
function escA(s) { return (s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

// ─────────────────────────────────────────────────────────────────
// SNAKE
function snakeGame(c, ctx, inputs) {
    c.width = 320; c.height = 320;
    const cell = 16, cols = 20, rows = 20;
    let snake = [{x:10,y:10}], dir = {x:1,y:0}, nextDir = dir;
    let apple = randomCell(); let score = 0; let lastStep = 0; let stepMs = 150;
    function randomCell() {
        while (true) {
            const p = { x: Math.floor(Math.random()*cols), y: Math.floor(Math.random()*rows) };
            if (!snake.some(s => s.x===p.x && s.y===p.y)) return p;
        }
    }
    function loop(ts) {
        for (const k of inputs.consumePresses()) {
            if (k==="left"  && dir.x !== 1) nextDir = {x:-1,y:0};
            if (k==="right" && dir.x !==-1) nextDir = {x: 1,y:0};
            if (k==="up"    && dir.y !== 1) nextDir = {x:0,y:-1};
            if (k==="down"  && dir.y !==-1) nextDir = {x:0,y: 1};
        }
        if (ts - lastStep > stepMs) {
            lastStep = ts;
            dir = nextDir;
            const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
            if (head.x<0||head.x>=cols||head.y<0||head.y>=rows) return gameOver("snake", score);
            if (snake.some(s => s.x===head.x && s.y===head.y)) return gameOver("snake", score);
            snake.unshift(head);
            if (head.x===apple.x && head.y===apple.y) { score++; apple = randomCell(); if (score % 3 === 0) stepMs = Math.max(75, stepMs-3); }
            else snake.pop();
        }
        // dark bg with subtle grid
        ctx.fillStyle = "#0a0e0a"; ctx.fillRect(0,0,c.width,c.height);
        ctx.strokeStyle = "rgba(76,212,76,0.06)";
        for (let x=0; x<=cols; x++) { ctx.beginPath(); ctx.moveTo(x*cell, 0); ctx.lineTo(x*cell, c.height); ctx.stroke(); }
        for (let y=0; y<=rows; y++) { ctx.beginPath(); ctx.moveTo(0, y*cell); ctx.lineTo(c.width, y*cell); ctx.stroke(); }
        // apple — bright red
        ctx.fillStyle = "#ff3344";
        ctx.beginPath(); ctx.arc(apple.x*cell+cell/2, apple.y*cell+cell/2, cell/2-1, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = "#ffaaaa"; // shine
        ctx.beginPath(); ctx.arc(apple.x*cell+cell/2-2, apple.y*cell+cell/2-2, 2, 0, Math.PI*2); ctx.fill();
        // snake — yellow head, white body, dark outline
        snake.forEach((s,i) => {
            ctx.fillStyle = i===0 ? "#fee36a" : "#ffffff";
            ctx.fillRect(s.x*cell, s.y*cell, cell, cell);
            ctx.strokeStyle = "#0a0e0a"; ctx.lineWidth = 2;
            ctx.strokeRect(s.x*cell+1, s.y*cell+1, cell-2, cell-2);
        });
        ctx.fillStyle = "#fee36a"; ctx.font = "bold 14px monospace"; ctx.textAlign = "left";
        ctx.fillText("SCORE " + score, 8, 16);
        if (currentGame === "snake") raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
}

// ─────────────────────────────────────────────────────────────────
// TETRIS
function tetrisGame(c, ctx, inputs) {
    const cols = 10, rows = 20, cell = 24;
    c.width = cols*cell; c.height = rows*cell;
    const SHAPES = {
        I: [[1,1,1,1]],
        O: [[1,1],[1,1]],
        T: [[0,1,0],[1,1,1]],
        S: [[0,1,1],[1,1,0]],
        Z: [[1,1,0],[0,1,1]],
        J: [[1,0,0],[1,1,1]],
        L: [[0,0,1],[1,1,1]],
    };
    const COLORS = { I:"#4cd44c", O:"#fee36a", T:"#a85bd1", S:"#3c8aff", Z:"#d44c4c", J:"#ff8a3c", L:"#7d2222" };
    const board = Array.from({length: rows}, () => Array(cols).fill(null));
    let cur = newPiece(), score = 0, lines = 0, level = 1, dropMs = 800, lastDrop = 0, gameEnded = false;
    function newPiece() {
        const k = Object.keys(SHAPES)[Math.floor(Math.random()*7)];
        const sh = SHAPES[k].map(r => r.slice());
        return { k, sh, x: Math.floor(cols/2 - sh[0].length/2), y: 0 };
    }
    function rotate(sh) {
        const h=sh.length, w=sh[0].length;
        const r = Array.from({length:w}, () => Array(h).fill(0));
        for (let y=0;y<h;y++) for (let x=0;x<w;x++) r[x][h-1-y] = sh[y][x];
        return r;
    }
    function collide(sh, ox, oy) {
        for (let y=0;y<sh.length;y++) for (let x=0;x<sh[0].length;x++) {
            if (!sh[y][x]) continue;
            const px = ox+x, py = oy+y;
            if (px<0||px>=cols||py>=rows) return true;
            if (py>=0 && board[py][px]) return true;
        }
        return false;
    }
    function lock() {
        for (let y=0;y<cur.sh.length;y++) for (let x=0;x<cur.sh[0].length;x++) {
            if (cur.sh[y][x]) {
                const py = cur.y+y;
                if (py < 0) { gameEnded = true; return; }
                board[py][cur.x+x] = cur.k;
            }
        }
        let cleared = 0;
        for (let y=rows-1;y>=0;y--) {
            if (board[y].every(c => c)) { board.splice(y,1); board.unshift(Array(cols).fill(null)); cleared++; y++; }
        }
        if (cleared) {
            lines += cleared;
            score += [0,40,100,300,1200][cleared] * level;
            level = 1 + Math.floor(lines/12);
            dropMs = Math.max(140, 800 - (level-1)*50);
        }
        cur = newPiece();
        if (collide(cur.sh, cur.x, cur.y)) gameEnded = true;
    }
    function loop(ts) {
        for (const k of inputs.consumePresses()) {
            if (k==="left"  && !collide(cur.sh, cur.x-1, cur.y)) cur.x--;
            if (k==="right" && !collide(cur.sh, cur.x+1, cur.y)) cur.x++;
            if (k==="down"  && !collide(cur.sh, cur.x, cur.y+1)) cur.y++;
            if (k==="up" || k==="z") {
                const r = rotate(cur.sh);
                if (!collide(r, cur.x, cur.y)) cur.sh = r;
                else if (!collide(r, cur.x-1, cur.y)) { cur.sh = r; cur.x--; }
                else if (!collide(r, cur.x+1, cur.y)) { cur.sh = r; cur.x++; }
            }
            if (k==="fire") { while (!collide(cur.sh, cur.x, cur.y+1)) { cur.y++; score+=2; } lock(); lastDrop = ts; }
        }
        if (ts - lastDrop > dropMs) {
            lastDrop = ts;
            if (collide(cur.sh, cur.x, cur.y+1)) lock();
            else cur.y++;
        }
        if (gameEnded) return gameOver("tetris", score, { lines, level });
        ctx.fillStyle = "#050a05"; ctx.fillRect(0,0,c.width,c.height);
        ctx.strokeStyle = "rgba(76,212,76,0.08)";
        for (let x=0;x<cols;x++) for (let y=0;y<rows;y++) ctx.strokeRect(x*cell,y*cell,cell,cell);
        for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) {
            if (board[y][x]) { ctx.fillStyle = COLORS[board[y][x]]; ctx.fillRect(x*cell+1, y*cell+1, cell-2, cell-2); }
        }
        ctx.fillStyle = COLORS[cur.k];
        for (let y=0;y<cur.sh.length;y++) for (let x=0;x<cur.sh[0].length;x++) {
            if (cur.sh[y][x]) ctx.fillRect((cur.x+x)*cell+1, (cur.y+y)*cell+1, cell-2, cell-2);
        }
        ctx.fillStyle = "#c5e8c5"; ctx.font = "12px monospace"; ctx.textAlign = "left";
        ctx.fillText(`SCORE ${score} · LINES ${lines} · LV ${level}`, 6, 14);
        if (currentGame === "tetris") raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
}

// ─────────────────────────────────────────────────────────────────
// FLAPPY BIRD
function flappyGame(c, ctx, inputs) {
    c.width = 320; c.height = 480;
    const G = 0.32, JUMP = -6.5, PIPE_W = 50, GAP = 165, SPEED = 1.8;
    let bird = { y: c.height/2, v: 0 }, pipes = [], score = 0, t = 0, ended = false;
    function spawn() { const top = 60 + Math.random() * (c.height - GAP - 120); pipes.push({ x: c.width, top, scored: false }); }
    function loop() {
        for (const k of inputs.consumePresses()) {
            if (k === "fire" || k === "up") bird.v = JUMP;
        }
        bird.v += G; bird.y += bird.v;
        t++; if (t % 120 === 0) spawn();
        for (const p of pipes) p.x -= SPEED;
        pipes = pipes.filter(p => p.x + PIPE_W > 0);
        for (const p of pipes) {
            if (!p.scored && p.x + PIPE_W < 80) { score++; p.scored = true; }
            if (40 + 14 > p.x && 40 - 14 < p.x + PIPE_W && (bird.y - 12 < p.top || bird.y + 12 > p.top + GAP)) ended = true;
        }
        if (bird.y > c.height - 12 || bird.y < 12) ended = true;
        if (ended) return gameOver("flappy", score);

        ctx.fillStyle = "#0a1a0a"; ctx.fillRect(0,0,c.width,c.height);
        ctx.fillStyle = "#1f6f1f";
        for (const p of pipes) {
            ctx.fillRect(p.x, 0, PIPE_W, p.top);
            ctx.fillRect(p.x, p.top + GAP, PIPE_W, c.height - p.top - GAP);
        }
        ctx.fillStyle = "#fee36a";
        ctx.beginPath(); ctx.arc(40, bird.y, 12, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = "#050a05"; ctx.beginPath(); ctx.arc(45, bird.y-3, 2, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.font = "bold 26px monospace"; ctx.textAlign = "center";
        ctx.fillText(score, c.width/2, 38);
        if (currentGame === "flappy") raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
}

// ─────────────────────────────────────────────────────────────────
// MINESWEEPER
function minesweeperGame(c, ctx, inputs) {
    const cols = 12, rows = 12, cell = 26, mines = 20;
    c.width = cols*cell; c.height = rows*cell + 24;
    const board = []; const reveal = []; const flag = [];
    for (let y=0; y<rows; y++) { board.push(Array(cols).fill(0)); reveal.push(Array(cols).fill(false)); flag.push(Array(cols).fill(false)); }
    let placed = 0; while (placed < mines) {
        const x = Math.floor(Math.random()*cols), y = Math.floor(Math.random()*rows);
        if (board[y][x] !== -1) { board[y][x] = -1; placed++; }
    }
    for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) {
        if (board[y][x] === -1) continue;
        let n = 0;
        for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
            const ny=y+dy, nx=x+dx; if (ny>=0&&ny<rows&&nx>=0&&nx<cols&&board[ny][nx]===-1) n++;
        }
        board[y][x] = n;
    }
    let revealed = 0, ended = false, won = false;
    let pressTimer = null, longPress = false;
    function flood(x, y) {
        if (x<0||x>=cols||y<0||y>=rows||reveal[y][x]||flag[y][x]) return;
        reveal[y][x] = true; revealed++;
        if (board[y][x] === 0) for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) flood(x+dx, y+dy);
    }
    function clickAt(mx, my, isFlag) {
        const x = Math.floor(mx/cell), y = Math.floor((my-24)/cell);
        if (x<0||x>=cols||y<0||y>=rows) return;
        if (ended) return;
        if (isFlag) { if (!reveal[y][x]) flag[y][x] = !flag[y][x]; return; }
        if (flag[y][x]) return;
        if (board[y][x] === -1) { reveal[y][x] = true; ended = true; won = false; return finish(); }
        flood(x, y);
        if (revealed === rows*cols - mines) { ended = true; won = true; finish(); }
    }
    function finish() {
        const score = won ? Math.max(1, 10000 - Math.floor((Date.now()-startT)/100)) : 0;
        draw();
        setTimeout(() => gameOver("minesweeper", score, { won }), 200);
    }
    const startT = Date.now();
    function pos(e) {
        const r = c.getBoundingClientRect();
        const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
        return { x: (t.clientX - r.left) * (c.width / r.width), y: (t.clientY - r.top) * (c.height / r.height) };
    }
    function onDown(e) {
        e.preventDefault();
        const p = pos(e); longPress = false;
        pressTimer = setTimeout(() => { longPress = true; clickAt(p.x, p.y, true); }, 350);
    }
    function onUp(e) {
        e.preventDefault();
        clearTimeout(pressTimer);
        const p = pos(e);
        if (!longPress) clickAt(p.x, p.y, e.button === 2 || e.shiftKey);
    }
    function onCtx(e) { e.preventDefault(); const p = pos(e); clickAt(p.x, p.y, true); }
    c.addEventListener("touchstart", onDown, {passive:false});
    c.addEventListener("touchend",   onUp,   {passive:false});
    c.addEventListener("mousedown",  onDown);
    c.addEventListener("mouseup",    onUp);
    c.addEventListener("contextmenu",onCtx);
    function draw() {
        ctx.fillStyle = "#050a05"; ctx.fillRect(0,0,c.width,c.height);
        ctx.fillStyle = "#c5e8c5"; ctx.font = "14px monospace"; ctx.textAlign = "left";
        const flags = flag.flat().filter(Boolean).length;
        ctx.fillText(`MINES ${mines - flags} · ${ended?(won?"WON":"BOOM"):"…"} · ${Math.floor((Date.now()-startT)/1000)}s`, 6, 16);
        for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) {
            const px = x*cell, py = y*cell + 24;
            ctx.fillStyle = reveal[y][x] ? "#0a1a0a" : "#1f6f1f";
            ctx.fillRect(px+1, py+1, cell-2, cell-2);
            if (reveal[y][x]) {
                if (board[y][x] === -1) {
                    ctx.fillStyle = "#d44c4c"; ctx.beginPath(); ctx.arc(px+cell/2, py+cell/2, cell/3, 0, Math.PI*2); ctx.fill();
                } else if (board[y][x] > 0) {
                    const colors = [null, "#9bd09b", "#4cd44c", "#fee36a", "#ff8a3c", "#d44c4c", "#a85bd1", "#3c8aff", "#fff"];
                    ctx.fillStyle = colors[board[y][x]] || "#fff";
                    ctx.font = "bold 16px monospace"; ctx.textAlign = "center";
                    ctx.fillText(board[y][x], px+cell/2, py+cell/2 + 6);
                }
            } else if (flag[y][x]) {
                ctx.fillStyle = "#d44c4c"; ctx.beginPath(); ctx.moveTo(px+8, py+5); ctx.lineTo(px+18, py+10); ctx.lineTo(px+8, py+15); ctx.closePath(); ctx.fill();
                ctx.fillStyle = "#fff"; ctx.fillRect(px+8, py+5, 1, cell-10);
            }
        }
    }
    function loop() { draw(); if (currentGame === "minesweeper" && !ended) raf = requestAnimationFrame(loop); }
    raf = requestAnimationFrame(loop);
}

// ─────────────────────────────────────────────────────────────────
// PAC-MAN
// 21x23 maze. Symbols: # wall, . dot, o power pellet, space empty, T tunnel
const PAC_MAZE = [
    "#####################",
    "#.........#.........#",
    "#o###.###.#.###.###o#",
    "#.###.###.#.###.###.#",
    "#...................#",
    "#.###.#.#####.#.###.#",
    "#.....#...#...#.....#",
    "#####.### # ###.#####",
    "    #.#       #.#    ",
    "    #.# ##=## #.#    ",
    "T...#.# #   # #.#...T",
    "    #.# ##### #.#    ",
    "    #.#       #.#    ",
    "#####.# ##### #.#####",
    "#.........#.........#",
    "#.###.###.#.###.###.#",
    "#o..#...........#..o#",
    "###.#.#.#####.#.#.###",
    "#.....#...#...#.....#",
    "#.#######.#.#######.#",
    "#...................#",
    "#####################",
];
const PAC_W = PAC_MAZE[0].length, PAC_H = PAC_MAZE.length;
function pacmanGame(c, ctx, inputs) {
    const cell = 16;
    c.width = PAC_W * cell; c.height = PAC_H * cell + 24;
    const grid = PAC_MAZE.map(r => r.split(""));
    let score = 0, lives = 3, dotsLeft = 0, frightened = 0, gameEnded = false, won = false;
    for (let y=0; y<PAC_H; y++) for (let x=0; x<PAC_W; x++)
        if (grid[y][x] === "." || grid[y][x] === "o") dotsLeft++;
    // wall check — gate '=' blocks pacman but ghosts in/out of the pen can pass through.
    const wallAt = (x, y, ghostMode) => {
        if (y < 0 || y >= PAC_H) return true;
        const wrap = ((x % PAC_W) + PAC_W) % PAC_W;
        const t = grid[y][wrap];
        if (t === "#") return true;
        if (t === "=") return !ghostMode;
        return false;
    };
    const tileAt = (x, y) => grid[y] && grid[y][x];
    const pac = { x: 10, y: 17, dir: {x:0,y:0}, want: {x:0,y:0}, mouth: 0 };
    const ghosts = [
        { x:10, y:9, dir:{x:1,y:0},  color:"#ff3030", scatter:{x:PAC_W-2, y:0},     name:"blinky", out:true },
        { x: 9, y:10,dir:{x:0,y:-1}, color:"#ffb8d8", scatter:{x:1, y:0},           name:"pinky",  out:false, leaveAt: 200 },
        { x:10, y:10,dir:{x:0,y:-1}, color:"#30d8ff", scatter:{x:PAC_W-2, y:PAC_H-2}, name:"inky",  out:false, leaveAt: 700 },
        { x:11, y:10,dir:{x:0,y:-1}, color:"#ffb060", scatter:{x:1, y:PAC_H-2},     name:"clyde", out:false, leaveAt:1500 },
    ];
    let stepTick = 0, ghostStepEvery = 11, pacStepEvery = 7;
    function bumpDir() {
        for (const k of inputs.consumePresses()) {
            if (k==="left")  pac.want = {x:-1,y:0};
            if (k==="right") pac.want = {x: 1,y:0};
            if (k==="up")    pac.want = {x:0,y:-1};
            if (k==="down")  pac.want = {x:0,y: 1};
        }
    }
    function stepPac() {
        // try wanted direction first
        if (!wallAt(pac.x + pac.want.x, pac.y + pac.want.y, false)) pac.dir = pac.want;
        if (wallAt(pac.x + pac.dir.x, pac.y + pac.dir.y, false)) return;
        pac.x = ((pac.x + pac.dir.x + PAC_W) % PAC_W);
        pac.y = pac.y + pac.dir.y;
        pac.mouth = (pac.mouth + 1) % 6;
        const t = tileAt(pac.x, pac.y);
        if (t === ".") { grid[pac.y][pac.x] = " "; score += 10; dotsLeft--; }
        else if (t === "o") { grid[pac.y][pac.x] = " "; score += 50; dotsLeft--; frightened = 220; }
        if (dotsLeft <= 0) { won = true; gameEnded = true; }
    }
    function chooseGhostDir(g, target) {
        // ghost in pen → march to the gate at (10, 9), then up to (10, 8) to exit
        if (!g.out) {
            if (g.y >= 10) {
                if (g.x < 10)      g.dir = {x: 1, y: 0};
                else if (g.x > 10) g.dir = {x:-1, y: 0};
                else               g.dir = {x: 0, y:-1};   // at (10, 10) — head up to gate
            } else if (g.y === 9 && g.x === 10) {
                g.dir = {x: 0, y: -1};  // through the gate
                g.out = true;           // next tick will use normal AI
            } else {
                g.dir = {x: 0, y: -1};
            }
            return;
        }
        // at intersection, pick best non-reverse dir
        const dirs = [{x:0,y:-1},{x:-1,y:0},{x:0,y:1},{x:1,y:0}];
        const back = {x:-g.dir.x, y:-g.dir.y};
        let best = null, bestD = Infinity;
        for (const d of dirs) {
            if (d.x === back.x && d.y === back.y) continue;
            const nx = g.x + d.x, ny = g.y + d.y;
            if (wallAt(nx, ny, false)) continue;  // out-ghosts can't re-enter pen via gate
            const dx = ((nx % PAC_W) + PAC_W) % PAC_W - target.x;
            const dy = ny - target.y;
            const dd = dx*dx + dy*dy;
            if (dd < bestD) { bestD = dd; best = d; }
        }
        if (best) g.dir = best;
    }
    function ghostTarget(g, scatterMode) {
        if (frightened) {
            // wander — pick random target
            return { x: Math.floor(Math.random()*PAC_W), y: Math.floor(Math.random()*PAC_H) };
        }
        if (scatterMode) return g.scatter;
        if (g.name === "blinky") return { x: pac.x, y: pac.y };
        if (g.name === "pinky")  return { x: pac.x + pac.dir.x*4, y: pac.y + pac.dir.y*4 };
        if (g.name === "inky") {
            const blinky = ghosts[0];
            return { x: 2*(pac.x + pac.dir.x*2) - blinky.x, y: 2*(pac.y + pac.dir.y*2) - blinky.y };
        }
        if (g.name === "clyde") {
            const dist = Math.hypot(g.x - pac.x, g.y - pac.y);
            return dist > 8 ? { x: pac.x, y: pac.y } : g.scatter;
        }
        return { x: pac.x, y: pac.y };
    }
    function stepGhosts() {
        const scatter = (Math.floor(stepTick / 200) % 4 === 0) && !frightened;
        for (let i = 0; i < ghosts.length; i++) {
            const g = ghosts[i];
            if (!g.out && stepTick > (g.leaveAt || 0)) g.out = true;
            chooseGhostDir(g, ghostTarget(g, scatter));
            const nx = ((g.x + g.dir.x + PAC_W) % PAC_W);
            const ny = g.y + g.dir.y;
            // ghosts in pen can pass through gate; out-ghosts can't go back through it.
            if (!wallAt(nx, ny, true)) { g.x = nx; g.y = ny; }
        }
    }
    function checkCollide() {
        for (let i = 0; i < ghosts.length; i++) {
            const g = ghosts[i];
            if (g.x === pac.x && g.y === pac.y) {
                if (frightened && !g.eaten) {
                    score += 200 * Math.pow(2, ghosts.filter(gg => gg.eaten).length);
                    g.eaten = true;
                    g.x = 10; g.y = 10; g.out = false;
                    setTimeout(() => { g.eaten = false; }, 0); // reset visual
                } else if (!g.eaten) {
                    lives--;
                    if (lives <= 0) { gameEnded = true; return; }
                    pac.x = 10; pac.y = 17; pac.dir = {x:0,y:0}; pac.want = {x:0,y:0};
                    ghosts.forEach((gh, idx) => { gh.x = [10,9,10,11][idx]; gh.y = idx===0?9:10; gh.out = idx===0; });
                    stepTick = 0; frightened = 0;
                    return;
                }
            }
        }
    }
    function loop() {
        bumpDir();
        if (stepTick % pacStepEvery === 0) stepPac();
        if (stepTick % ghostStepEvery === 0) { stepGhosts(); checkCollide(); }
        if (frightened > 0) frightened--;
        stepTick++;
        if (gameEnded) return gameOver("pacman", score, { won, lives });
        // draw
        ctx.fillStyle = "#000010"; ctx.fillRect(0,0,c.width,c.height);
        ctx.fillStyle = "#fff"; ctx.font = "bold 14px monospace"; ctx.textAlign = "left";
        ctx.fillText(`SCORE ${score}  LIVES ${lives}`, 4, 16);
        for (let y=0; y<PAC_H; y++) for (let x=0; x<PAC_W; x++) {
            const t = grid[y][x], px = x*cell, py = y*cell + 24;
            if (t === "#") {
                ctx.fillStyle = "#1438c6"; ctx.fillRect(px, py, cell, cell);
                ctx.strokeStyle = "#3060ff"; ctx.lineWidth = 1; ctx.strokeRect(px+1, py+1, cell-2, cell-2);
            } else if (t === "=") { ctx.fillStyle = "#ffb8d8"; ctx.fillRect(px, py + cell/2 - 1, cell, 2); }
            else if (t === ".")   { ctx.fillStyle = "#ffeacc"; ctx.beginPath(); ctx.arc(px+cell/2, py+cell/2, 1.5, 0, Math.PI*2); ctx.fill(); }
            else if (t === "o")   {
                const pulse = (Math.sin(stepTick/8) + 1) / 2;
                ctx.fillStyle = "#ffeacc"; ctx.beginPath(); ctx.arc(px+cell/2, py+cell/2, 4 + pulse*1.5, 0, Math.PI*2); ctx.fill();
            }
        }
        // ghosts
        for (const g of ghosts) {
            const gx = g.x*cell, gy = g.y*cell + 24;
            ctx.fillStyle = frightened ? (frightened < 60 && stepTick%8 < 4 ? "#fff" : "#3030d0") : g.color;
            ctx.beginPath();
            ctx.arc(gx+cell/2, gy+cell/2, cell/2-1, Math.PI, 0);
            ctx.lineTo(gx+cell-1, gy+cell-1); ctx.lineTo(gx+1, gy+cell-1); ctx.closePath(); ctx.fill();
            // eyes
            ctx.fillStyle = "#fff";
            ctx.fillRect(gx+4, gy+5, 3, 4); ctx.fillRect(gx+cell-7, gy+5, 3, 4);
            ctx.fillStyle = "#000";
            const eox = g.dir.x, eoy = g.dir.y;
            ctx.fillRect(gx+5+eox, gy+6+eoy, 2, 2); ctx.fillRect(gx+cell-6+eox, gy+6+eoy, 2, 2);
        }
        // pacman
        const px = pac.x*cell + cell/2, py = pac.y*cell + 24 + cell/2;
        const ang = Math.PI/4 * (Math.sin(pac.mouth*0.7) + 1) / 2;
        let baseAng = 0;
        if (pac.dir.x === 1) baseAng = 0;
        else if (pac.dir.x === -1) baseAng = Math.PI;
        else if (pac.dir.y === -1) baseAng = -Math.PI/2;
        else if (pac.dir.y === 1) baseAng = Math.PI/2;
        ctx.fillStyle = "#ffe308";
        ctx.beginPath();
        ctx.arc(px, py, cell/2-1, baseAng + ang, baseAng - ang + 2*Math.PI);
        ctx.lineTo(px, py); ctx.closePath(); ctx.fill();
        if (currentGame === "pacman") raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
}

// ─────────────────────────────────────────────────────────────────
// GALAGA (lite — no tractor beam, single enemy type, wave-based)
function galagaGame(c, ctx, inputs) {
    c.width = 320; c.height = 480;
    const ship = { x: c.width/2, y: c.height - 30, w: 22, h: 18, lives: 3, cd: 0, invuln: 60 };
    let bullets = [], enemyBullets = [], enemies = [], particles = [];
    let score = 0, wave = 0, ended = false, frame = 0;
    function spawnWave() {
        wave++;
        enemies = [];
        const cols = 7, rows = Math.min(4, 2 + Math.floor(wave/3));
        for (let r = 0; r < rows; r++) for (let cx = 0; cx < cols; cx++) {
            const homeX = 35 + cx * 36;
            const homeY = 55 + r * 30;
            const isBoss = r === 0 && cx >= 2 && cx <= 4;
            enemies.push({
                x: homeX, y: -20 - r*20 - cx*4,
                homeX, homeY, w: 20, h: 16,
                phase: "enter", t: cx*3 + r*8,
                isBoss, hp: isBoss ? 2 : 1,
                color: isBoss ? "#ff3030" : (r === 1 ? "#ffe308" : "#30d8ff"),
                dive: false, diveT: 0, divePath: null,
            });
        }
    }
    spawnWave();
    function fire() {
        if (ship.cd > 0) return;
        if (bullets.length >= 2) return;
        bullets.push({ x: ship.x, y: ship.y - 10, vy: -7 });
        ship.cd = 8;
    }
    function explode(x, y, color) {
        for (let i = 0; i < 14; i++) {
            const a = Math.random() * Math.PI * 2, s = 1 + Math.random()*3;
            particles.push({ x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s, life: 24, color });
        }
    }
    function rectOverlap(a, b) {
        return Math.abs(a.x - b.x) < (a.w+b.w)/2 && Math.abs(a.y - b.y) < (a.h+b.h)/2;
    }
    function loop() {
        frame++;
        for (const k of inputs.consumePresses()) if (k==="fire") fire();
        if (inputs.down.left)  ship.x = Math.max(15, ship.x - 4);
        if (inputs.down.right) ship.x = Math.min(c.width-15, ship.x + 4);
        if (inputs.down.fire)  fire();
        ship.cd = Math.max(0, ship.cd - 1);
        ship.invuln = Math.max(0, ship.invuln - 1);
        // bullets
        for (const b of bullets) b.y += b.vy;
        bullets = bullets.filter(b => b.y > -10);
        for (const b of enemyBullets) b.y += b.vy;
        enemyBullets = enemyBullets.filter(b => b.y < c.height + 10);
        // enemies
        const swayX = Math.sin(frame * 0.02) * 8;
        for (const e of enemies) {
            if (e.phase === "enter") {
                const tx = e.homeX, ty = e.homeY;
                e.x += (tx - e.x) * 0.04;
                e.y += (ty - e.y) * 0.04 + 0.6;
                if (Math.abs(e.x - tx) < 1 && Math.abs(e.y - ty) < 1) e.phase = "formation";
            } else if (e.phase === "formation") {
                e.x = e.homeX + swayX;
                e.y = e.homeY;
                // Cap simultaneous divers at 2 to keep things manageable.
                const divers = enemies.filter(en => en.phase === "dive").length;
                if (divers < 2 && Math.random() < 0.00015 + wave*0.00008) {
                    e.phase = "dive"; e.diveT = 0;
                    e.divePath = { sx: e.x, sy: e.y, ax: ship.x, ay: ship.y };
                }
                if (enemyBullets.length < 3 && Math.random() < 0.00025 + wave*0.00012) {
                    enemyBullets.push({ x: e.x, y: e.y+8, vy: 2.2, w:3, h:6 });
                }
            } else if (e.phase === "dive") {
                e.diveT += 0.85;
                const t = e.diveT / 80;
                if (t > 1.6) { e.phase = "enter"; }
                else {
                    e.x = e.divePath.sx + (e.divePath.ax - e.divePath.sx) * Math.min(t,1) + Math.sin(t*3)*22;
                    e.y = e.divePath.sy + (c.height + 30 - e.divePath.sy) * t;
                }
                if (enemyBullets.length < 4 && Math.random() < 0.012) {
                    enemyBullets.push({ x: e.x, y: e.y+8, vy: 2.6, w:3, h:6 });
                }
            }
        }
        // collisions: bullets vs enemies
        for (const b of bullets) {
            for (const e of enemies) {
                if (rectOverlap({x:b.x,y:b.y,w:3,h:8}, e)) {
                    b.dead = true; e.hp--;
                    if (e.hp <= 0) {
                        score += e.isBoss ? 150 : 50;
                        explode(e.x, e.y, e.color); e.dead = true;
                    }
                }
            }
        }
        bullets = bullets.filter(b => !b.dead);
        enemies = enemies.filter(e => !e.dead);
        // enemy bullets vs ship
        if (ship.invuln === 0) {
            for (const b of enemyBullets) {
                if (rectOverlap({x:b.x,y:b.y,w:b.w,h:b.h}, ship)) {
                    b.dead = true; ship.lives--; explode(ship.x, ship.y, "#fff");
                    if (ship.lives <= 0) { ended = true; }
                    else { ship.x = c.width/2; ship.invuln = 90; }
                }
            }
        }
        enemyBullets = enemyBullets.filter(b => !b.dead);
        // enemies vs ship
        if (ship.invuln === 0) {
            for (const e of enemies) {
                if (rectOverlap(e, ship)) {
                    explode(ship.x, ship.y, "#fff"); ship.lives--; e.dead = true;
                    if (ship.lives <= 0) ended = true;
                    else { ship.x = c.width/2; ship.invuln = 90; }
                }
            }
        }
        enemies = enemies.filter(e => !e.dead);
        // particles
        for (const p of particles) { p.x += p.vx; p.y += p.vy; p.life--; }
        particles = particles.filter(p => p.life > 0);
        if (!enemies.length && !ended) spawnWave();
        if (ended) return gameOver("galaga", score, { wave });
        // draw
        ctx.fillStyle = "#000010"; ctx.fillRect(0,0,c.width,c.height);
        // stars
        for (let i = 0; i < 40; i++) {
            const sx = (i*73 + frame*0.3) % c.width;
            const sy = (i*131 + frame*1.2) % c.height;
            ctx.fillStyle = i%5===0 ? "#fff" : "#888";
            ctx.fillRect(sx|0, sy|0, 1, 1);
        }
        ctx.fillStyle = "#fff"; ctx.font = "bold 14px monospace"; ctx.textAlign = "left";
        ctx.fillText(`SCORE ${score}  WAVE ${wave}  LIVES ${ship.lives}`, 4, 16);
        // enemies
        for (const e of enemies) {
            ctx.fillStyle = e.color;
            ctx.fillRect(e.x - e.w/2, e.y - e.h/2, e.w, e.h);
            ctx.fillStyle = "#000";
            ctx.fillRect(e.x - e.w/2 + 4, e.y - e.h/2 + 4, 4, 3);
            ctx.fillRect(e.x + e.w/2 - 8, e.y - e.h/2 + 4, 4, 3);
        }
        // bullets
        ctx.fillStyle = "#ffe308";
        for (const b of bullets) ctx.fillRect(b.x-1, b.y, 2, 8);
        ctx.fillStyle = "#ff5050";
        for (const b of enemyBullets) ctx.fillRect(b.x-1, b.y, 2, 6);
        // ship — blink when invulnerable
        if (ship.invuln === 0 || Math.floor(ship.invuln/4) % 2 === 0) {
            ctx.fillStyle = "#fff";
            ctx.beginPath();
            ctx.moveTo(ship.x, ship.y - ship.h/2);
            ctx.lineTo(ship.x - ship.w/2, ship.y + ship.h/2);
            ctx.lineTo(ship.x + ship.w/2, ship.y + ship.h/2);
            ctx.closePath(); ctx.fill();
            ctx.fillStyle = "#30d8ff"; ctx.fillRect(ship.x - 2, ship.y - 3, 4, 6);
        }
        // particles
        for (const p of particles) {
            ctx.fillStyle = p.color; ctx.globalAlpha = Math.max(0, p.life/24);
            ctx.fillRect(p.x|0, p.y|0, 2, 2);
        }
        ctx.globalAlpha = 1;
        if (currentGame === "galaga") raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
}

// ─────────────────────────────────────────────────────────────────
const GAMES = {
    snake:        { fn: snakeGame,       label: "Snake",        live: true },
    tetris:       { fn: tetrisGame,      label: "Tetris",       live: true },
    flappy:       { fn: flappyGame,      label: "Flappy",       live: true },
    minesweeper:  { fn: minesweeperGame, label: "Minesweeper",  live: true },
    pacman:       { fn: pacmanGame,      label: "Pac-Man",      live: true },
    galaga:       { fn: galagaGame,      label: "Galaga",       live: true },
};

async function loadGlobalLB() {
    const el = $a("arcade-global-lb"); if (!el) return;
    el.innerHTML = `<div class="arc-lb-h">GLOBAL · best of every game · top 50</div><div class="cabal-empty">loading…</div>`;
    try {
        const r = await fetch(API + "/scores?scope=global");
        const j = await r.json();
        const items = j.items || [];
        if (!items.length) { el.innerHTML = `<div class="arc-lb-h">GLOBAL</div><div class="cabal-empty">no scores yet · play any game</div>`; return; }
        const games = j.games || [];
        const head = `<div class="arc-lb-h">GLOBAL · best of every game · top 50</div>`;
        const rows = items.map((it, i) => {
            const name = (it.handle && it.handle.trim()) || ((it.wallet||"").slice(0,6) + "…" + (it.wallet||"").slice(-4));
            const pfp = it.pfp_image
                ? `<img src="${escA(it.pfp_image)}" class="arc-lb-pfp" onerror="this.style.display='none'">` : '';
            const breakdown = games.map(g => `${g.slice(0,3)}:${(it.by_game||{})[g] || 0}`).join("  ");
            return `<div class="arc-lb-row arc-lb-row-global">
                <span class="arc-lb-rank">${i+1}</span>${pfp}
                <span class="arc-lb-name">${escA(name)}<span class="arc-lb-breakdown">${breakdown}</span></span>
                <span class="arc-lb-score">${it.total}</span>
            </div>`;
        }).join("");
        el.innerHTML = head + rows;
    } catch (e) { el.innerHTML = `<div class="arc-lb-h">GLOBAL</div><div class="cabal-empty">load failed: ${e.message}</div>`; }
}

function arcadeBoot() {
    const tiles = $a("arcade-tiles"); if (!tiles) return;
    tiles.innerHTML = Object.entries(GAMES).map(([k, g]) =>
        `<button class="arcade-tile ${g.live?'':'disabled'}" data-game="${k}" ${g.live?'':'disabled'}>
            <div class="arcade-tile-name">${g.label}</div>
            <div class="arcade-tile-sub">${g.live?'play':'soon'}</div>
        </button>`).join("");
    loadGlobalLB();
    tiles.addEventListener("click", e => {
        const t = e.target.closest(".arcade-tile"); if (!t || t.disabled) return;
        const g = GAMES[t.dataset.game]; if (!g || !g.live) return;
        startGame(t.dataset.game, g.fn);
        $a("arcade-canvas-wrap").scrollIntoView({behavior:"smooth", block:"start"});
    });
    $a("arcade-restart")?.addEventListener("click", () => {
        if (currentGame) { const g = GAMES[currentGame]; if (g) startGame(currentGame, g.fn); }
    });
    $a("arcade-quit")?.addEventListener("click", () => { stopGame(); $a("arcade-canvas-wrap").style.display = "none"; });
    if (isTouch()) document.body.classList.add("arcade-touch");
}
window.arcadeBoot = arcadeBoot;
window.arcadeStop = stopGame;
})();
