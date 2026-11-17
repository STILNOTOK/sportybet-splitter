const express = require('express');
const mongoose = require('mongoose');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// 1. CONFIGURATION
// ==========================================
const BASE = 'https://www.sportybet.com';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || 'sk_test_YOUR_SECRET_KEY_HERE';
const PLAN_CODE = process.env.PAYSTACK_PLAN_CODE || 'PLN_YOUR_WEEKLY_PLAN_CODE_HERE';
const BASE_URL = process.env.BASE_URL || 'http://localhost:9000';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/sportybet';

const HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Current-Country': 'NG',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Referer': 'https://www.sportybet.com/ng/',
    'Origin': 'https://www.sportybet.com'
};

// ==========================================
// 2. MONGODB CONNECTION & SCHEMA
// ==========================================
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    isPremium: { type: Boolean, default: false },
    validUntil: { type: Date, default: null },
    splitCount: { type: Number, default: 0 },
    lastSplitDate: { type: Date, default: null }
});
const User = mongoose.model('User', userSchema);

// ==========================================
// 3. PAYSTACK ROUTES
// ==========================================
app.post('/api/subscribe', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });

    try {
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: email,
                plan: PLAN_CODE,
                callback_url: `${BASE_URL}/verify-payment?email=${encodeURIComponent(email)}`
            })
        });
        const data = await response.json();
        if (!data.status) return res.status(400).json({ error: data.message });
        res.json({ url: data.data.authorization_url });
    } catch (error) {
        res.status(500).json({ error: "Failed to initialize payment." });
    }
});

app.get('/verify-payment', async (req, res) => {
    const { reference, email } = req.query;
    if (!reference) return res.redirect('/?error=missing_reference');

    try {
        const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
        });
        const data = await response.json();

        if (data.status && data.data.status === 'success') {
            await User.findOneAndUpdate(
                { email: email },
                { isPremium: true, validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
                { upsert: true, new: true }
            );
            res.redirect(`/?premium=success&email=${encodeURIComponent(email)}`);
        } else {
            res.redirect('/?error=payment_failed');
        }
    } catch (error) {
        res.redirect('/?error=verification_error');
    }
});

app.post('/paystack/webhook', async (req, res) => {
    const event = req.body;
    if (event.event === 'charge.success') {
        const customerEmail = event.data.customer.email;
        if (event.data.plan?.plan_code === PLAN_CODE) {
            await User.findOneAndUpdate(
                { email: customerEmail },
                { isPremium: true, validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
                { upsert: true }
            );
        }
    }
    res.sendStatus(200);
});

// ==========================================
// 4. HELPER: CHECK USER LIMIT
// ==========================================
async function checkLimit(email) {
    if (!email) return { allowed: true, isPremium: false }; // Allow if no email provided

    const user = await User.findOne({ email });
    
    if (user && user.isPremium && user.validUntil > new Date()) {
        return { allowed: true, isPremium: true };
    }

    const now = new Date();
    if (!user) {
        await User.create({ email, splitCount: 1, lastSplitDate: now });
        return { allowed: true, isPremium: false };
    }

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (!user.lastSplitDate || user.lastSplitDate < oneWeekAgo) {
        user.splitCount = 1;
        user.lastSplitDate = now;
        await user.save();
        return { allowed: true, isPremium: false };
    }

    if (user.splitCount >= 2) {
        return { allowed: false, isPremium: false, error: "Free limit reached (2 splits/week). Please subscribe to Premium for unlimited splits." };
    }

    user.splitCount += 1;
    user.lastSplitDate = now;
    await user.save();
    return { allowed: true, isPremium: false };
}

// ==========================================
// 5. SPORTYBET LOGIC
// ==========================================
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatSelectionsForSportyBet(group) {
    return group.map(g => {
        let marketId = "1";
        let outcomeId = "1";
        let specifier = undefined;

        if (g.markets && g.markets.length > 0) {
            const market = g.markets[0];
            marketId = String(market.id);
            if (market.specifier) specifier = market.specifier;
            if (market.outcomes && market.outcomes.length > 0) {
                outcomeId = String(market.outcomes[0].id);
            }
        } else if (g.marketId && g.outcomeId) {
            marketId = String(g.marketId);
            outcomeId = String(g.outcomeId);
            if (g.specifier) specifier = g.specifier;
        }

        const sel = { eventId: g.eventId, marketId: marketId, outcomeId: outcomeId };
        if (specifier && specifier.trim() !== '') sel.specifier = specifier;
        return sel;
    });
}

async function fetchMatches(code) {
    const readRes = await fetch(`${BASE}/api/ng/orders/share/${code}?t=${Date.now()}`, { headers: HEADERS });
    const json = await readRes.json();
    if (!json || !json.data) return null;
    
    let allMatches = [];
    if (json.data.outcomes) allMatches = json.data.outcomes;
    else if (json.data.ticket && json.data.ticket.selections) allMatches = json.data.ticket.selections;

    const uniqueMatches = [];
    const seenIds = new Set();
    for (const m of allMatches) {
        if (!seenIds.has(m.eventId)) {
            uniqueMatches.push(m);
            seenIds.add(m.eventId);
        }
    }
    return uniqueMatches;
}

async function tryBookGroup(initialGroup, fullPool, isStrict, usedIds) {
    let currentGroup = [...initialGroup];
    let attempts = 0;
    let deadEventIds = new Set();

    while (currentGroup.length > 0 && attempts < 15) {
        attempts++;
        const formattedSelections = formatSelectionsForSportyBet(currentGroup);

        try {
            const payload = {
                products: [1],
                source: "web",
                acceptOddsChanges: true,
                stake: 10,
                orderType: 2,
                selections: formattedSelections
            };

            const bookRes = await fetch(`${BASE}/api/ng/orders/share`, {
                method: 'POST',
                headers: HEADERS,
                body: JSON.stringify(payload)
            });
            
            const bookData = await bookRes.json();
            const generatedCode = bookData.data && bookData.data.shareCode;

            if (bookData && bookData.bizCode === 10000 && generatedCode) {
                let computedOdds = 1;
                let hasOdds = false;
                
                currentGroup.forEach(g => {
                    let oddVal = g.odds ? parseFloat(g.odds) : 0;
                    if (oddVal === 0 && g.markets && g.markets.length > 0 && g.markets[0].outcomes && g.markets[0].outcomes.length > 0) {
                        oddVal = parseFloat(g.markets[0].outcomes[0].odds);
                    }
                    if (oddVal > 0) {
                        computedOdds *= oddVal;
                        hasOdds = true;
                    }
                });

                return { 
                    success: true, 
                    newCode: generatedCode, 
                    url: `http://www.sportybet.com/ng/?shareCode=${generatedCode}`, 
                    odds: hasOdds ? computedOdds.toFixed(2) : 'N/A', 
                    matchCount: currentGroup.length 
                };
            } 
            
            if (bookData && bookData.data && bookData.data.unavailableOutcomes) {
                const badEventId = bookData.data.unavailableOutcomes[0].eventId;
                deadEventIds.add(badEventId);
                currentGroup = currentGroup.filter(m => m.eventId !== badEventId);
                
                for (const m of fullPool) {
                    if (currentGroup.length >= initialGroup.length) break;
                    if (!deadEventIds.has(m.eventId) && !currentGroup.find(x => x.eventId === m.eventId)) {
                        if (isStrict && usedIds.has(m.eventId)) continue;
                        currentGroup.push(m);
                        if (isStrict) usedIds.add(m.eventId);
                    }
                }
            } else {
                return { success: false };
            }
        } catch (err) {
            return { success: false };
        }
        await new Promise(r => setTimeout(r, 2500));
    }
    return { success: false };
}

// ==========================================
// 6. SPLIT & SHUFFLE ROUTES (With Paywall)
// ==========================================
app.post('/api/split', async (req, res) => {
    try {
        const { originalCode, groupSize, maxGroups, userEmail } = req.body;
        
        const limitStatus = await checkLimit(userEmail);
        if (!limitStatus.allowed) return res.status(403).json({ error: limitStatus.error });

        const matches = await fetchMatches(originalCode);
        if (!matches) return res.status(400).json({ error: "Invalid code or blocked." });
        if (matches.length < groupSize) return res.status(400).json({ error: "Not enough matches." });

        const generated = [];
        let availablePool = shuffleArray(matches); 
        let globalUsedIds = new Set();

        for (let i = 0; i < maxGroups; i++) {
            let initialGroup = [];
            for (let m of availablePool) {
                if (!globalUsedIds.has(m.eventId)) {
                    initialGroup.push(m);
                    globalUsedIds.add(m.eventId);
                }
                if (initialGroup.length === groupSize) break;
            }
            if (initialGroup.length < groupSize) break;
            const result = await tryBookGroup(initialGroup, availablePool, true, globalUsedIds);
            if (result.success) generated.push(result);
        }

        if (generated.length === 0) return res.status(400).json({ error: "SportyBet rejected all groups." });
        res.json({ codes: generated });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/shuffle', async (req, res) => {
    try {
        const { originalCode, groupSize, maxGroups, userEmail } = req.body;
        
        const limitStatus = await checkLimit(userEmail);
        if (!limitStatus.allowed) return res.status(403).json({ error: limitStatus.error });

        const matches = await fetchMatches(originalCode);
        if (!matches) return res.status(400).json({ error: "Invalid code or blocked." });
        if (matches.length < groupSize) return res.status(400).json({ error: "Not enough matches." });

        const generated = [];

        for (let i = 0; i < maxGroups; i++) {
            const shuffledPool = shuffleArray(matches);
            const initialGroup = shuffledPool.slice(0, groupSize);
            const result = await tryBookGroup(initialGroup, shuffledPool, false, new Set());
            if (result.success) generated.push(result);
        }

        if (generated.length === 0) return res.status(400).json({ error: "SportyBet rejected all groups." });
        res.json({ codes: generated });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});