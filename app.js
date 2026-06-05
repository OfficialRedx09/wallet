const express = require('express');
const cors = require('cors');
const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const bip39 = require('bip39');
const ecc = require('tiny-secp256k1');
const axios = require('axios');
const WebSocket = require('ws');

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
const BLOCKCYPHER_BASE = "https://api.blockcypher.com/v1/ltc/main";
const BLOCKCYPHER_WSS  = "wss://socket.blockcypher.com/v1/ltc/main";
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
const DUEL_DEVICE_UUID  = process.env.DUEL_DEVICE_UUID  || "30b3dac8-2c30-4ec7-94fd-67186e92e94a";
const DUEL_COOKIES      = process.env.DUEL_COOKIES      || "duel=ZetFwwIEJuC2L6kZNiAYQyQwnc9CyfgErVtqcwWA; do_not_share_this_with_anyone_not_even_staff=4975939_l09WQ6ZeqD8HWQDGnBi4PbGavFTvhDwX7tB7A8jAlYrrldcNPEglAW2Gw3Ik; cf_clearance=fOrtE9TNoPnxCGxIeGJfHvuKPt8i2hlZTQa_vJWPmVM-1780691376-1.2.1.1-D3IhI9XEARs0VQLjhRsLPZV9uja2Jm08LF0v3Uvx1S0VaDcMCqXPrPSTEq254BnP0ZPRYsij5U6IfRYATZJjBrDaGn2eebjVfd6DraH_1hTgb7ET6FllTn6sFxQTjLatfItEc5UJithCLExCEg4IqyrzI1IZz01RSTgrH_a9zxtR9krqAQa5ko6nnjrSVV7piek8DBE2Wp_GqlgeJAsNgQgZbXKa8FIzJcBDmyVPI2HbqiAq.7B1y9jpINCOfxT7TH5iKKKoYRfR_FM64dVeiUjy9lgcQI9FfqqhelFT08zg5kB0lZlMFY7NUzIIc2UjRfOdXkzyQvznVJwYVjYa_xVno1S7O3R461G8sqQbW7Mn5UOs4WjtSinpeAF9kuM17_IOa35EQKs0aeH33w.7ey4K.4Hyd0A4xH4jzUe8O2I; __cf_bm=FNLnCI9P79KFmVcTQyLoAjsBpWvKnvUNPfQs.H77qxg-1780691628-1.0.1.1-rHIX5QdVfL7BfMziRanBrZtuRBdkJkaXE8RG8nlYceghtUj1_AmlrlKFkQkF8ahVr36ldmgpSEpQLpQ9r14YC5ZGVv_36Yfs7B2YN.XXqhw; env_class=blue";

// Core Lookup Maps
const addressToUserId = new Map();
const userIdToPhrase  = new Map();
const userSweepQueue  = new Map();

// Server-side balance memory: stores last known non-zero balance per userId
// This prevents a post-sweep poll from overwriting Firebase Balance back to 0
const lastKnownBalance = new Map();

// --- Duel token in-memory state ---
// Always fetched fresh on boot — never trust a hardcoded token as Duel tokens expire in 600 s.
// callDuelApi always uses the server-managed token; client-supplied tokens are ignored.
let duelToken           = null;
let duelTokenExpiresAt  = 0;
let duelTokenRefreshing = null; // mutex: prevents concurrent refresh requests

// Active WebSocket state
let wsClient        = null;
const monitoredAddrs = new Set();

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

// Initializes the BlockCypher WebSocket and handles disconnects
function connectBlockchain() {
    console.log("Connecting to BlockCypher LTC WebSocket...");
    wsClient = new WebSocket(BLOCKCYPHER_WSS);

    wsClient.on('open', () => {
        console.log("[WS] BlockCypher LTC WebSocket connected.");
        console.log(`[WS] Re-subscribing to ${monitoredAddrs.size} monitored address(es)...`);
        for (const addr of monitoredAddrs) {
            wsClient.send(JSON.stringify({ event: "unconfirmed-tx", address: addr }));
            console.log(`[WS] Subscribed to LTC address: ${addr}`);
        }
    });

    wsClient.on('message', (data) => {
        try {
            handleLtcTx(JSON.parse(data.toString()));
        } catch (e) {
            // Ignore malformed frames
        }
    });

    wsClient.on('error', (err) => {
        console.error("[WS] BlockCypher WebSocket error:", err.message);
    });

    wsClient.on('close', (code, reason) => {
        console.warn(`[WS] BlockCypher WebSocket closed. Code: ${code} | Reason: ${reason || 'N/A'}. Reconnecting in 5 s...`);
        wsClient = null;
        reconnectBlockchain();
    });
}

function reconnectBlockchain() {
    console.log("[WS] Scheduling reconnect in 5 seconds...");
    setTimeout(() => {
        console.log("[WS] Attempting to reconnect to BlockCypher LTC WebSocket...");
        try { connectBlockchain(); }
        catch (err) { console.error("[WS] Reconnection failed, retrying...", err); reconnectBlockchain(); }
    }, 5000);
}

function subscribeAddress(address) {
    if (monitoredAddrs.has(address)) return;
    monitoredAddrs.add(address);
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ event: "unconfirmed-tx", address }));
        console.log(`[WS] Subscribed to LTC address: ${address}`);
    } else {
        console.log(`[WS] Address queued for subscription (socket not ready): ${address}`);
    }
}

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
            const data = await blockCypherGet(
                `${BLOCKCYPHER_BASE}/addrs/${address}?unspentOnly=true&confirmations=1`
            );
            txrefs = data.txrefs || [];
            if (txrefs.length > 0) {
                console.log(`[SWEEP] Found ${txrefs.length} confirmed UTXO(s) for user ${userId}.`);
                break;
            }
            if (attempt < 9) {
                console.log(`[SWEEP] No confirmed UTXOs yet for user ${userId}. Waiting 2.5 min...`);
                await new Promise(r => setTimeout(r, 150000));
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

        // Broadcast
        const broadcastRes = await axios.post(`${BLOCKCYPHER_BASE}/txs/push`, { tx: txHex });
        const txHash = broadcastRes.data?.tx?.hash || 'unknown';
        console.log(`[SWEEP] Broadcast successful! TX Hash: ${txHash}`);

        const confirmedAmount = parseFloat((sendSatoshis / LTC_SATOSHIS).toFixed(8));
        await axios.put(`${DB_BASE}/wallet_conformation/${userId}.json`, confirmedAmount);
        console.log(`[SWEEP] Firebase updated. wallet_conformation/${userId} = ${confirmedAmount} LTC`);

        console.log(`[SWEEP] ✔ SUCCESS: ${confirmedAmount} LTC swept to Treasury for user ${userId} | TX: ${txHash}`);
    } catch (error) {
        console.error(`[SWEEP] [CRITICAL] Sweep Transaction failed for user ${userId}:`, error.message);
        if (error.response) {
            console.error(`[SWEEP] -> BlockCypher response:`, JSON.stringify(error.response.data));
        }
    }
}

// --- 5. Periodic Wallet Balance Polling ---

// BlockCypher free tier: 3 req/s, 200 req/hour.
// On 429 we back off exponentially: 15 s -> 30 s -> 60 s -> 120 s -> give up.
async function blockCypherGet(url, retries = 4) {
    let delay = 15000; // start at 15 s
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const { data } = await axios.get(url);
            return data;
        } catch (err) {
            const status = err.response?.status;
            if (status === 429) {
                const retryAfterHeader = err.response?.headers?.['retry-after'];
                const waitMs = retryAfterHeader ? parseInt(retryAfterHeader) * 1000 : delay;
                if (attempt < retries) {
                    console.warn(`[BLOCKCYPHER] 429 Rate limited on ${url}. Waiting ${waitMs / 1000}s before retry ${attempt}/${retries - 1}...`);
                    await new Promise(r => setTimeout(r, waitMs));
                    delay *= 2; // exponential back-off
                    continue;
                }
                console.error(`[BLOCKCYPHER] 429 Rate limit exhausted after ${retries} attempts: ${url}`);
            }
            throw err;
        }
    }
}

async function pollAllBalances() {
    if (addressToUserId.size === 0) {
        console.log('[POLL] No addresses to poll. Skipping.');
        return;
    }

    // BlockCypher batch endpoint: fetch ALL addresses in a single HTTP request.
    // Format: /addrs/addr1;addr2;addr3/balance
    // Returns an array when multiple addresses are given, an object for one.
    // 1 request per cycle = well within the 200 req/hour free-tier limit.
    const addresses = Array.from(addressToUserId.keys()); // already lowercased
    const batchUrl  = `${BLOCKCYPHER_BASE}/addrs/${addresses.join(';')}/balance`;
    console.log(`[POLL] Fetching balances for ${addresses.length} address(es) in one batch request...`);

    let results;
    try {
        const raw = await blockCypherGet(batchUrl);
        // Normalise: single address returns object, multiple returns array
        results = Array.isArray(raw) ? raw : [raw];
    } catch (err) {
        console.error(`[POLL] Batch balance fetch failed: ${err.message}`);
        return;
    }

    for (const item of results) {
        const address = item.address?.toLowerCase();
        if (!address) continue;

        const userId = addressToUserId.get(address);
        if (!userId) {
            console.warn(`[POLL] Unknown address in batch response: ${address}`);
            continue;
        }

        // final_balance = confirmed + unconfirmed satoshis
        const balanceSats = item.final_balance !== undefined ? item.final_balance : (item.balance || 0);
        const balanceLtc  = parseFloat((balanceSats / LTC_SATOSHIS).toFixed(8));
        console.log(`[POLL] ${address} | User: ${userId} | ${balanceSats} sats (${balanceLtc} LTC)`);

        try {
            if (balanceSats > 0) {
                // Mark in memory BEFORE any sweep so a post-sweep poll never resets Firebase to 0
                lastKnownBalance.set(userId, balanceLtc);

                const accRes = await axios.get(`${DB_BASE}/crypto_accounts/${userId}.json`);
                if (accRes.data) {
                    const currentFirebaseBalance = accRes.data.Balance || 0;
                    const currentFirebaseSats    = Math.round(currentFirebaseBalance * LTC_SATOSHIS);

                    if (balanceSats !== currentFirebaseSats) {
                        console.log(`[POLL] Balance update | User: ${userId} | ${currentFirebaseBalance} LTC -> ${balanceLtc} LTC`);
                        await axios.patch(`${DB_BASE}/crypto_accounts/${userId}.json`, { Balance: balanceLtc });
                    } else {
                        console.log(`[POLL] Balance unchanged | User: ${userId} | ${balanceLtc} LTC`);
                    }

                    if (!userSweepQueue.has(userId)) {
                        console.log(`[POLL] Queuing sweep for user ${userId} (${balanceLtc} LTC on-chain).`);
                        queueUserSweep(userId, () => sweepLtcToTreasury(userId));
                    } else {
                        console.log(`[POLL] Sweep already active for user ${userId}. Skipping.`);
                    }
                }
            } else {
                if (lastKnownBalance.has(userId)) {
                    console.log(`[POLL] User ${userId} wallet is 0 on-chain (likely swept). Preserving Firebase balance of ${lastKnownBalance.get(userId)} LTC.`);
                } else {
                    console.log(`[POLL] User ${userId} wallet balance: 0 sats.`);
                }
            }
        } catch (err) {
            console.error(`[POLL] Firebase update error for user ${userId}: ${err.message}`);
        }
    }

    console.log(`[POLL] Poll cycle complete. Next poll in 60 s.`);
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
                subscribeAddress(existingAddress);
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
            Address: address,
            Key:     phrase,
            Public:  address
        };

        await axios.put(`${DB_BASE}/crypto_accounts/${user_id}.json`, newAccountData);

        addressToUserId.set(address.toLowerCase(), user_id);
        userIdToPhrase.set(user_id, phrase);
        subscribeAddress(address);
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
            'accept-language':          'en-GB,en;q=0.6',
            'content-type':             'application/json',
            'cookie':                   DUEL_COOKIES,
            'origin':                   'https://duel.com',
            'referer':                  'https://duel.com/dice',
            'user-agent':               'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
            'x-duel-device-identifier': DUEL_DEVICE_UUID,
            'x-env-class':              'blue',
            'x-security-token':         token,
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

// --- 7. Incoming LTC Transaction Handler ---
async function handleLtcTx(tx) {
    if (!tx.outputs) return;

    const txHash = tx.hash || 'N/A';
    console.log(`[TX] Incoming LTC transaction detected. TX Hash: ${txHash} | Outputs: ${tx.outputs.length}`);

    for (const output of tx.outputs) {
        const addresses = output.addresses || [];
        for (const addr of addresses) {
            if (addressToUserId.has(addr.toLowerCase())) {
                const userId        = addressToUserId.get(addr.toLowerCase());
                const amountReceived = parseFloat((output.value / LTC_SATOSHIS).toFixed(8));

                console.log(`[DEPOSIT] !! DEPOSIT DETECTED !! User: ${userId} | Address: ${addr} | Amount: ${amountReceived} LTC | TX: ${txHash}`);

                const timestamp  = getDhakaTimestamp();

                const accRes = await axios.get(`${DB_BASE}/crypto_accounts/${userId}.json`);
                const currentData = accRes.data;
                if (currentData !== null) {
                    const prevBalance = currentData.Balance || 0;
                    const newBalance  = parseFloat((prevBalance + amountReceived).toFixed(8));
                    // Mark balance in memory BEFORE sweep so polling never resets Firebase to 0
                    lastKnownBalance.set(userId, newBalance);
                    console.log(`[DEPOSIT] Firebase balance update | User: ${userId} | ${prevBalance} LTC -> ${newBalance} LTC`);
                    await axios.put(`${DB_BASE}/crypto_accounts/${userId}.json`, {
                        ...currentData,
                        Balance: newBalance,
                        date: timestamp.date,
                        time: timestamp.time
                    });
                }

                console.log(`[DEPOSIT] Balance updated in Firebase for user ${userId}. Queuing sweep...`);
                queueUserSweep(userId, async () => {
                    await sweepLtcToTreasury(userId);
                });
            } else {
                console.log(`[TX] Output to untracked address: ${addr} (${(output.value / LTC_SATOSHIS).toFixed(8)} LTC)`);
            }
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
                        monitoredAddrs.add(address);
                        console.log(`[INIT] Loaded wallet | User: ${userId} | Address: ${address}`);
                    } else if (accountData && typeof accountData === 'object') {
                        const storedAddress = accountData.Address || accountData.Public;
                        if (storedAddress) {
                            addressToUserId.set(storedAddress.toLowerCase(), userId);
                            monitoredAddrs.add(storedAddress);
                            console.log(`[INIT] Loaded wallet | User: ${userId} | Address: ${storedAddress}`);
                        } else if (accountData.Key) {
                            const { address } = deriveWallet(accountData.Key);
                            addressToUserId.set(address.toLowerCase(), userId);
                            monitoredAddrs.add(address);
                            console.log(`[INIT] Derived wallet | User: ${userId} | Address: ${address}`);
                        }
                        if (accountData.Key) {
                            userIdToPhrase.set(userId, accountData.Key);
                        }
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

// Boot Sequence: Load Data -> Connect WebSocket -> Fire Up Server
console.log("[BOOT] Marketwave LTC Server starting...");
loadAccounts().then(() => {
    console.log("[BOOT] Account load complete. Connecting to BlockCypher WebSocket...");
    connectBlockchain();

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

    // Poll all balances every 60 seconds using the BlockCypher batch endpoint.
    // Batch = 1 HTTP request for ALL addresses regardless of user count.
    // 60 req/hour is well within BlockCypher's 200 req/hour free-tier limit.
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
        console.log(`[BOOT] Monitoring ${monitoredAddrs.size} LTC address(es) for deposits.`);
    });
});
