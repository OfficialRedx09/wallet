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

// Core Lookup Maps
const addressToUserId = new Map();
const userIdToPhrase  = new Map();
const userSweepQueue  = new Map();

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
            const { data } = await axios.get(
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

// --- 6. Incoming LTC Transaction Handler ---
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
