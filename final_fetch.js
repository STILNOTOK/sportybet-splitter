const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// CONFIGURATION (Use Environment Variables on Render)
// ==========================================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || 'sk_test_9b02d6f44690eff1e94f0b2fb9c0f1a288e34548';
const PLAN_CODE = process.env.PAYSTACK_PLAN_CODE || 'PLN_tnjl24i4xux445x';
const BASE_URL = process.env.BASE_URL || 'https://sportybet-splitter.onrender.com'; // Change to your Render URL in production

// MOCK DATABASE (Replace with MongoDB/PostgreSQL later)
// This stores emails and their premium status
const userDB = {}; 
// Format: { "user@example.com": { isPremium: true, validUntil: 1710000000000 } }

// ==========================================
// 1. PAYSTACK: INITIALIZE SUBSCRIPTION
// ==========================================
app.post('/api/subscribe', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });

    try {
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: email,
                plan: PLAN_CODE, // This automatically creates a recurring subscription
                callback_url: `${BASE_URL}/verify-payment?email=${encodeURIComponent(email)}`
            })
        });

        const data = await response.json();

        if (!data.status) {
            return res.status(400).json({ error: data.message });
        }

        // Send the checkout URL to the frontend to redirect the user
        res.json({ url: data.data.authorization_url });
    } catch (error) {
        console.error("Paystack Init Error:", error);
        res.status(500).json({ error: "Failed to initialize payment." });
    }
});

// ==========================================
// 2. PAYSTACK: VERIFY PAYMENT (Callback)
// ==========================================
app.get('/verify-payment', async (req, res) => {
    const { reference, email } = req.query;

    if (!reference) return res.redirect('/?error=missing_reference');

    try {
        const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET}`
            }
        });

        const data = await response.json();

        if (data.status && data.data.status === 'success') {
            // ✅ PAYMENT SUCCESSFUL! Upgrade the user in your database.
            // In a real app, you would use: await User.updateOne({ email }, { isPremium: true, validUntil: Date.now() + 7 * 24 * 60 * 60 * 1000 });
            userDB[email] = {
                isPremium: true,
                validUntil: Date.now() + (7 * 24 * 60 * 60 * 1000) // 1 week from now
            };
            
            console.log(`✅ User ${email} upgraded to Premium!`);
            res.redirect(`/?premium=success&email=${encodeURIComponent(email)}`);
        } else {
            res.redirect('/?error=payment_failed');
        }
    } catch (error) {
        res.redirect('/?error=verification_error');
    }
});

// ==========================================
// 3. PAYSTACK: WEBHOOK (Handles recurring payments)
// ==========================================
app.post('/paystack/webhook', (req, res) => {
    const event = req.body;

    // Paystack sends 'charge.success' when the first payment is made
    // and for every recurring weekly charge.
    if (event.event === 'charge.success') {
        const customerEmail = event.data.customer.email;
        const planId = event.data.plan?.plan_code;

        if (planId === PLAN_CODE) {
            // Extend the user's premium access by another week
            userDB[customerEmail] = {
                isPremium: true,
                validUntil: Date.now() + (7 * 24 * 60 * 60 * 1000)
            };
            console.log(`🔄 Recurring payment received for ${customerEmail}. Extended by 1 week.`);
        }
    }

    // Always return 200 to tell Paystack you received the webhook
    res.sendStatus(200);
});

// ==========================================
// 4. CHECK PREMIUM STATUS (For your Split/Shuffle routes)
// ==========================================
function isUserPremium(email) {
    const user = userDB[email];
    if (!user || !user.isPremium) return false;
    if (Date.now() > user.validUntil) {
        user.isPremium = false; // Expired
        return false;
    }
    return true;
}

// --- YOUR EXISTING SPLIT & SHUFFLE ENDPOINTS ---
// (Keep your existing /api/split and /api/shuffle logic here)
// You will add this check at the beginning of those routes:

/* 
app.post('/api/split', async (req, res) => {
    const { originalCode, groupSize, maxGroups, userEmail } = req.body;
    
    // Check if user is premium
    if (!isUserPremium(userEmail)) {
        // If you want to allow 2 free splits, you would check a counter here.
        // For now, let's reject if not premium (or implement your free limit logic)
        // return res.status(403).json({ error: "Upgrade to Premium for unlimited splits." });
    }
    
    // ... rest of your split logic
});
*/

const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});