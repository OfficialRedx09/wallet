const express = require('express');
const cors = require('cors');
const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const bip39 = require('bip39');
const ecc = require('tiny-secp256k1');
const axios = require('axios');

// --- 1. Firebase Realtime Database (Public REST API) ---
const DB_BASE = "https://marketwave-727e8-default-rtdb.firebaseio.com";

const app = express();
app.use(cors());
app.use(express.json());

// ── Global request/response logger ──────────────────────────────────────────
// Logs every inbound HTTP request and its final response status/time.
app.use((req, res, next) => {
    const start = Date.now();
    const ip    = req.headers['x-forwarded-for'] || req.ip;
    console.log(`\n[HTTP] ► ${req.method} ${req.originalUrl} | IP: ${ip}`);
    if (req.body && Object.keys(req.body).length > 0) {
        // Redact no sensitive fields here — full visibility requested
        console.log(`[HTTP]   Body: ${JSON.stringify(req.body)}`);
    }
    if (Object.keys(req.query).length > 0) {
        console.log(`[HTTP]   Query: ${JSON.stringify(req.query)}`);
    }
    const origJson  = res.json.bind(res);
    res.json = (data) => {
        const ms = Date.now() - start;
        console.log(`[HTTP] ◄ ${req.method} ${req.originalUrl} | Status: ${res.statusCode} | ${ms}ms | Response: ${JSON.stringify(data)}`);
        return origJson(data);
    };
    next();
});
// ────────────────────────────────────────────────────────────────────────────

// --- 2. Litecoin Network Setup ---
const TATUM_BASE    = "https://api.tatum.io/v3";
const TATUM_API_KEY = process.env.TATUM_API_KEY || "t-6a27313caa620fad0caa1d3b-55c14747b32a46bea844dfcd";
const TREASURY_ADDRESS = "ltc1qxgyxnq3yq02kl0ts7uyldzkkypag4zdws759zy";
const LTC_SATOSHIS     = 1e8;   // 1 LTC = 100,000,000 satoshis
const SWEEP_FEE_SATS   = 10000; // ~0.0001 LTC network fee

const bip32 = BIP32Factory(ecc);

// Litecoin mainnet parameters
const LITECOIN_NETWORK = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
};

// --- Duel.com Token Config ---
const DUEL_TOKEN_URL    = "https://duel.com/api/v2/user/security/token";
const DUEL_BET_URL      = "https://duel.com/api/v2/dice/bet";
const BLOCKCHAIR_BASE   = "https://api.blockchair.com/litecoin";
const DUEL_SEED_ROTATE_URL = "https://duel.com/api/v2/client-seed/rotate";
const DUEL_DEVICE_UUID  = process.env.DUEL_DEVICE_UUID  || "30b3dac8-2c30-4ec7-94fd-67186e92e94a";
// Mobile session cookies — used for all betting calls
const DUEL_COOKIES      = process.env.DUEL_COOKIES      || "_sp_ses.d35b=*; duel=fJI8qZPHDZxyAltk5VkpliO7W6CsGt0DRolgMOZi; do_not_share_this_with_anyone_not_even_staff=4975939_WuJSRlH4AC5r6j18mqc0c0eSh4q0dpVXCkXrYBCSXghU4piA66UO9VaY6N0L; env_class=blue; __cf_bm=VStC4zY6cE1KA3LiiKlkdGntPXUGmmpTrCeDvDpek4Q-1780793051.4816592-1.0.1.1-mAUAzG504OpcxaiYq7.M.kkZVJltBNfMeB0NYhsH7j_3LHwps9iNmBldo.MRaAXJMv7KbOXRra2_7fftHoRLiOfmwN3JaU_v4gEGYHJX7E_CQMnxCdjSYZaV6vBjLI8H; _sp_id.d35b=0c804d9c-585b-41cc-8780-b0208eb9d708.1780793028.1.1780793058..6ea60967-0e40-4ad7-b68a-a0ed4ee85838..82d6b3cc-b57c-4085-8641-199b013583e8.1780793046753.9";
// Desktop session cookies — used exclusively for seed rotation (separate cf_clearance)
const DUEL_SEED_COOKIES = process.env.DUEL_SEED_COOKIES || "duel=fJI8qZPHDZxyAltk5VkpliO7W6CsGt0DRolgMOZi; do_not_share_this_with_anyone_not_even_staff=4975939_WuJSRlH4AC5r6j18mqc0c0eSh4q0dpVXCkXrYBCSXghU4piA66UO9VaY6N0L; _sp_ses.d35b=*; cf_clearance=0azt0u7AEb9PL9puC_mtGV.4UsNlBFXB8PlRG8IVaUw-1780797543-1.2.1.1-afHmObdO4TvSjFxk8R7zyuMtFVvrdc8jLvL0kE5scoWaY.LV2C5lr3mEvZ2jicGm5StD65cxcprimS99mmKBhIXtLQQf_VpG0.Bm4piZKRFfRxuGuzq7jIXZ.NOUmNHIOLLUk8NEyca03hXhAfI8Vn9nIO_aVIt_VYvlaexoNcKYRcbabJumntBTokCQr9LT4ihTPU67DaFpyC3hokty9Qj4ptvI4k5wRN6GpUQfgly0xBhhU_vcdrWCsTHWVUZGhl8g.McFtZlp6iqz.vkYCVpER3.DGrjuR1kAnY1MaIAAnsOM6FwH1x.m9ospNj.3CJK9.3HDEu1eNLma9MHrcxBDz9h5hQy.oFBadZHDyxcb1pxKumuk4sPx5nli.xLO0Q1IC9h_5YflcpVGzWS6kMkkTILOpXKksEbS6iuwpGM; __cf_bm=caQj4DVoVqRW4VAjDqT_i1UdIXzdf9ol4ARiI8vq2e0-1780797546.326099-1.0.1.1-Ii960dRYm7J6eFwWzdUP4f8pf1KEVBE2c8bnd50ceuE8JM_KvvfrgVyrZ2BX2cGG03Qosw_92FBJmA9QamOHsie67yauty6JEde4f7B1nLvUuvp3ofjTk1SOH7rfeztH; env_class=blue; _sp_id.d35b=0c804d9c-585b-41cc-8780-b0208eb9d708.1780793028.2.1780797752.1780795546.5a59b211-7504-4443-be44-d171383b4fce.6ea60967-0e40-4ad7-b68a-a0ed4ee85838.1227487e-b463-4bda-a7d5-89c55b46d832.1780797472489.72";

// Core Lookup Maps
const addressToUserId        = new Map();
const userIdToPhrase         = new Map();
const userSweepQueue         = new Map();
const lastOnChainSats        = new Map(); // userId -> last polled on-chain sats (detects new deposits)
const userAccumulatedBalance = new Map(); // userId -> lifetime accumulated LTC (never decreases after sweep)
const strategySessions       = new Map(); // userId -> strategy session

// ── Telegram notification config ──────────────────────────────────────────────
// Bot token is hard-coded; set TELEGRAM_CHAT_ID env var to your admin chat ID.
// To get your chat ID: message the bot once, then visit:
//   https://api.telegram.org/bot<TOKEN>/getUpdates
const TELEGRAM_BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || '8828699174:AAFz6gwpQVv5ppHod9tV3nb-7K-6FpY2ynQ';
const TELEGRAM_CHAT_ID      = process.env.TELEGRAM_CHAT_ID   || '';  // set via env
const SERVER_ID             = process.env.SERVER_ID           || '102030';
const SERVER_NO             = process.env.SERVER_NO           || '01';
const COMPLEX_PROFIT_TARGET = 0.50;                   // $0.50 profit triggers notification + lock
const LTC_TO_BDT_RATE       = 5000;                   // 1 LTC ≈ 5000 BDT  (balance / 0.00025 × 1.25)
const USER_LOCK_DURATION_MS = 20 * 60 * 60 * 1000;   // 20 hours in ms

// Per-user bet lock — user cannot trade for 20 h after complex-mode profit target is hit
const userBetLocks          = new Map(); // userId -> lockUntilTimestamp (ms epoch)
// ─────────────────────────────────────────────────────────────────────────────

// ── Per-user Firebase balance lock — serialises concurrent R-M-W ops ─────────
const _balanceLocks = new Map();
function acquireBalanceLock(userId, fn) {
    const prev = _balanceLocks.get(userId) || Promise.resolve();
    const next = prev.then(() => fn(), () => fn()); // run fn regardless of prev outcome
    _balanceLocks.set(userId, next.then(() => undefined, () => undefined));
    return next;
}

// ── Global Duel bet serializer — one bet at a time across all users ───────────
// Prevents concurrent bets on the shared Duel account (token races, rate limits)
let _duelBetQueue = Promise.resolve();
function enqueueDuelBet(fn) {
    const next = _duelBetQueue.then(() => fn(), () => fn());
    _duelBetQueue = next.then(() => undefined, () => undefined);
    return next;
}

// ── Seed rotation rate limiter — max 1 call per 60 s ─────────────────────────
// Queued requests wait for the next available 60 s window before executing.
let _lastSeedRotateAt = 0;
let _seedRotateQueue  = Promise.resolve();
function enqueueSeedRotate(fn) {
    const next = _seedRotateQueue.then(
        async () => {
            const waitMs = Math.max(0, 60000 - (Date.now() - _lastSeedRotateAt));
            if (waitMs > 0) {
                console.log(`[SEED] Rate limit: waiting ${(waitMs / 1000).toFixed(1)}s...`);
                await sleep(waitMs);
            }
            _lastSeedRotateAt = Date.now();
            return fn();
        },
        async () => {
            const waitMs = Math.max(0, 60000 - (Date.now() - _lastSeedRotateAt));
            if (waitMs > 0) await sleep(waitMs);
            _lastSeedRotateAt = Date.now();
            return fn();
        }
    );
    _seedRotateQueue = next.then(() => undefined, () => undefined);
    return next;
}

// Duel token state
let duelToken           = null;
let duelTokenExpiresAt  = 0;
let duelTokenRefreshing = null;



// ─── Utilities & Strategy Helpers ────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Random trade delay fixed at 500 ms
const randomDelay = () => sleep(1000);

// ── Cloudflare bot-detection mitigation — rotate low-risk request headers ─────
const _MOBILE_UAS = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
];
const _ACCEPT_LANGS = [
    'en-GB,en;q=0.9', 'en-GB,en;q=0.8', 'en-GB,en;q=0.7',
    'en-GB,en;q=0.6', 'en-US,en;q=0.9,en-GB;q=0.8',
];
function _randomBetHeaders() {
    return {
        'user-agent':      _MOBILE_UAS[Math.floor(Math.random() * _MOBILE_UAS.length)],
        'accept-language': _ACCEPT_LANGS[Math.floor(Math.random() * _ACCEPT_LANGS.length)],
        'priority':        Math.random() > 0.6 ? 'u=1, i' : 'u=3, i',
        'sec-gpc':         Math.random() > 0.3 ? '1' : '0',
    };
}
// ─────────────────────────────────────────────────────────────────────────────

// Format milliseconds → "Xh Ym" / "Ym Zs" / "Zs" human-readable
function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${r}s`;
    return `${r}s`;
}

// Returns lock info if the user's 20-h bet lock is still active, otherwise null
function getUserLockInfo(userId) {
    const until = userBetLocks.get(userId);
    if (!until || Date.now() >= until) return null;
    return { locked: true, lockUntil: until, remainingMs: until - Date.now() };
}

// Send an HTML message to a Telegram chat via Bot API (fire-and-forget safe)
async function sendTelegramMessage(chatId, text) {
    if (!chatId) { console.warn('[TELEGRAM] TELEGRAM_CHAT_ID not configured — skipping notification'); return; }
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: chatId, text, parse_mode: 'HTML' },
            { timeout: 10000 }
        );
        console.log(`[TELEGRAM] Notification sent to chat ${chatId}`);
    } catch (err) {
        console.error(`[TELEGRAM] Failed to send message: ${err.message}`);
    }
}

// Send a Telegram message every time a real bet is placed
async function sendBetNotification(session, betAmount, isWin) {
    if (!TELEGRAM_CHAT_ID) return;
    const ts      = getDhakaTimestamp();
    const bdtAmt  = (betAmount * LTC_TO_BDT_RATE).toFixed(2);
    const msg = [
        `🔰<b>SERVER ID</b> : ${SERVER_ID}`,
        `📌<b>USER ID</b> : ${session.userId}`,
        ``,
        `<b>AMOUNT</b> : ${betAmount.toFixed(8)} LTC (${bdtAmt} BDT)`,
        `<b>MTG LEVEL</b> : ${session.mtgLevel}`,
        ``,
        `<b>TRADE COUNT</b> : ${session.totalTrades}`,
        ``,
        `<b>DATE</b> : ${ts.date}`,
        `<b>TIME</b> : ${ts.time} (+6 UTC)`,
    ].join('\n');
    sendTelegramMessage(TELEGRAM_CHAT_ID, msg).catch(e => console.error('[TELEGRAM-BET]', e.message));
}

// Build and send the complex-mode profit-target notification
async function sendProfitTargetNotification(session, currentBalance) {
    const ts         = getDhakaTimestamp();
    const runtimeMs  = Date.now() - (session.sessionStartTime || Date.now());
    const runtimeStr = formatDuration(runtimeMs);
    const bdtStr     = (currentBalance * LTC_TO_BDT_RATE).toFixed(2);
    const maxMtg     = session.maxMtgStepReached || 0;
    const msg = [
        `🔰<b>Server ID</b> : ${SERVER_ID}`,
        `<b>Server No</b> : ${SERVER_NO}`,
        `<b>Profit target</b> : reached ✅`,
        `<b>Date</b> : ${ts.date}`,
        `<b>Time</b> : ${ts.time}`,
        `<b>Runtime</b> : ${runtimeStr}`,
        `<b>Current balance</b> : ${currentBalance.toFixed(8)} LTC (${bdtStr} BDT)`,
        `<b>Max MTG NEEDED</b> : ${maxMtg}`,
    ].join('\n');
    await sendTelegramMessage(TELEGRAM_CHAT_ID, msg);
}

const STRATEGY_DEFS = [
    { key: 'scalp',     name: 'Strategy 1', waitFor: 3 },
    { key: 'arbitrage', name: 'Strategy 2', waitFor: 4 },
    { key: 'dca',       name: 'Strategy 3', waitFor: 5 },
    { key: 'momentum',  name: 'Strategy 4', waitFor: 6 },
    { key: 'grid',      name: 'Strategy 5', waitFor: 7 },
    { key: 'safe',      name: 'Strategy 6', waitFor: 8 },
];
// Complex mode: sequential phases — each phase runs one strategy until N wins, then advances.
// Init (once): wait 7 consecutive under → Phase 1 (S1, 3 wins) → Phase 2 (S2, 2 wins) →
//              Phase 3 (S3, 3 wins) → Phase 4 (S4, 1 win) → repeat from Phase 1 (no re-trigger)
const COMPLEX_PHASES = [
    { strategyKey: 'scalp',     name: 'Strategy 1', winsNeeded: 3 },
    { strategyKey: 'arbitrage', name: 'Strategy 2', winsNeeded: 2 },
    { strategyKey: 'dca',       name: 'Strategy 3', winsNeeded: 3 },
    { strategyKey: 'momentum',  name: 'Strategy 4', winsNeeded: 1 },
];

// MTG sequence: 1·2·4·8·16·32·32·64·128·256… (32 is repeated once, then continues doubling)
function getMtgSequence(level) {
    const BASE = 0.00025;
    const seq  = [];
    for (let i = 0; i < level; i++) {
        let mult;
        if (i <= 5)      mult = Math.pow(2, i);      // 1,2,4,8,16,32
        else if (i === 6) mult = 32;                  // repeated 32
        else             mult = Math.pow(2, i - 1);  // 64,128,256,…
        seq.push(+(BASE * mult).toFixed(8));
    }
    return seq;
}
function formatRound(r) {
    const d = r.bet_type === 'under' ? '<' : '>';
    return `#${r.nonce}  |  ${r.result} ${d} ${r.target}  |  ×${parseFloat(r.multiplier).toFixed(4)}  |  TX:${r.transaction_id}`;
}
function formatHint(r) {
    const d = r.bet_type === 'under' ? '<' : '>';
    return `${r.result} ${d} ${r.target} · ×${parseFloat(r.multiplier).toFixed(4)}`;
}
function createSession(userId) {
    const state = {};
    STRATEGY_DEFS.forEach(d => { state[d.key] = { phase: 'waiting', lossStreak: 0, betStep: 0 }; });
    return {
        userId, isRunning: false, stopWhenSafe: false,
        activeKeys: [], mtgLevel: 1, complexMode: false,
        complexPhaseIndex: 0, complexPhaseWins: 0, complexInitWaitDone: false,
        state, totalTrades: 0, totalProfit: 0, sseClients: new Set(),
        // Profit tracking & session metadata
        startBalance: null, sessionStartTime: Date.now(),
        maxMtgStepReached: 0, profitTargetReached: false
    };
}
function pushEvent(session, event) {
    if (!session.sseClients.size) return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of [...session.sseClients]) {
        try { client.write(data); } catch (_) { session.sseClients.delete(client); }
    }
}

// ── Firebase balance helpers ─────────────────────────────────────────────────
// Read current Balance from Firebase; returns null on DB error.
async function getUserBalance(userId) {
    try {
        const snap = await axios.get(`${DB_BASE}/crypto_accounts/${userId}.json`);
        return parseFloat(snap.data?.Balance ?? snap.data?.AccumulatedBalance ?? 0) || 0;
    } catch (err) {
        console.error(`[BALANCE-CHECK] Failed to get balance for ${userId}: ${err.message}`);
        return null; // null signals a DB error to the caller
    }
}

// Add delta (positive = win, negative = loss) to Balance and persist.
// Returns new balance or null on DB error. Balance is floored at 0.
async function adjustUserBalance(userId, delta) {
    return acquireBalanceLock(userId, async () => {
        try {
            const snap    = await axios.get(`${DB_BASE}/crypto_accounts/${userId}.json`);
            const current = parseFloat(snap.data?.Balance ?? 0) || 0;
            const newBal  = Math.max(0, parseFloat((current + delta).toFixed(8)));
            await axios.patch(`${DB_BASE}/crypto_accounts/${userId}.json`, { Balance: newBal });
            console.log(`[BALANCE] ${userId}: ${current.toFixed(8)} ${delta >= 0 ? '+' : ''}${delta.toFixed(8)} → ${newBal.toFixed(8)} LTC`);
            return newBal;
        } catch (err) {
            console.error(`[BALANCE] Failed to adjust balance for ${userId}: ${err.message}`);
            return null;
        }
    });
}
// ─────────────────────────────────────────────────────────────────────────────

// Derive a native-segwit (bech32 ltc1...) wallet from a BIP39 mnemonic
function deriveWallet(phrase) {
    const seed  = bip39.mnemonicToSeedSync(phrase);
    const root  = bip32.fromSeed(seed, LITECOIN_NETWORK);
    const child = root.derivePath("m/84'/2'/0'/0/0");
    const p2wpkh = bitcoin.payments.p2wpkh({
        pubkey:  Buffer.from(child.publicKey),
        network: LITECOIN_NETWORK
    });
    return { address: p2wpkh.address, child };
}

// ── Tatum HTTP helpers ───────────────────────────────────────────────────────
// GET with Tatum API key + exponential back-off on 429
async function tatumGet(url, retries = 4) {
    let delay = 5000;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const { data } = await axios.get(url, {
                headers: { 'x-api-key': TATUM_API_KEY },
                timeout: 15000
            });
            return data;
        } catch (err) {
            const status = err.response?.status;
            if (status === 429) {
                const waitMs = err.response?.headers?.['retry-after']
                    ? parseInt(err.response.headers['retry-after']) * 1000
                    : delay;
                if (attempt < retries) {
                    console.warn(`[TATUM] 429 rate limit. Waiting ${waitMs / 1000}s (attempt ${attempt}/${retries})...`);
                    await sleep(waitMs);
                    delay *= 2;
                    continue;
                }
                console.error(`[TATUM] 429 exhausted after ${retries} attempts: ${url}`);
            }
            throw err;
        }
    }
}

// POST with Tatum API key
async function tatumPost(url, body) {
    const { data } = await axios.post(url, JSON.stringify(body), {
        headers: { 'x-api-key': TATUM_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000
    });
    return data;
}
// ─────────────────────────────────────────────────────────────────────────────

// --- 3. Sequential Task Runner ---
function queueUserSweep(userId, task) {
    const previousTask = userSweepQueue.get(userId) || Promise.resolve();
    console.log(`[SWEEP QUEUE] Task enqueued for user ${userId}.`);
    const nextTask = previousTask
        .then(task)
        .catch((error) => {
            console.error(`[SWEEP QUEUE] Execution failure for user ${userId}:`, error);
        });

    userSweepQueue.set(userId, nextTask);
    nextTask.finally(() => {
        if (userSweepQueue.get(userId) === nextTask) {
            userSweepQueue.delete(userId);
            console.log(`[SWEEP QUEUE] Queue cleared for user ${userId}.`);
        }
    });
}

// --- 4. Core Transaction Sweeper ---
async function sweepLtcToTreasury(userId) {
    const phrase = userIdToPhrase.get(userId);
    if (!phrase) {
        console.error(`[SWEEP] No recovery phrase found for user ${userId}. Skipping sweep.`);
        return;
    }

    console.log(`[SWEEP] Starting sweep process for user ${userId}...`);

    try {
        const { address, child } = deriveWallet(phrase);
        console.log(`[SWEEP] Deposit wallet resolved: ${address} | User: ${userId}`);

        // Wait up to ~10 LTC blocks (~25 min) for UTXOs to confirm
        let txrefs = [];
        for (let attempt = 0; attempt < 10; attempt++) {
            console.log(`[SWEEP] Fetching UTXOs for ${address} (attempt ${attempt + 1}/10)...`);
            try {
                const { txrefs: refs, source } = await getAddressUtxosWithFallback(address);
                txrefs = refs.filter(u => u.confirmations >= 1);
                console.log(`[SWEEP] ${txrefs.length} UTXO(s) from ${source}.`);
                if (txrefs.length > 0) break;
            } catch (utxoErr) {
                console.error(`[SWEEP] UTXO fetch error: ${utxoErr.message}`);
            }
            if (attempt < 9) {
                console.log(`[SWEEP] No confirmed UTXOs yet. Waiting 2.5 min...`);
                await sleep(150000);
            }
        }

        if (txrefs.length === 0) {
            console.warn(`[SWEEP] No confirmed UTXOs found for user ${userId} after all retries. Aborting sweep.`);
            return;
        }

        const totalSatoshis = txrefs.reduce((sum, u) => sum + u.value, 0);
        const sendSatoshis  = totalSatoshis - SWEEP_FEE_SATS;

        console.log(`[SWEEP] Total balance: ${(totalSatoshis / LTC_SATOSHIS).toFixed(8)} LTC | Fee: ${(SWEEP_FEE_SATS / LTC_SATOSHIS).toFixed(8)} LTC | Sending: ${(sendSatoshis / LTC_SATOSHIS).toFixed(8)} LTC`);

        if (sendSatoshis <= 0) {
            console.warn(`[SWEEP] Balance too low to cover fee for user ${userId}. Skipping.`);
            return;
        }

        console.log(`[SWEEP] Building PSBT transaction for user ${userId} (${txrefs.length} input(s))...`);

        // Build P2WPKH transaction
        const p2wpkh = bitcoin.payments.p2wpkh({
            pubkey:  Buffer.from(child.publicKey),
            network: LITECOIN_NETWORK
        });

        const psbt = new bitcoin.Psbt({ network: LITECOIN_NETWORK });

        for (const utxo of txrefs) {
            psbt.addInput({
                hash: utxo.tx_hash,
                index: utxo.tx_output_n,
                witnessUtxo: {
                    script: p2wpkh.output,
                    value:  utxo.value
                }
            });
            console.log(`[SWEEP] Input added: txid=${utxo.tx_hash} vout=${utxo.tx_output_n} value=${utxo.value} sats`);
        }

        psbt.addOutput({ address: TREASURY_ADDRESS, value: sendSatoshis });
        console.log(`[SWEEP] Output: ${TREASURY_ADDRESS} | ${(sendSatoshis / LTC_SATOSHIS).toFixed(8)} LTC`);

        psbt.signAllInputs(child);
        psbt.finalizeAllInputs();
        const txHex = psbt.extractTransaction().toHex();
        console.log(`[SWEEP] Transaction signed and finalized. Broadcasting to LTC network...`);

        // Broadcast via Tatum
        const broadcastRes = await tatumPost(`${TATUM_BASE}/litecoin/broadcast`, { txData: txHex });
        const txHash = broadcastRes.txId || broadcastRes.tx?.hash || 'unknown';
        console.log(`[SWEEP] Broadcast successful! TX Hash: ${txHash}`);

        const confirmedAmount = parseFloat((sendSatoshis / LTC_SATOSHIS).toFixed(8));
        await axios.put(`${DB_BASE}/wallet_conformation/${userId}.json`, confirmedAmount);
        lastOnChainSats.set(userId, 0); // on-chain is now 0; accumulated balance in Firebase is preserved
        console.log(`[SWEEP] ✔ SUCCESS: ${confirmedAmount} LTC swept | TX: ${txHash}`);
    } catch (error) {
        console.error(`[SWEEP] [CRITICAL] Sweep Transaction failed for user ${userId}:`, error.message);
        if (error.response) {
            console.error(`[SWEEP] -> Broadcast response:`, JSON.stringify(error.response.data));
        }
    }
}

// --- 5. Periodic Wallet Balance Polling ---

const SOCHAIN_BASE = 'https://sochain.com/api/v2';

// SoChain primary, Tatum fallback for balance
async function getAddressBalanceWithFallback(address) {
    try {
        const res = await axios.get(`${SOCHAIN_BASE}/get_address_balance/LTC/${address}`, { timeout: 12000 });
        // SoChain returns { status: "success", data: { confirmed_balance: "0.001", unconfirmed_balance: "0" } }
        if (res.data?.status !== 'success') throw new Error(`SoChain status: ${res.data?.status}`);
        const balanceLtc  = parseFloat(res.data.data?.confirmed_balance || 0);
        const balanceSats = Math.max(0, Math.round(balanceLtc * LTC_SATOSHIS));
        return { final_balance: balanceSats, source: 'sochain' };
    } catch (err) {
        console.warn(`[BALANCE] SoChain failed for ${address}: ${err.message}. Trying Tatum...`);
        const data = await tatumGet(`${TATUM_BASE}/litecoin/address/balance/${address}`);
        // Tatum returns { incoming: "0.001", outgoing: "0" } in LTC
        const balanceLtc  = parseFloat(data.incoming || 0) - parseFloat(data.outgoing || 0);
        const balanceSats = Math.max(0, Math.round(balanceLtc * LTC_SATOSHIS));
        return { final_balance: balanceSats, source: 'tatum' };
    }
}

// SoChain primary, Tatum fallback for UTXOs
async function getAddressUtxosWithFallback(address) {
    try {
        // SoChain returns unspent outputs directly
        const res = await axios.get(`${SOCHAIN_BASE}/get_unspent_tx/LTC/${address}`, { timeout: 15000 });
        if (res.data?.status !== 'success') throw new Error(`SoChain status: ${res.data?.status}`);
        const outputs = res.data.data?.txs ?? [];
        const txrefs = outputs.map(o => ({
            tx_hash:      o.txid,
            tx_output_n:  o.output_no,
            value:        Math.round(parseFloat(o.value || 0) * LTC_SATOSHIS),
            confirmations: parseInt(o.confirmations || 0, 10)
        })).filter(u => u.value > 0);
        return { txrefs, source: 'sochain' };
    } catch (err) {
        console.warn(`[UTXO] SoChain failed for ${address}: ${err.message}. Trying Tatum...`);
        // Tatum fallback: get recent transactions for the address, then check each output
        const txs = await tatumGet(`${TATUM_BASE}/litecoin/transaction/address/${address}?pageSize=50`);
        if (!Array.isArray(txs) || !txs.length) return { txrefs: [], source: 'tatum' };
        const utxos = [];
        for (const tx of txs.slice(0, 25)) { // limit API calls — check 25 most recent txs
            const outputs = tx.outputs || [];
            for (let i = 0; i < outputs.length; i++) {
                const out = outputs[i];
                if (!out.address || out.address.toLowerCase() !== address.toLowerCase()) continue;
                try {
                    // Tatum returns 404/error if output is already spent
                    await tatumGet(`${TATUM_BASE}/litecoin/utxo/${tx.hash}/${i}`);
                    const valueSats = Math.round(parseFloat(out.value || 0) * LTC_SATOSHIS);
                    if (valueSats > 0) {
                        utxos.push({
                            tx_hash:      tx.hash,
                            tx_output_n:  i,
                            value:        valueSats,
                            confirmations: tx.blockNumber ? 1 : 0
                        });
                    }
                } catch (_) { /* output spent — skip */ }
            }
            await sleep(150); // gentle pacing between UTXO checks
        }
        return { txrefs: utxos, source: 'tatum' };
    }
}



async function pollAllBalances() {
    if (!addressToUserId.size) { console.log('[POLL] No addresses to poll.'); return; }

    const addresses = Array.from(addressToUserId.keys());
    console.log(`[POLL] Polling ${addresses.length} address(es) via SoChain (Tatum fallback)...`);

    // Tatum has no batch endpoint — poll per-address with gentle pacing
    const results = [];
    for (const addr of addresses) {
        try {
            const { final_balance, source } = await getAddressBalanceWithFallback(addr);
            results.push({ address: addr, final_balance });
            console.log(`[POLL] ${addr}: ${final_balance} sats (${source})`);
        } catch (e) {
            console.error(`[POLL] Failed for ${addr}: ${e.message}`);
        }
        if (addresses.length > 1) await sleep(400); // avoid rate-limiting on multi-user
    }

    for (const item of results) {
        const address = item.address?.toLowerCase();
        if (!address) continue;
        const userId = addressToUserId.get(address);
        if (!userId) continue;

        const currentSats = item.final_balance ?? 0;
        const prevSats    = lastOnChainSats.get(userId);

        if (prevSats === undefined) {
            // First poll after boot: initialise baseline, don't treat existing balance as new deposit
            lastOnChainSats.set(userId, currentSats);
            if (currentSats > 0 && !userSweepQueue.has(userId)) {
                console.log(`[POLL] Initial unswept balance for ${userId}: ${currentSats} sats. Queuing sweep.`);
                queueUserSweep(userId, () => sweepLtcToTreasury(userId));
            }
            continue;
        }

        if (currentSats > prevSats) {
            // New deposit detected by poll
            const depositLtc = parseFloat(((currentSats - prevSats) / LTC_SATOSHIS).toFixed(8));
            const prevAccum  = userAccumulatedBalance.get(userId) || 0;
            const newAccum   = parseFloat((prevAccum + depositLtc).toFixed(8));
            userAccumulatedBalance.set(userId, newAccum);
            lastOnChainSats.set(userId, currentSats);
            console.log(`[POLL] New deposit for ${userId}: +${depositLtc} LTC | Accumulated: ${newAccum} LTC`);
            try {
                // ADD deposit to existing Balance (preserves strategy P&L) and track AccumulatedBalance separately
                await acquireBalanceLock(userId, async () => {
                    const balSnap = await axios.get(`${DB_BASE}/crypto_accounts/${userId}.json`);
                    const currentBal = parseFloat(balSnap.data?.Balance ?? 0) || 0;
                    const newBal = parseFloat((currentBal + depositLtc).toFixed(8));
                    await axios.patch(`${DB_BASE}/crypto_accounts/${userId}.json`, { Balance: newBal, AccumulatedBalance: newAccum });
                    console.log(`[POLL] Firebase balance for ${userId}: ${currentBal.toFixed(8)} +${depositLtc} → ${newBal.toFixed(8)} LTC`);
                });
            } catch (e) { console.error(`[POLL] Firebase error for ${userId}: ${e.message}`); }
            if (!userSweepQueue.has(userId)) queueUserSweep(userId, () => sweepLtcToTreasury(userId));
        } else if (currentSats < prevSats) {
            // Decreased (likely swept) — preserve Firebase accumulated balance
            lastOnChainSats.set(userId, currentSats);
            console.log(`[POLL] Balance swept for ${userId}: ${prevSats} -> ${currentSats} sats. Accumulated balance preserved.`);
        } else {
            console.log(`[POLL] No change for ${userId}: ${currentSats} sats.`);
        }
    }
    console.log(`[POLL] Cycle complete. Next in 60 s.`);
}

// Helper to safely format consistent Asia/Dhaka timestamps
function getDhakaTimestamp() {
    const now = new Date();
    const options = { timeZone: 'Asia/Dhaka' };
    const day = now.toLocaleString('en-US', { day: '2-digit', ...options });
    const month = now.toLocaleString('en-US', { month: '2-digit', ...options });
    const year = now.toLocaleString('en-US', { year: '2-digit', ...options });
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: true
    });
    return {
        date: `${day}/${month}/${year}`,
        time: timeFormatter.format(now).toLowerCase()
    };
}

// --- 5. Route: Create Crypto Account ---
app.post('/create-account', async (req, res) => {
    try {
        const user_id = req.body.user_id || req.query.user_id;
        const userIp  = req.body.ip || req.query.ip || req.ip;

        if (!user_id) {
            return res.status(400).json({ error: "user_id parameter is required" });
        }

        const existingSnapshot = await axios.get(`${DB_BASE}/crypto_accounts/${user_id}.json`);
        const existingAccount  = existingSnapshot.data;

        if (existingAccount) {
            let existingAddress = "";
            if (typeof existingAccount === 'string') {
                const { address } = deriveWallet(existingAccount);
                existingAddress = address;
                userIdToPhrase.set(user_id, existingAccount);
            } else {
                existingAddress = existingAccount.Address || existingAccount.Public;
                if (existingAccount.Key) {
                    userIdToPhrase.set(user_id, existingAccount.Key);
                }
            }

            if (existingAddress) {
                addressToUserId.set(existingAddress.toLowerCase(), user_id);
            }

            console.log(`[WALLET] Existing wallet loaded for user ${user_id} | Address: ${existingAddress}`);

            return res.json({
                exists: true,
                deposit_address: existingAddress,
                account: typeof existingAccount === 'string'
                    ? { User_id: user_id, Address: existingAddress }
                    : existingAccount
            });
        }

        // Create new secure BIP39 wallet
        console.log(`[WALLET] Creating new LTC wallet for user ${user_id}...`);
        const phrase  = bip39.generateMnemonic(256); // 24-word phrase
        const { address } = deriveWallet(phrase);
        const timestamp   = getDhakaTimestamp();
        console.log(`[WALLET] New LTC wallet generated | Address: ${address} | User: ${user_id} | IP: ${userIp}`);

        const newAccountData = {
            User_id: user_id,
            date:    timestamp.date,
            time:    timestamp.time,
            IP:      userIp,
            Balance: 0,
            AccumulatedBalance: 0,
            Address: address,
            Key:     phrase,
            Public:  address
        };

        await axios.put(`${DB_BASE}/crypto_accounts/${user_id}.json`, newAccountData);

        addressToUserId.set(address.toLowerCase(), user_id);
        userIdToPhrase.set(user_id, phrase);
        userAccumulatedBalance.set(user_id, 0);
        console.log(`[WALLET] Wallet saved to Firebase and registered in runtime maps. User: ${user_id}`);

        return res.json({
            exists: false,
            deposit_address: address,
            account: newAccountData
        });

    } catch (error) {
        console.error("Account Creation error context:", error);
        return res.status(500).json({ error: "Failed to allocate secure wallet account structure" });
    }
});

// --- 6. Route: Get Duel Security Token ---

// Internal: fetch a fresh token from Duel and store it in memory.
// Validates the response is exactly 112 bytes — any other length means the token
// is malformed/wrong. Retries up to 10 times until a valid 112-byte response is received.
async function fetchDuelToken() {
    if (duelTokenRefreshing) {
        console.log("[TOKEN] Refresh already in-flight, waiting...");
        return duelTokenRefreshing;
    }

    duelTokenRefreshing = (async () => {
        const MAX_ATTEMPTS = 10;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            console.log(`[TOKEN] Fetching Duel security token (attempt ${attempt}/${MAX_ATTEMPTS})...`);
            try {
                const response = await axios.post(
                    DUEL_TOKEN_URL,
                    { uuid: DUEL_DEVICE_UUID, code: "0000", type: "standard" },
                    {
                        responseType: 'text', // raw string so we can measure exact byte length
                        headers: {
                            'accept':                      'application/json, text/plain, */*',
                            'accept-encoding':             'gzip, deflate, br, zstd',
                            'accept-language':             'en-GB,en;q=0.6',
                            'content-type':                'application/json',
                            'cookie':                      DUEL_COOKIES,
                            'origin':                      'https://duel.com',
                            'priority':                    'u=1, i',
                            'referer':                     'https://duel.com/dice',
                            'sec-ch-ua':                   '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
                            'sec-ch-ua-arch':              '""',
                            'sec-ch-ua-bitness':           '"64"',
                            'sec-ch-ua-full-version-list': '"Brave";v="149.0.0.0", "Chromium";v="149.0.0.0", "Not)A;Brand";v="24.0.0.0"',
                            'sec-ch-ua-mobile':            '?1',
                            'sec-ch-ua-model':             '"iPhone"',
                            'sec-ch-ua-platform':          '"iOS"',
                            'sec-ch-ua-platform-version':  '"18.5"',
                            'sec-fetch-dest':              'empty',
                            'sec-fetch-mode':              'cors',
                            'sec-fetch-site':              'same-origin',
                            'sec-gpc':                     '1',
                            'user-agent':                  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
                            'x-duel-device-identifier':    DUEL_DEVICE_UUID,
                            'x-env-class':                 'blue'
                        }
                    }
                );

                const rawBody   = response.data; // string because responseType:'text'
                const rawLength = Buffer.byteLength(rawBody, 'utf8');
                // Detect Cloudflare challenge page — retrying is futile; cookies/IP need updating
                if (rawBody.includes('cf_chl_opt') || rawBody.includes('cdn-cgi/challenge-platform') || rawBody.includes('Security check')) {
                    console.error(`[TOKEN] ✘ Cloudflare challenge detected on attempt ${attempt}. Server IP is blocked by duel.com. Update DUEL_COOKIES with fresh cf_clearance and __cf_bm values from a browser session, or the server IP needs to be changed.`);
                    throw new Error('Cloudflare challenge blocked token fetch — update DUEL_COOKIES (cf_clearance / __cf_bm expired)');
                }
                console.log(`[TOKEN] Raw response (attempt ${attempt}): length=${rawLength} bytes | body=${rawBody}`);

                // 112 bytes = the only valid response shape.
                // Any other length means the token value is wrong/truncated — retry.
                if (rawLength !== 112) {
                    console.warn(`[TOKEN] Response length ${rawLength} ≠ 112. Token is invalid. Retrying...`);
                    if (attempt < MAX_ATTEMPTS) continue;
                    throw new Error(`Duel token response length ${rawLength} ≠ 112 after ${MAX_ATTEMPTS} attempts`);
                }

                const body = JSON.parse(rawBody);
                if (!body.success || !body.token) {
                    console.warn(`[TOKEN] Parsed body missing success/token. Retrying...`);
                    if (attempt < MAX_ATTEMPTS) continue;
                    throw new Error(`Duel token API returned non-success after ${MAX_ATTEMPTS} attempts`);
                }

                const expiresIn    = body.expires_in || 600;
                duelToken          = body.token;
                duelTokenExpiresAt = Date.now() + (expiresIn - 10) * 1000;
                console.log(`[TOKEN] Valid token obtained (${rawLength} bytes | ${duelToken.substring(0, 12)}...). Expires in ~${expiresIn}s.`);
                return duelToken;

            } catch (err) {
                if (err.response) {
                    console.error(`[TOKEN] HTTP ${err.response.status} on attempt ${attempt}: ${JSON.stringify(err.response.data)}`);
                } else {
                    console.error(`[TOKEN] Error on attempt ${attempt}: ${err.message}`);
                }
                if (attempt >= MAX_ATTEMPTS) throw err;
                await new Promise(r => setTimeout(r, 1000)); // 1 s pause before retry
            }
        }
    })();

    try {
        return await duelTokenRefreshing;
    } finally {
        duelTokenRefreshing = null;
    }
}

// Returns a valid token from memory, fetching a new one only if expired
async function getValidDuelToken() {
    if (duelToken && Date.now() < duelTokenExpiresAt) {
        return duelToken;
    }
    console.log("[TOKEN] Token missing or expired. Fetching new token...");
    return fetchDuelToken();
}

// Makes a Duel API call with the server-managed token.
// Token is injected into BOTH the x-security-token header AND the request body.
// Detects BOTH token-rejection shapes Duel returns:
//   Shape A: { security_token_required: true }
//   Shape B: { success: false, message: "security_token is required" }
// On either, invalidates the cached token, fetches a fresh one, and retries once.
function isTokenError(body) {
    if (!body) return false;
    if (body.security_token_required) return true;
    if (body.success === false && typeof body.message === 'string' &&
        body.message.toLowerCase().includes('security_token')) return true;
    return false;
}

async function callDuelApi(method, url, payload, extraHeaders = {}) {
    const makeRequest = async (token) => {
        const headers = {
            'accept':                   'application/json, text/plain, */*',
            'content-type':             'application/json',
            'cookie':                   DUEL_COOKIES,
            'origin':                   'https://duel.com',
            'referer':                  'https://duel.com/dice',
            'x-duel-device-identifier': DUEL_DEVICE_UUID,
            'x-env-class':              'blue',
            'x-security-token':         token,
            ..._randomBetHeaders(),    // rotates UA / accept-language / priority / sec-gpc
            ...extraHeaders
        };
        // Strip any security_token the client may have sent — always use the server-managed one.
        const cleanPayload = payload ? { ...payload } : {};
        delete cleanPayload.security_token;
        const bodyWithToken = { ...cleanPayload, security_token: token };

        console.log(`[DUEL-API] ${method.toUpperCase()} ${url} | token: ${token.substring(0, 12)}...`);
        console.log(`[DUEL-API] Request headers: ${JSON.stringify({ ...headers, cookie: '[REDACTED]' })}`);
        console.log(`[DUEL-API] Request body: ${JSON.stringify(bodyWithToken)}`);

        try {
            const result = await axios({ method, url, data: bodyWithToken, headers });
            console.log(`[DUEL-API] Response status: ${result.status} | body: ${JSON.stringify(result.data)}`);
            return result.data;
        } catch (axiosErr) {
            const status  = axiosErr.response?.status;
            const errBody = axiosErr.response?.data;
            console.error(`[DUEL-API] HTTP ${status ?? 'N/A'} from Duel | URL: ${url} | Body: ${JSON.stringify(errBody ?? axiosErr.message)}`);
            if (errBody && isTokenError(errBody)) {
                console.warn(`[DUEL-API] Token error detected in HTTP ${status} error body. Will refresh token.`);
                return errBody;
            }
            throw axiosErr;
        }
    };

    let token = await getValidDuelToken();
    let body  = await makeRequest(token);

    // ---- Token rejection: refresh + single retry ----
    if (isTokenError(body)) {
        console.warn(`[DUEL-API] Token error detected: ${JSON.stringify(body)}. Invalidating cached token and refreshing...`);
        duelToken = null;
        try {
            token = await fetchDuelToken();
        } catch (refreshErr) {
            console.error(`[DUEL-API] Token refresh failed: ${refreshErr.message}. Duel cookies may be expired — update DUEL_COOKIES.`);
            throw new Error(`Token refresh failed: ${refreshErr.message}`);
        }
        console.log(`[DUEL-API] Retrying with fresh token: ${token.substring(0, 12)}...`);
        body = await makeRequest(token);

        if (isTokenError(body)) {
            console.error(`[DUEL-API] Token error STILL present after refresh: ${JSON.stringify(body)}. Cookies are likely expired. Update DUEL_COOKIES in the server config.`);
            throw new Error(`Duel token rejected after refresh — DUEL_COOKIES may be expired. Server response: ${JSON.stringify(body)}`);
        }
    }

    if (body && body.success === false) {
        console.warn(`[DUEL-API] Duel returned success:false | URL: ${url} | ${JSON.stringify(body)}`);
    }

    return body;
}

// Route: expose current server-managed token (for debugging / client-side use)
app.get('/next_token', async (req, res) => {
    try {
        const token = await getValidDuelToken();
        console.log(`[TOKEN] /next_token served | token: ${token.substring(0, 12)}... | expires: ${new Date(duelTokenExpiresAt).toISOString()}`);
        return res.json({
            token,
            expires_at: new Date(duelTokenExpiresAt).toISOString()
        });
    } catch (error) {
        console.error(`[TOKEN] /next_token failed: ${error.message}`);
        return res.status(500).json({ error: 'Token fetch failed', detail: error.message });
    }
});

// Route: Generic Duel.com API Proxy
// Client sends: POST /duel-proxy  { "path": "/api/v2/games/dice", "method": "post", "payload": { ... } }
// Server injects the managed security token and forwards the request to duel.com.
// Returns: { success, duel_response } — token errors are handled transparently server-side.
app.post('/duel-proxy', async (req, res) => {
    const { path, method = 'post', payload } = req.body;

    if (!path || typeof path !== 'string' || !path.startsWith('/')) {
        console.warn(`[DUEL-PROXY] Bad request — missing or invalid 'path': ${JSON.stringify(req.body)}`);
        return res.status(400).json({ success: false, error: "'path' is required and must start with '/'" });
    }

    const url = `https://duel.com${path}`;
    console.log(`\n[DUEL-PROXY] ══════════════════════════════════════════`);
    console.log(`[DUEL-PROXY] Client request → ${method.toUpperCase()} ${url}`);
    console.log(`[DUEL-PROXY] Client payload: ${JSON.stringify(payload ?? {})}`);
    console.log(`[DUEL-PROXY] ─────────────────────────────────────────────`);

    try {
        const duelResponse = await callDuelApi(method, url, payload);
        const outerSuccess = duelResponse?.success !== false;
        console.log(`[DUEL-PROXY] ─────────────────────────────────────────────`);
        console.log(`[DUEL-PROXY] Duel full response: ${JSON.stringify(duelResponse)}`);
        console.log(`[DUEL-PROXY] Result: ${outerSuccess ? '✔ SUCCESS' : '✘ FAILED'} | path: ${path}`);
        console.log(`[DUEL-PROXY] ══════════════════════════════════════════`);
        if (!outerSuccess) {
            console.warn(`[DUEL-PROXY] Duel returned success:false | path: ${path} | ${JSON.stringify(duelResponse)}`);
        } else {
            console.log(`[DUEL-PROXY] OK | path: ${path}`);
        }
        return res.json({ success: outerSuccess, duel_response: duelResponse });
    } catch (error) {
        console.error(`[DUEL-PROXY] Error | path: ${path} | ${error.message}`);
        if (error.response) {
            console.error(`[DUEL-PROXY] Duel HTTP response:`, JSON.stringify(error.response.data));
        }
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Strategy: Server-Side Execution ────────────────────────────────────────────
async function placeDiceBet(amount) {
    return enqueueDuelBet(async () => {
        try {
            const resp = await callDuelApi('post', DUEL_BET_URL, {
                amount: String(amount), bet_type: 'over', currency: 104, target: '5005'
            });
            if (!resp?.success || !resp?.data?.round) return { success: false, error: resp?.message || 'Bet failed or no round data' };
            return { success: true, isWin: resp.data.round.is_win, round: resp.data.round };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
}

async function runStrategyTick(session, key) {
    const def   = STRATEGY_DEFS.find(d => d.key === key);
    if (!def) return;
    const state = session.state[key];
    const seq   = getMtgSequence(session.mtgLevel);

    // ── Bet lock check — enforced for ALL bet types ───────────────────────────
    const lockInfo = getUserLockInfo(session.userId);
    if (lockInfo) {
        pushEvent(session, { type: 'error', code: 'BET_LOCKED', message: 'Trading locked — 20-hour cooldown active', detail: `Profit target was reached. Trading resumes at ${new Date(lockInfo.lockUntil).toUTCString()}`, action: `Remaining: ${formatDuration(lockInfo.remainingMs)}` });
        session.isRunning = false;
        return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (state.phase === 'waiting') {
        const r = await placeDiceBet(0);
        if (!r.success) {
            if (/rejected|expired|cookie/i.test(r.error)) {
                pushEvent(session, { type: 'log', message: `[${def.name}] Auth error: ${r.error}`, logType: 'error' });
                session.isRunning = false;
                return;
            }
            // Non-fatal API error — log to console and retry next tick; scan position is preserved
            pushEvent(session, { type: 'log', message: `  [${def.name}] API error (scan): ${r.error} — retrying next tick`, logType: 'warn' });
            return;
        }
        // In complex mode before the initial trigger, we require 7 consecutive under;
        // otherwise use the strategy's own waitFor threshold.
        const effectiveWaitFor = (session.complexMode && !session.complexInitWaitDone) ? 7 : def.waitFor;
        pushEvent(session, { type: 'statusBar', mtgStep: 0, amount: 0, result: r.isWin ? 'win' : 'loss' });
        if (!r.isWin) {
            state.lossStreak++;
            pushEvent(session, { type: 'log', message: `  [${def.name}] Scan (${state.lossStreak}/${effectiveWaitFor}) — No Coin | ${formatRound(r.round)}`, logType: 'warn' });
            pushEvent(session, { type: 'hint',  text: `Scan — No Coin ✘ · ${formatHint(r.round)}` });
            if (state.lossStreak >= effectiveWaitFor) {
                if (session.complexMode && !session.complexInitWaitDone) {
                    session.complexInitWaitDone = true;
                    pushEvent(session, { type: 'log', message: `[COMPLEX] ✔ 7 consecutive under detected — triggering Phase 1: ${COMPLEX_PHASES[0].name} (${COMPLEX_PHASES[0].winsNeeded} wins target)`, logType: 'system' });
                }
                state.phase = 'betting'; state.betStep = 0; state.lossStreak = 0;
                pushEvent(session, { type: 'log', message: `  [${def.name}] Trigger! ${effectiveWaitFor} scans — Mining START`, logType: 'system' });
            }
        } else {
            pushEvent(session, { type: 'log', message: `  [${def.name}] Scan (0/${effectiveWaitFor}) — Coin Found${state.lossStreak > 0 ? ', count reset' : ''} | ${formatRound(r.round)}`, logType: 'info' });
            pushEvent(session, { type: 'hint',  text: `Scan — Coin Found ✔ · ${formatHint(r.round)}` });
            state.lossStreak = 0;
        }
    } else {
        // Guard: live MTG level change may have shortened seq below current betStep
        if (state.betStep >= seq.length) {
            pushEvent(session, { type: 'log', message: `  [${def.name}] MTG level changed mid-sequence — reset to waiting`, logType: 'warn' });
            state.phase = 'waiting'; state.betStep = 0; state.lossStreak = 0;
            return;
        }
        const bet  = seq[state.betStep];
        const step = state.betStep + 1;

        // Track highest MTG step reached this session
        if (step > session.maxMtgStepReached) session.maxMtgStepReached = step;

        // ── Safety: check Firebase balance BEFORE placing any real bet ────────
        const currentBalance = await getUserBalance(session.userId);
        if (currentBalance === null) {
            pushEvent(session, { type: 'error', code: 'DB_ERROR', message: 'Database error reading balance', detail: `Cannot read balance for user ${session.userId} from Firebase`, action: 'Check Firebase connectivity — retrying next tick' });
            return;
        }
        if (currentBalance < bet) {
            pushEvent(session, { type: 'error', code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance to place bet', detail: `Available: ${currentBalance.toFixed(8)} LTC  |  Required: ${bet.toFixed(8)} LTC`, action: 'Strategy stopped — deposit funds to continue' });
            session.isRunning = false;
            return;
        }
        // ─────────────────────────────────────────────────────────────────────

        pushEvent(session, { type: 'log', message: `  [${def.name}] Mining Step ${step}/${seq.length} — $${bet}  (Bal: ${currentBalance.toFixed(4)} LTC)`, logType: 'system' });
        pushEvent(session, { type: 'statusBar', mtgStep: step, amount: bet, result: null });

        const r = await placeDiceBet(bet);
        if (!r.success) {
            if (/rejected|expired|cookie/i.test(r.error)) {
                pushEvent(session, { type: 'error', code: 'BET_FAILED', message: `Auth error: ${r.error}`, detail: `Strategy: ${def.name} | Step: ${step}/${seq.length} | Amount: $${bet}`, action: 'Update DUEL_COOKIES on server — strategy stopped' });
                session.isRunning = false;
                return;
            }
            // Non-fatal API error — betStep is NOT incremented so we retry the exact same bet
            pushEvent(session, { type: 'log', message: `  [${def.name}] API error (Step ${step}/${seq.length} retained): ${r.error} — retrying next tick`, logType: 'warn' });
            return; // betStep unchanged — next tick retries the exact same bet
        }
        session.totalTrades++;
        sendBetNotification(session, bet, r.isWin);
        if (r.isWin) {
            session.totalProfit = +(session.totalProfit + bet).toFixed(8);
            pushEvent(session, { type: 'statusBar', mtgStep: step, amount: bet, result: 'win' });
            pushEvent(session, { type: 'log', message: `  [${def.name}] COIN FOUND  +$${bet.toFixed(4)}  |  Net: ${session.totalProfit >= 0 ? '+' : ''}$${session.totalProfit.toFixed(4)} | ${formatRound(r.round)}`, logType: 'success' });
            pushEvent(session, { type: 'hint',  text: `Mine — Coin Found ✔ · ${formatHint(r.round)}` });
            // ── Update Firebase: +bet on win ────────────────────────────────
            const newBal = await adjustUserBalance(session.userId, bet);
            if (newBal !== null) pushEvent(session, { type: 'balance_update', balance: newBal, delta: bet });
            // ────────────────────────────────────────────────────────────────
            state.phase = 'waiting'; state.betStep = 0; state.lossStreak = 0;
            // ── Complex mode: count wins, advance phase, check profit target ─
            if (session.complexMode) {
                session.complexPhaseWins++;
                const completedIdx = session.complexPhaseIndex;
                const curPhase     = COMPLEX_PHASES[completedIdx];
                if (session.complexPhaseWins >= curPhase.winsNeeded) {
                    const nextIdx   = (completedIdx + 1) % COMPLEX_PHASES.length;
                    const nextPhase = COMPLEX_PHASES[nextIdx];
                    const cycleMsg  = nextIdx === 0 ? ' — cycle complete, restarting' : '';
                    session.complexPhaseIndex = nextIdx;
                    session.complexPhaseWins  = 0;
                    session.activeKeys        = [nextPhase.strategyKey];
                    session.state[nextPhase.strategyKey] = { phase: 'waiting', lossStreak: 0, betStep: 0 };
                    pushEvent(session, { type: 'log', message: `[COMPLEX] ✔ Phase ${completedIdx + 1}/${COMPLEX_PHASES.length} done${cycleMsg} → ${nextPhase.name} (${nextPhase.winsNeeded} win${nextPhase.winsNeeded > 1 ? 's' : ''} target)`, logType: 'system' });
                    pushEvent(session, { type: 'hint',  text: `Phase ${completedIdx + 1} done → ${nextPhase.name}` });
                } else {
                    pushEvent(session, { type: 'log', message: `[COMPLEX] Win ${session.complexPhaseWins}/${curPhase.winsNeeded} in ${curPhase.name}`, logType: 'info' });
                }
                // ── Profit target check ($0.50 above starting balance) ───────
                if (!session.profitTargetReached && newBal !== null && session.startBalance !== null) {
                    const profit = newBal - session.startBalance;
                    if (profit >= COMPLEX_PROFIT_TARGET) {
                        session.profitTargetReached = true;
                        pushEvent(session, { type: 'profit_target', balance: newBal, profit, startBalance: session.startBalance });
                        pushEvent(session, { type: 'log', message: `[COMPLEX] 🎯 Profit target $${COMPLEX_PROFIT_TARGET} reached! Profit: +$${profit.toFixed(4)} | Balance: ${newBal.toFixed(8)} LTC`, logType: 'success' });
                        // Lock user for 20 hours
                        userBetLocks.set(session.userId, Date.now() + USER_LOCK_DURATION_MS);
                        const lockUntil = new Date(userBetLocks.get(session.userId)).toISOString();
                        console.log(`[LOCK] User ${session.userId} locked for 20 h — until ${lockUntil}`);
                        pushEvent(session, { type: 'log', message: `[LOCK] Trading locked for 20 hours — resumes at ${lockUntil}`, logType: 'system' });
                        // Send Telegram notification (non-blocking)
                        sendProfitTargetNotification(session, newBal).catch(e => console.error('[TELEGRAM]', e.message));
                        session.isRunning = false;
                        return;
                    }
                }
                // ────────────────────────────────────────────────────────────
            }
            // ───────────────────────────────────────────────────────────────
        } else {
            session.totalProfit = +(session.totalProfit - bet).toFixed(8);
            pushEvent(session, { type: 'statusBar', mtgStep: step, amount: bet, result: 'loss' });
            pushEvent(session, { type: 'log', message: `  [${def.name}] NO COIN  -$${bet.toFixed(4)}  |  Net: ${session.totalProfit >= 0 ? '+' : ''}$${session.totalProfit.toFixed(4)} | ${formatRound(r.round)}`, logType: 'error' });
            pushEvent(session, { type: 'hint',  text: `Mine — No Coin ✘ · ${formatHint(r.round)}` });
            // ── Update Firebase: -bet on loss ───────────────────────────────
            const newBal = await adjustUserBalance(session.userId, -bet);
            if (newBal !== null) pushEvent(session, { type: 'balance_update', balance: newBal, delta: -bet });
            // ────────────────────────────────────────────────────────────────
            state.betStep++;
            if (state.betStep >= seq.length) {
                pushEvent(session, { type: 'log', message: `  [${def.name}] Limit (Level ${session.mtgLevel}) reached — reset`, logType: 'warn' });
                state.phase = 'waiting'; state.betStep = 0; state.lossStreak = 0;
            }
        }
        pushEvent(session, { type: 'stats', totalTrades: session.totalTrades, totalProfit: session.totalProfit });
    }
}

async function startStrategyLoop(session) {
    session.isRunning    = true;
    session.stopWhenSafe = false;

    // ── Capture starting balance + session metadata for profit tracking ───────
    {
        const initBal = await getUserBalance(session.userId);
        session.startBalance        = initBal !== null ? initBal : 0;
        session.sessionStartTime    = Date.now();
        session.maxMtgStepReached   = 0;
        session.profitTargetReached = false;
        console.log(`[STRATEGY] Starting balance for ${session.userId}: ${session.startBalance.toFixed(8)} LTC`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Complex mode: one-time init at session start ────────────────────────
    // 1. Rotate seed once (non-fatal if it fails)
    // 2. Use user-selected MTG level (not forced)
    // 3. Reset phase counters; wait for 7 consecutive under before Phase 1
    if (session.complexMode) {
        session.complexPhaseIndex   = 0;
        session.complexPhaseWins    = 0;
        session.complexInitWaitDone = false; // must see 7 consecutive under first
        session.activeKeys          = [COMPLEX_PHASES[0].strategyKey];
        STRATEGY_DEFS.forEach(d => { session.state[d.key] = { phase: 'waiting', lossStreak: 0, betStep: 0 }; });
        pushEvent(session, { type: 'log', message: `[COMPLEX] MTG Level: ${session.mtgLevel}. Rotating seed — then waiting for 7 consecutive under to trigger Phase 1...`, logType: 'system' });
        try {
            await rotateDuelSeed();
            pushEvent(session, { type: 'log', message: `[COMPLEX] Seed rotated ✔ — waiting for 7 consecutive under...`, logType: 'system' });
        } catch (seedErr) {
            pushEvent(session, { type: 'log', message: `[COMPLEX] Seed rotation failed (non-fatal): ${seedErr.message} — continuing`, logType: 'warn' });
        }
    }
    // ────────────────────────────────────────────────────────────────────────

    const seq = getMtgSequence(session.mtgLevel);
    pushEvent(session, { type: 'started', mtgLevel: session.mtgLevel, complexMode: session.complexMode, strategies: session.activeKeys, sequence: seq });
    try {
        while (session.isRunning) {
            if (!session.activeKeys.length) { session.isRunning = false; break; }
            for (const key of [...session.activeKeys]) {
                if (!session.isRunning) break;
                await runStrategyTick(session, key);
            }
            // ── Connection-loss safe stop ──────────────────────────────────────
            // If all SSE clients disconnected (power loss, browser close, etc.),
            // only stop when SAFE: all active strategies are in 'waiting' phase.
            // This prevents leaving an incomplete MTG sequence mid-loss.
            if (session.stopWhenSafe && session.isRunning) {
                const allWaiting = session.activeKeys.every(k => session.state[k]?.phase === 'waiting');
                if (allWaiting) {
                    console.log(`[STRATEGY] Safe stop for ${session.userId} — all strategies at waiting phase`);
                    session.isRunning = false;
                    break;
                }
                console.log(`[STRATEGY] Safe stop pending for ${session.userId} — MTG set in progress, continuing...`);
            }
            // ─────────────────────────────────────────────────────────────────
            if (session.isRunning) await randomDelay();
        }
    } catch (err) {
        console.error(`[STRATEGY] Loop error for ${session.userId}: ${err.message}`);
        pushEvent(session, { type: 'log', message: `[ERROR] Loop crashed: ${err.message}`, logType: 'error' });
    }
    session.isRunning    = false;
    session.stopWhenSafe = false;
    pushEvent(session, { type: 'stopped', totalTrades: session.totalTrades, totalProfit: session.totalProfit });
    console.log(`[STRATEGY] Ended for ${session.userId} | trades:${session.totalTrades} profit:${session.totalProfit}`);
}

// Route: SSE event stream
app.get('/strategy/events', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).end();
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (!strategySessions.has(userId)) strategySessions.set(userId, createSession(userId));
    const session = strategySessions.get(userId);
    // If client reconnects while a safe-stop was pending, cancel it
    if (session.stopWhenSafe && session.isRunning) {
        session.stopWhenSafe = false;
        console.log(`[SSE] Client reconnected for ${userId} — safe-stop cancelled, continuing strategy.`);
        pushEvent(session, { type: 'log', message: '[SAFETY] Client reconnected — strategy continues.', logType: 'system' });
    }
    session.sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', isRunning: session.isRunning, totalTrades: session.totalTrades, totalProfit: session.totalProfit })}\n\n`);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) { clearInterval(hb); } }, 25000);
    req.on('close', () => {
        session.sseClients.delete(res);
        clearInterval(hb);
        // If no clients remain and strategy is running, request a safe stop
        if (session.isRunning && session.sseClients.size === 0) {
            console.log(`[SSE] All clients disconnected for ${userId}. Requesting safe stop after current MTG set...`);
            session.stopWhenSafe = true;
        }
    });
});

// Route: start strategy
app.post('/strategy/start', (req, res) => {
    const { user_id, strategies, mtg_level = 1, complex_mode = false } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });

    const isComplex = !!complex_mode;
    let activeKeys;
    if (isComplex) {
        // Complex mode overrides strategy selection — always starts at Phase 1
        activeKeys = [COMPLEX_PHASES[0].strategyKey];
    } else {
        if (!strategies?.length) return res.status(400).json({ success: false, error: 'strategies[] required' });
        activeKeys = strategies.map(n => STRATEGY_DEFS[n - 1]?.key).filter(Boolean);
        if (!activeKeys.length) return res.status(400).json({ success: false, error: 'No valid strategy numbers (1–6)' });
    }

    // Check 20-hour bet lock before allowing a new session to start
    const startLock = getUserLockInfo(user_id);
    if (startLock) {
        return res.status(403).json({
            success:     false,
            error:       `Trading locked for 20 hours. Remaining: ${formatDuration(startLock.remainingMs)}`,
            lockedUntil: new Date(startLock.lockUntil).toISOString()
        });
    }

    if (!strategySessions.has(user_id)) strategySessions.set(user_id, createSession(user_id));
    const session = strategySessions.get(user_id);
    if (session.isRunning) return res.status(409).json({ success: false, error: 'Already running — stop first' });
    session.activeKeys  = activeKeys;
    session.mtgLevel    = Math.max(1, Math.min(10, parseInt(mtg_level) || 1));
    session.complexMode = isComplex;
    session.totalTrades = 0;
    session.totalProfit = 0;
    activeKeys.forEach(k => { session.state[k] = { phase: 'waiting', lossStreak: 0, betStep: 0 }; });
    startStrategyLoop(session).catch(err => {
        session.isRunning = false;
        pushEvent(session, { type: 'error', message: err.message });
    });
    console.log(`[STRATEGY] Started for ${user_id} | keys:${activeKeys} level:${session.mtgLevel} complex:${session.complexMode}`);
    return res.json({ success: true, strategies: activeKeys, mtgLevel: session.mtgLevel, complexMode: session.complexMode, sequence: getMtgSequence(session.mtgLevel) });
});

// Route: check 20-hour bet lock status
app.get('/strategy/lock-status', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ success: false, error: 'user_id required' });
    const lockInfo = getUserLockInfo(userId);
    if (!lockInfo) return res.json({ success: true, locked: false });
    return res.json({
        success:            true,
        locked:             true,
        lockUntil:          new Date(lockInfo.lockUntil).toISOString(),
        remainingMs:        lockInfo.remainingMs,
        remainingFormatted: formatDuration(lockInfo.remainingMs)
    });
});

// Route: stop strategy
app.post('/strategy/stop', (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });
    const session = strategySessions.get(user_id);
    if (!session?.isRunning) return res.json({ success: true, message: 'Was not running' });
    session.isRunning = false;
    console.log(`[STRATEGY] Stop signal for ${user_id}`);
    return res.json({ success: true, message: 'Stop signal sent' });
});

// Route: live-update strategy settings
app.post('/strategy/update', (req, res) => {
    const { user_id, mtg_level, complex_mode, strategies } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'user_id required' });
    if (!strategySessions.has(user_id)) strategySessions.set(user_id, createSession(user_id));
    const session = strategySessions.get(user_id);
    if (mtg_level   !== undefined) session.mtgLevel    = Math.max(1, Math.min(10, parseInt(mtg_level) || 1));
    if (complex_mode !== undefined) session.complexMode = !!complex_mode;
    if (strategies?.length) session.activeKeys = strategies.map(n => STRATEGY_DEFS[n - 1]?.key).filter(Boolean);
    const seq = getMtgSequence(session.mtgLevel);
    pushEvent(session, { type: 'updated', mtgLevel: session.mtgLevel, complexMode: session.complexMode, strategies: session.activeKeys, sequence: seq });
    return res.json({ success: true, mtgLevel: session.mtgLevel, complexMode: session.complexMode });
});

// Route: rotate Duel client seed — rate-limited to 1 call per 60 s globally
// GET /change_seed  — any authenticated user may call; excess requests are queued
function generateClientSeed(len = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

async function rotateDuelSeed() {
    const clientSeed = generateClientSeed(16);
    console.log(`[SEED] Rotating client seed → ${clientSeed}`);
    const { data } = await axios.post(
        DUEL_SEED_ROTATE_URL,
        { client_seed: clientSeed },
        {
            headers: {
                'accept':                      'application/json, text/plain, */*',
                'accept-encoding':             'gzip, deflate, br, zstd',
                'accept-language':             'en-GB,en;q=0.6',
                'content-type':                'application/json',
                'cookie':                      DUEL_SEED_COOKIES,
                'origin':                      'https://duel.com',
                'priority':                    'u=1, i',
                'referer':                     'https://duel.com/dice',
                'sec-ch-ua':                   '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
                'sec-ch-ua-arch':              '"x86"',
                'sec-ch-ua-bitness':           '"64"',
                'sec-ch-ua-full-version-list': '"Brave";v="149.0.0.0", "Chromium";v="149.0.0.0", "Not)A;Brand";v="24.0.0.0"',
                'sec-ch-ua-mobile':            '?0',
                'sec-ch-ua-model':             '""',
                'sec-ch-ua-platform':          '"Windows"',
                'sec-ch-ua-platform-version':  '"19.0.0"',
                'sec-fetch-dest':              'empty',
                'sec-fetch-mode':              'cors',
                'sec-fetch-site':              'same-origin',
                'sec-gpc':                     '1',
                'user-agent':                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
                'x-duel-device-identifier':    DUEL_DEVICE_UUID,
                'x-env-class':                 'blue'
            },
            timeout: 15000
        }
    );
    console.log(`[SEED] Rotate response: ${JSON.stringify(data)}`);
    return data;
}

app.get('/change_seed', (req, res) => {
    console.log('[SEED] /change_seed request received — queuing...');
    enqueueSeedRotate(() => rotateDuelSeed())
        .then(data => {
            res.json({ success: true, data });
        })
        .catch(err => {
            console.error(`[SEED] Rotate failed: ${err.message}`);
            res.status(500).json({ success: false, error: err.message });
        });
});

// Route: get strategy status
app.get('/strategy/status', (req, res) => {
    const userId  = req.query.user_id;
    if (!userId)  return res.status(400).json({ success: false, error: 'user_id required' });
    const session = strategySessions.get(userId);
    if (!session) return res.json({ success: true, isRunning: false });
    return res.json({
        success: true,
        isRunning:   session.isRunning,
        totalTrades: session.totalTrades,
        totalProfit: session.totalProfit,
        mtgLevel:    session.mtgLevel,
        complexMode: session.complexMode,
        strategies:  session.activeKeys.map(k => STRATEGY_DEFS.findIndex(d => d.key === k) + 1).filter(n => n > 0)
    });
});

// --- 7. Incoming LTC Transaction Handler ---
// Note: Real-time detection is handled by pollAllBalances (60 s interval).
// This function is kept for potential direct invocations but is not called
// from a WebSocket (BlockCypher WS removed in favour of Tatum REST polling).
async function handleLtcTx(tx) {
    if (!tx.outputs) return;
    const txHash = tx.hash || 'N/A';
    console.log(`[TX] Incoming TX: ${txHash}`);

    for (const output of tx.outputs) {
        for (const addr of (output.addresses || [])) {
            const key = addr.toLowerCase();
            if (!addressToUserId.has(key)) {
                console.log(`[TX] Untracked address: ${addr}`);
                continue;
            }
            const userId  = addressToUserId.get(key);
            const amount  = parseFloat((output.value / LTC_SATOSHIS).toFixed(8));

            // Add to accumulated balance (never decreases)
            const prevAccum = userAccumulatedBalance.get(userId) || 0;
            const newAccum  = parseFloat((prevAccum + amount).toFixed(8));
            userAccumulatedBalance.set(userId, newAccum);
            lastOnChainSats.set(userId, (lastOnChainSats.get(userId) || 0) + output.value);

            console.log(`[DEPOSIT] ‼ User: ${userId} | +${amount} LTC | Accumulated: ${newAccum} LTC | TX: ${txHash}`);
            const ts = getDhakaTimestamp();
            try {
                await acquireBalanceLock(userId, async () => {
                    const snap = await axios.get(`${DB_BASE}/crypto_accounts/${userId}.json`);
                    if (snap.data) {
                        const currentBal = parseFloat(snap.data.Balance ?? 0) || 0;
                        const newBal = parseFloat((currentBal + amount).toFixed(8));
                        await axios.patch(`${DB_BASE}/crypto_accounts/${userId}.json`, {
                            Balance: newBal, AccumulatedBalance: newAccum, date: ts.date, time: ts.time
                        });
                    }
                });
            } catch (e) { console.error(`[DEPOSIT] Firebase error for ${userId}: ${e.message}`); }

            queueUserSweep(userId, () => sweepLtcToTreasury(userId));
        }
    }
}

// --- 7. Safe Initialization System ---
async function loadAccounts() {
    console.log("[INIT] Loading accounts from Firebase...");
    try {
        const response = await axios.get(`${DB_BASE}/crypto_accounts.json`);
        const accounts = response.data;

        if (accounts) {
            const total = Object.keys(accounts).length;
            console.log(`[INIT] Found ${total} account(s) in Firebase. Mapping addresses...`);

            for (const [userId, accountData] of Object.entries(accounts)) {
                try {
                    if (typeof accountData === 'string') {
                        const { address } = deriveWallet(accountData);
                        addressToUserId.set(address.toLowerCase(), userId);
                        userIdToPhrase.set(userId, accountData);
                        console.log(`[INIT] Loaded wallet | User: ${userId} | Address: ${address}`);
                    } else if (accountData && typeof accountData === 'object') {
                        const storedAddress = accountData.Address || accountData.Public;
                        if (storedAddress) {
                            addressToUserId.set(storedAddress.toLowerCase(), userId);
                            console.log(`[INIT] Loaded wallet | User: ${userId} | Address: ${storedAddress}`);
                        } else if (accountData.Key) {
                            const { address } = deriveWallet(accountData.Key);
                            addressToUserId.set(address.toLowerCase(), userId);
                            console.log(`[INIT] Derived wallet | User: ${userId} | Address: ${address}`);
                        }
                        if (accountData.Key) {
                            userIdToPhrase.set(userId, accountData.Key);
                        }
                        // Load accumulated balance from Firebase into memory
                        const accum = parseFloat(accountData.AccumulatedBalance ?? accountData.Balance ?? 0) || 0;
                        userAccumulatedBalance.set(userId, accum);
                    }
                } catch (innerErr) {
                    console.error(`[INIT] Failed mapping wallet for user ${userId}:`, innerErr.message);
                }
            }
        } else {
            console.log("[INIT] No existing accounts found in Firebase.");
        }
        console.log(`[INIT] Initialization complete. Registered ${addressToUserId.size} LTC address(es) into lookup index.`);
    } catch (error) {
        console.error("[INIT] Critical error while loading accounts from DB:", error);
    }
}

// Boot Sequence: Load Data -> Fire Up Server
console.log("[BOOT] Marketwave LTC Server starting...");
loadAccounts().then(() => {
    console.log(`[BOOT] Account load complete. ${addressToUserId.size} address(es) registered. Tatum API ready.`);

    // Fetch a fresh Duel token on every boot — never rely on a cached/hardcoded value.
    // Auto-refresh fires every 590 s to stay ahead of the 600 s expiry.
    console.log("[BOOT] Fetching fresh Duel security token...");
    fetchDuelToken()
        .then(t => console.log(`[BOOT] Duel token ready: ${t.substring(0, 12)}... | expires: ${new Date(duelTokenExpiresAt).toISOString()}`))
        .catch(err => console.error(`[BOOT] Duel token fetch FAILED: ${err.message} — Update DUEL_COOKIES if cookies are expired`));
    setInterval(() => {
        console.log("[TOKEN] Auto-refresh: fetching new Duel security token...");
        fetchDuelToken().catch(err => console.error("[TOKEN] Auto-refresh failed:", err.message));
    }, 590 * 1000);

    // Poll all balances every 60 seconds via Tatum REST API (per-address).
    // 60 s interval is well within Tatum's rate limits.
    console.log("[BOOT] Starting balance polling every 60 seconds (batch mode)...");
    pollAllBalances();
    setInterval(pollAllBalances, 60000);

    app.get('/', (req, res) => {
        res.json({ status: 'ok', message: 'Marketwave LTC Node is running', timestamp: new Date().toISOString() });
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`[BOOT] ✔ Marketwave LTC Node Application listening on Port ${PORT}`);
        console.log(`[BOOT] Treasury Address: ${TREASURY_ADDRESS}`);
        console.log(`[BOOT] Monitoring ${addressToUserId.size} LTC address(es) for deposits via Tatum polling.`);
    });
});
