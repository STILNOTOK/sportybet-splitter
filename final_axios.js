const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const BASE = 'https://www.sportybet.com';

// STRICT HEADERS TO BYPASS CLOUDFLARE
const HEADERS = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Current-Country': 'NG',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    'Referer': 'https://www.sportybet.com/ng/',
    'Origin': 'https://www.sportybet.com',
    'X-Requested-With': 'XMLHttpRequest'
};

app.get('/', (req, res) => {
    res.send(`
        <body style="background: #121212; color: white; padding: 20px; font-family: sans-serif; text-align: center;">
            <h1 style="color: #00e676;">SportyBet Splitter (Final)</h1>
            <p style="color: #888;">Use a code with 10-15 upcoming matches.</p>
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
                            text += "❌ SportyBet rejected all combinations.\\n";
                            text += "🔍 REASON:\\n" + data.lastError;
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

function buildGroup(allMatches, size) {
    const shuffled = [...allMatches].sort(() => Math.random() - 0.5);
    const group = [];
    const usedEventIds = new Set();

    for (const match of shuffled) {
        if (!usedEventIds.has(match.eventId)) {
            group.push(match);
            usedEventIds.add(match.eventId);
        }
        if (group.length === size) break;
    }
    return group;
}

app.get('/split', async (req, res) => {
    try {
        const code = req.query.code;
        const size = parseInt(req.query.size);
        const max = parseInt(req.query.max);
        
        console.log(`\n--- PROCESSING: ${code} ---`);

        // 1. Read Code
        const readRes = await axios.get(`${BASE}/api/ng/orders/share/${code}?t=${Date.now()}`, { headers: HEADERS });
        const json = readRes.data;

        if (!json || !json.data) {
            return res.json({ error: "Invalid code or blocked by SportyBet." });
        }

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

        if (uniqueMatches.length < size) {
            return res.json({ error: `Only ${uniqueMatches.length} unique matches found. Cannot make groups of ${size}.` });
        }

        const generated = [];
        let lastError = "None";
        
        for (let i = 0; i < max; i++) {
            console.log(`Generating Group ${i+1}...`);
            
            let currentGroup = buildGroup(uniqueMatches, size);
            let success = false;
            let attempts = 0;

            // Retry up to 5 times per group
            while (!success && currentGroup.length > 0 && attempts < 5) { 
                attempts++;
                
                const selections = currentGroup.map(m => {
                    const sel = {
                        eventId: m.eventId,
                        marketId: String(m.marketId),
                        outcomeId: String(m.outcomeId)
                    };
                    if (m.specifier && typeof m.specifier === 'string' && m.specifier.trim() !== '') {
                        sel.specifier = m.specifier;
                    }
                    return sel;
                });

                try {
                    // EXACT PAYLOAD YOU FOUND
                    const payload = { 
                        products: [1],
                        source: "web",
                        acceptOddsChanges: true,
                        selections
                    };
                    
                    await new Promise(r => setTimeout(r, 2000));

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
                        lastError = JSON.stringify(bookData); 
                        console.log(`❌ Rejected:`, lastError);
                        
                        // Remove bad match if provided
                        if (bookData && bookData.data && bookData.data.unavailableOutcomes) {
                            const badId = bookData.data.unavailableOutcomes[0].eventId;
                            currentGroup = currentGroup.filter(m => m.eventId !== badId);
                        } else {
                            currentGroup.pop();
                        }
                    }
                } catch (err) {
                    lastError = err.response ? JSON.stringify(err.response.data) : err.message;
                    console.log(`❌ Error:`, lastError);
                    currentGroup.pop();
                }
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        res.json({ total: uniqueMatches.length, codes: generated, lastError: lastError });

    } catch (e) {
        console.error("SERVER ERROR:", e.message);
        res.json({ error: e.message });
    }
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});