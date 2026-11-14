const express = require('express');
const app = express();
app.use(express.json());

const BASE = 'https://www.sportybet.com';

// Native fetch headers (Closer to real browser)
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
            <h1 style="color: #00e676;">SportyBet Splitter (Fetch Mode)</h1>
            <p style="color: #888;">Use a code with 10-15 upcoming matches.</p>
            <input type="text" id="code" placeholder="Type code here" style="padding: 10px; font-size: 16px; text-transform: uppercase;">
            <input type="number" id="size" value="5" style="padding: 10px; width: 60px;">
            <input type="number" id="max" value="1" style="padding: 10px; width: 60px;"> 
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

        // 1. Read the code
        const readRes = await fetch(`${BASE}/api/ng/orders/share/${code}?t=${Date.now()}`, { headers: HEADERS });
        const json = await readRes.json();

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

            while (!success && currentGroup.length > 0 && attempts < 5) { 
                attempts++;
                
                // STRICT MAPPING: Only eventId, marketId, outcomeId, specifier
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
                    // EXACT MCP PAYLOAD (No products, no source)
                    const payload = { selections };
                    
                    // Wait 2 seconds to avoid rate limit
                    await new Promise(r => setTimeout(r, 2000));

                    const bookRes = await fetch(`${BASE}/api/ng/orders/share`, {
                        method: 'POST',
                        headers: HEADERS,
                        body: JSON.stringify(payload)
                    });
                    
                    const bookData = await bookRes.json();

                    const generatedCode = bookData.shareCode || bookData.bookingCode || (bookData.data && (bookData.data.shareCode || bookData.data.bookingCode));

                    if (bookData && bookData.success === true && generatedCode) {
                        console.log(`✅ Success: ${generatedCode}`);
                        generated.push({
                            code: generatedCode,
                            odds: bookData.combinedOdds || 'N/A'
                        });
                        success = true;
                    } else if (bookData && bookData.error && bookData.error.code === "VALIDATION_FAILED" && bookData.error.details) {
                        // Smart retry: remove the bad match
                        const badEventId = bookData.error.details[0].eventId;
                        console.log(`⚠️ Match ${badEventId} suspended. Retrying...`);
                        currentGroup = currentGroup.filter(m => m.eventId !== badEventId);
                    } else {
                        lastError = JSON.stringify(bookData); 
                        console.log(`❌ Rejected:`, lastError);
                        currentGroup.pop();
                    }
                } catch (err) {
                    lastError = err.message;
                    console.log(`❌ Error:`, lastError);
                    currentGroup.pop();
                }
            }
            await new Promise(r => setTimeout(r, 1500));
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