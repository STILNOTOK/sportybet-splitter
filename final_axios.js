const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const BASE = 'https://www.sportybet.com';

const HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Current-Country': 'NG',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Referer': 'https://www.sportybet.com/ng/',
    'Origin': 'https://www.sportybet.com'
};

app.get('/', (req, res) => {
    res.send(`
        <body style="background: #121212; color: white; padding: 20px; font-family: sans-serif; text-align: center;">
            <h1 style="color: #00e676;">SportyBet Splitter</h1>
            <p style="color: #888;">Make sure the matches are starting later today.</p>
            <input type="text" id="code" placeholder="Type code here" style="padding: 10px; font-size: 16px; text-transform: uppercase;">
            <input type="number" id="size" value="5" style="padding: 10px; width: 60px;">
            <input type="number" id="max" value="2" style="padding: 10px; width: 60px;">
            <button onclick="split()" style="padding: 10px 20px; font-size: 16px; background: #00e676; border: none; font-weight: bold; cursor: pointer;">SPLIT</button>
            <pre id="out" style="background: #000; color: #00e676; padding: 20px; margin-top: 20px; text-align: left; font-size: 14px; white-space: pre-wrap;"></pre>

            <script>
                async function split() {
                    const code = document.getElementById('code').value.trim();
                    const out = document.getElementById('out');
                    out.innerText = "⏳ Processing...";
                    
                    try {
                        const res = await fetch('/split?code=' + code + '&size=' + document.getElementById('size').value + '&max=' + document.getElementById('max').value);
                        const data = await res.json();
                        
                        if (data.error) {
                            out.innerText = "❌ ERROR: " + data.error;
                            return;
                        }
                        
                        let text = "✅ Found " + data.total + " matches in code " + code + "\\n\\n";
                        text += "GENERATED CODES:\\n";
                        if (data.codes.length === 0) {
                            text += "SportyBet rejected all combinations. (Matches may have started or odds changed).";
                        } else {
                            data.codes.forEach((c, i) => {
                                text += "Group " + (i+1) + ": " + c.code + " (Odds: " + c.odds + ")\\n";
                            });
                        }
                        out.innerText = text;
                    } catch (e) {
                        out.innerText = "❌ Network Error: " + e.message;
                    }
                }
            </script>
        </body>
    `);
});

app.get('/split', async (req, res) => {
    try {
        const code = req.query.code;
        const size = parseInt(req.query.size);
        const max = parseInt(req.query.max);
        
        console.log(`\n--- PROCESSING: ${code} ---`);

        const readRes = await axios.get(`${BASE}/api/ng/orders/share/${code}?t=${Date.now()}`, { headers: HEADERS });
        const json = readRes.data;

        if (!json || !json.data) {
            return res.json({ error: "Invalid code or blocked by SportyBet." });
        }

        let allMatches = [];
        if (json.data.outcomes) allMatches = json.data.outcomes;
        else if (json.data.ticket && json.data.ticket.selections) allMatches = json.data.ticket.selections;

        if (allMatches.length === 0) {
            return res.json({ error: "No matches found in this code." });
        }

        console.log(`Found ${allMatches.length} matches.`);
        
        if (allMatches.length < size) {
            return res.json({ error: `Only ${allMatches.length} matches found. Cannot make groups of ${size}.` });
        }

        const generated = [];
        
        for (let i = 0; i < max; i++) {
            console.log(`Generating Group ${i+1}...`);
            
            let success = false;
            let attempts = 0;

            // Retry up to 3 times per group
            while (!success && attempts < 3) {
                attempts++;
                
                const shuffled = [...allMatches].sort(() => Math.random() - 0.5);
                const group = shuffled.slice(0, size);

                // ADDED productId and sportId back
                const selections = group.map(m => {
                    const sel = {
                        eventId: m.eventId,
                        marketId: String(m.marketId),
                        outcomeId: String(m.outcomeId),
                        productId: m.productId || 3,
                        sportId: m.sportId || "sr:sport:1"
                    };
                    if (m.specifier && m.specifier.trim() !== '') sel.specifier = m.specifier;
                    return sel;
                });

                try {
                    const payload = { selections };
                    const bookRes = await axios.post(`${BASE}/api/ng/orders/share`, payload, { headers: HEADERS });
                    const bookData = bookRes.data;

                    if (bookData && bookData.data && bookData.data.shareCode) {
                        console.log(`✅ Success: ${bookData.data.shareCode}`);
                        generated.push({
                            code: bookData.data.shareCode,
                            odds: bookData.data.combinedOdds || 'N/A'
                        });
                        success = true;
                    } else {
                        console.log(`❌ Attempt ${attempts} Rejected:`, JSON.stringify(bookData));
                    }
                } catch (err) {
                    console.log(`❌ Attempt ${attempts} Error:`, err.response ? JSON.stringify(err.response.data) : err.message);
                }

                if (!success) {
                    await new Promise(r => setTimeout(r, 2000)); // Wait 2s before retry
                }
            }

            await new Promise(r => setTimeout(r, 1000)); // Wait 1s before next group
        }

        res.json({ total: allMatches.length, codes: generated });

    } catch (e) {
        console.error("SERVER ERROR:", e.message);
        res.json({ error: e.message });
    }
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});