const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_123';

const HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Current-Country': 'NG',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Referer': 'https://www.sportybet.com/ng/',
    'Origin': 'https://www.sportybet.com'
};

// ==========================================
// 2. MONGODB & SCHEMA
// ==========================================
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    isPremium: { type: Boolean, default: false },
    validUntil: { type: Date, default: null },
    splitCount: { type: Number, default: 0 },
    lastSplitDate: { type: Date, default: null }
});
const User = mongoose.model('User', userSchema);

// ==========================================
// 3. AUTHENTICATION ROUTES
// ==========================================
app.post('/api/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        let user = await User.findOne({ email });
        if (user) return res.status(400).json({ error: "User already exists" });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        user = new User({ email, password: hashedPassword });
        await user.save();
        res.json({ message: "Registration successful. Please login." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "Invalid credentials" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

        const token = jwt.sign({ email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, isPremium: user.isPremium });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Please login first." });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Session expired. Please login again." });
        req.user = user; 
        next();
    });
}

// ==========================================
// 4. PAYSTACK ROUTES (Protected)
// ==========================================
app.post('/api/subscribe', authenticateToken, async (req, res) => {
    const email = req.user.email; 
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
                { upsert: true }
            );
            res.redirect(`/?premium=success`);
        } else {
            res.redirect('/?error=payment_failed');
        }
    } catch (error) {
        res.redirect('/?error=verification_error');
    }
});

app.post('/paystack/webhook', async (req, res) => {
    const event = req.body;
    if (event.event === 'charge.success' && event.data.plan?.plan_code === PLAN_CODE) {
        await User.findOneAndUpdate(
            { email: event.data.customer.email },
            { isPremium: true, validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
            { upsert: true }
        );
    }
    res.sendStatus(200);
});

// ==========================================
// 5. LIMIT CHECK LOGIC
// ==========================================
async function checkLimit(email) {
    const user = await User.findOne({ email });
    
    if (user && user.isPremium && user.validUntil > new Date()) {
        return { allowed: true, isPremium: true };
    }

    const now = new Date();
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    if (!user) return { allowed: false, error: "User not found." }; // Should not happen if logged in

    if (!user.lastSplitDate || user.lastSplitDate < oneWeekAgo) {
        user.splitCount = 1;
        user.lastSplitDate = now;
        await user.save();
        return { allowed: true, isPremium: false, remaining: 1 };
    }

    if (user.splitCount >= 2) {
        return { allowed: false, error: "Free limit reached (2 splits/week). Please subscribe to Premium." };
    }

    user.splitCount += 1;
    user.lastSplitDate = now;
    await user.save();
    return { allowed: true, isPremium: false, remaining: 0 };
}

// ==========================================
// 6. SPORTYBET LOGIC
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
        let marketId = "1", outcomeId = "1", specifier = undefined;
        if (g.markets && g.markets.length > 0) {
            const market = g.markets[0];
            marketId = String(market.id);
            if (market.specifier) specifier = market.specifier;
            if (market.outcomes && market.outcomes.length > 0) outcomeId = String(market.outcomes[0].id);
        } else if (g.marketId && g.outcomeId) {
            marketId = String(g.marketId);
            outcomeId = String(g.outcomeId);
            if (g.specifier) specifier = g.specifier;
        }
        const sel = { eventId: g.eventId, marketId, outcomeId };
        if (specifier && specifier.trim() !== '') sel.specifier = specifier;
        return sel;
    });
}

async function fetchMatches(code) {
    const readRes = await fetch(`${BASE}/api/ng/orders/share/${code}?t=${Date.now()}`, { headers: HEADERS });
    const json = await readRes.json();
    if (!json || !json.data) return null;
    let allMatches = json.data.outcomes || (json.data.ticket && json.data.ticket.selections) || [];
    const uniqueMatches = [];
    const seenIds = new Set();
    for (const m of allMatches) {
        if (!seenIds.has(m.eventId)) { uniqueMatches.push(m); seenIds.add(m.eventId); }
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
            const payload = { products: [1], source: "web", acceptOddsChanges: true, stake: 10, orderType: 2, selections: formattedSelections };
            const bookRes = await fetch(`${BASE}/api/ng/orders/share`, { method: 'POST', headers: HEADERS, body: JSON.stringify(payload) });
            const bookData = await bookRes.json();
            const generatedCode = bookData.data && bookData.data.shareCode;

            if (bookData && bookData.bizCode === 10000 && generatedCode) {
                let computedOdds = 1;
                currentGroup.forEach(g => {
                    let oddVal = g.odds ? parseFloat(g.odds) : (g.markets?.[0]?.outcomes?.[0]?.odds ? parseFloat(g.markets[0].outcomes[0].odds) : 0);
                    if (oddVal > 0) computedOdds *= oddVal;
                });
                return { success: true, newCode: generatedCode, url: `http://www.sportybet.com/ng/?shareCode=${generatedCode}`, odds: computedOdds.toFixed(2), matchCount: currentGroup.length };
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
        } catch (err) { return { success: false }; }
        await new Promise(r => setTimeout(r, 2500));
    }
    return { success: false };
}

// ==========================================
// 7. PROTECTED SPLIT & SHUFFLE ROUTES
// ==========================================
app.post('/api/split', authenticateToken, async (req, res) => {
    try {
        const { originalCode, groupSize, maxGroups } = req.body;
        const userEmail = req.user.email; 
        
        const limitStatus = await checkLimit(userEmail);
        if (!limitStatus.allowed) return res.status(403).json({ error: limitStatus.error });

        const matches = await fetchMatches(originalCode);
        if (!matches || matches.length < groupSize) return res.status(400).json({ error: "Invalid code or not enough matches." });

        const generated = [];
        let availablePool = shuffleArray(matches); 
        let globalUsedIds = new Set();

        for (let i = 0; i < maxGroups; i++) {
            let initialGroup = [];
            for (let m of availablePool) {
                if (!globalUsedIds.has(m.eventId)) { initialGroup.push(m); globalUsedIds.add(m.eventId); }
                if (initialGroup.length === groupSize) break;
            }
            if (initialGroup.length < groupSize) break;
            const result = await tryBookGroup(initialGroup, availablePool, true, globalUsedIds);
            if (result.success) generated.push(result);
        }

        if (generated.length === 0) return res.status(400).json({ error: "SportyBet rejected all groups." });
        res.json({ codes: generated });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shuffle', authenticateToken, async (req, res) => {
    try {
        const { originalCode, groupSize, maxGroups } = req.body;
        const userEmail = req.user.email;
        
        const limitStatus = await checkLimit(userEmail);
        if (!limitStatus.allowed) return res.status(403).json({ error: limitStatus.error });

        const matches = await fetchMatches(originalCode);
        if (!matches || matches.length < groupSize) return res.status(400).json({ error: "Invalid code or not enough matches." });

        const generated = [];
        for (let i = 0; i < maxGroups; i++) {
            const shuffledPool = shuffleArray(matches);
            const initialGroup = shuffledPool.slice(0, groupSize);
            const result = await tryBookGroup(initialGroup, shuffledPool, false, new Set());
            if (result.success) generated.push(result);
        }

        if (generated.length === 0) return res.status(400).json({ error: "SportyBet rejected all groups." });
        res.json({ codes: generated });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', () => { console.log(`Server running on port ${PORT}`); });