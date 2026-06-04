const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const admin = require('firebase-admin');

// --- 1. Firebase Initialization ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://marketwave-727e8-default-rtdb.firebaseio.com"
});
const db = admin.database();

const app = express();
app.use(cors());
app.use(express.json());

// --- 2. Blockchain Setup & Resilient WSS Connection Helper ---
const POLYGON_WSS_URL = "wss://serene-winter-seed.matic.quiknode.pro/2a6ddd525015cccffe78f76a8e274d9b0f5453ff";
const USDT_ADDRESS = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const TREASURY_ADDRESS = "0x2D76fb4E08faec749E429bE3389A406Ec8d11bAB";

const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function transfer(address to, uint256 value) returns (bool)",
    "function balanceOf(address account) view returns (uint256)"
];

let provider;
let usdtContract;

// Core Lookup Maps
const addressToUserId = new Map();
const userIdToPhrase = new Map();
const userSweepQueue = new Map();

// Initializes the connection and handles drops gracefully
function connectBlockchain() {
    console.log("Connecting to Polygon WSS...");
    provider = new ethers.WebSocketProvider(POLYGON_WSS_URL);
    usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);

    setupBlockchainListener();

    // Listen for WebSocket connection errors or sudden drops
    provider.on("error", (error) => {
        console.error("WebSocket Provider Error:", error);
        reconnectBlockchain();
    });
}

function reconnectBlockchain() {
    console.log("Attempting to reconnect WebSocket in 5 seconds...");
    setTimeout(() => {
        try {
            connectBlockchain();
        } catch (err) {
            console.error("Reconnection failed, retrying...", err);
            reconnectBlockchain();
        }
    }, 5000);
}

// --- 3. Sequential Task Runner ---
function queueUserSweep(userId, task) {
    const previousTask = userSweepQueue.get(userId) || Promise.resolve();
    const nextTask = previousTask
        .then(task)
        .catch((error) => {
            console.error(`Sweep queue execution failure for user ${userId}:`, error);
        });

    userSweepQueue.set(userId, nextTask);
    nextTask.finally(() => {
        if (userSweepQueue.get(userId) === nextTask) {
            userSweepQueue.delete(userId);
        }
    });
}

// --- 4. Core Transaction Sweeper ---
async function sweepUsdtToTreasury(userId, amountRaw) {
    const phrase = userIdToPhrase.get(userId);
    if (!phrase) {
        console.error(`No recovery phrase found for user ${userId}. Skipping sweep.`);
        return;
    }

    try {
        const userWallet = ethers.Wallet.fromPhrase(phrase, provider);
        const userUsdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, userWallet);

        const onChainBalance = await userUsdtContract.balanceOf(userWallet.address);
        const transferAmount = amountRaw <= onChainBalance ? amountRaw : onChainBalance;

        if (transferAmount <= 0n) {
            console.log(`No transferable USDT balance detected for user ${userId}.`);
            return;
        }

        console.log(`Attempting to sweep ${ethers.formatUnits(transferAmount, 6)} USDT for user ${userId}...`);
        
        // NOTE: This will fail if user's wallet has 0 POL/MATIC to pay gas fees.
        const transferTx = await userUsdtContract.transfer(TREASURY_ADDRESS, transferAmount);
        await transferTx.wait();

        const confirmedAmount = parseFloat(ethers.formatUnits(transferAmount, 6));
        await db.ref(`wallet_conformation/${userId}`).set(confirmedAmount);

        console.log(`Sweep successful: ${confirmedAmount} USDT moved to Treasury for user ${userId}`);
    } catch (error) {
        console.error(`[CRITICAL] Sweep Transaction failed for user ${userId}. Internal details:`, error.message);
        console.error(`-> Reminder: Ensure this deposit wallet has enough native POL/MATIC tokens to execute transactions.`);
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

// --- 5. Route: Create Crypto Account (Converted to POST) ---
app.post('/create-account', async (req, res) => {
    try {
        const user_id = req.body.user_id || req.query.user_id;
        const userIp = req.body.ip || req.query.ip || req.ip;

        if (!user_id) {
            return res.status(400).json({ error: "user_id parameter is required" });
        }

        const accountRef = db.ref(`crypto_accounts/${user_id}`);
        const existingSnapshot = await accountRef.once('value');
        const existingAccount = existingSnapshot.val();

        if (existingAccount) {
            let existingAddress = "";
            if (typeof existingAccount === 'string') {
                const wallet = ethers.Wallet.fromPhrase(existingAccount);
                existingAddress = wallet.address;
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

            return res.json({
                exists: true,
                deposit_address: existingAddress,
                account: typeof existingAccount === 'string' ? { User_id: user_id, Address: existingAddress } : existingAccount
            });
        }

        // Create new secure random wallet
        const wallet = ethers.Wallet.createRandom();
        const phrase = wallet.mnemonic.phrase;
        const address = wallet.address;
        const timestamp = getDhakaTimestamp();

        const newAccountData = {
            User_id: user_id,
            date: timestamp.date,
            time: timestamp.time,
            IP: userIp,
            Address: address,
            Key: phrase,
            Public: address
        };

        await accountRef.set(newAccountData);

        // Update working runtime maps
        addressToUserId.set(address.toLowerCase(), user_id);
        userIdToPhrase.set(user_id, phrase);

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

// --- 6. Event Stream Handler ---
function setupBlockchainListener() {
    // Clear out old event registrations if reconnecting
    usdtContract.removeAllListeners("Transfer");

    usdtContract.on("Transfer", async (from, to, value) => {
        const toAddress = to.toLowerCase();

        if (addressToUserId.has(toAddress)) {
            const userId = addressToUserId.get(toAddress);
            const amountReceived = parseFloat(ethers.formatUnits(value, 6));
            console.log(`[DEPOSIT ALERT] Tracked ${amountReceived} USDT incoming for User ID: ${userId}`);

            const timestamp = getDhakaTimestamp();
            const balanceRef = db.ref(`Crypto_wallet_balance/${userId}`);

            // Perform an isolated database balance increment transaction
            await balanceRef.transaction((currentData) => {
                if (currentData === null) {
                    return {
                        Balance: amountReceived,
                        date: timestamp.date,
                        time: timestamp.time
                    };
                } else {
                    return {
                        Balance: (currentData.Balance || 0) + amountReceived,
                        date: timestamp.date,
                        time: timestamp.time
                    };
                }
            });

            // Put transaction securely into the sweep schedule
            const receivedRaw = BigInt(value.toString());
            queueUserSweep(userId, async () => {
                await sweepUsdtToTreasury(userId, receivedRaw);
            });
        }
    });
}

// --- 7. Safe Initialization System ---
async function loadAccounts() {
    try {
        const snapshot = await db.ref('crypto_accounts').once('value');
        const accounts = snapshot.val();
        
        if (accounts) {
            for (const [userId, accountData] of Object.entries(accounts)) {
                try {
                    if (typeof accountData === 'string') {
                        const wallet = ethers.Wallet.fromPhrase(accountData);
                        addressToUserId.set(wallet.address.toLowerCase(), userId);
                        userIdToPhrase.set(userId, accountData);
                    } else if (accountData && typeof accountData === 'object') {
                        const storedAddress = accountData.Address || accountData.Public;
                        if (storedAddress) {
                            addressToUserId.set(storedAddress.toLowerCase(), userId);
                        } else if (accountData.Key) {
                            const wallet = ethers.Wallet.fromPhrase(accountData.Key);
                            addressToUserId.set(wallet.address.toLowerCase(), userId);
                        }

                        if (accountData.Key) {
                            userIdToPhrase.set(userId, accountData.Key);
                        }
                    }
                } catch (innerErr) {
                    console.error(`Failed mapping wallet index structure for ID ${userId}`);
                }
            }
        }
        console.log(`Initialization complete. Registered ${addressToUserId.size} addresses into lookup index.`);
    } catch (error) {
        console.error("Critical error while populating internal operational addresses from DB:", error);
    }
}

// Boot Sequence: Load Data -> Setup Provider Subscriptions -> Fire Up Server
loadAccounts().then(() => {
    connectBlockchain();
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Marketwave Node Application listening actively on Port ${PORT}`);
    });
});