const express = require('express');
const app = express();
app.use(express.json());

async function safeJSON(response) {
    const text = await response.text();
    try { return JSON.parse(text); } catch (e) { return null; }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="background:#121212; color:#fff; padding:20px; font-family:sans-serif; text-align:center;">
            <h1 style="color:#00e676;">SportyBet Stable Splitter</h1>
            <input type="text" id="code" placeholder="Code" style="padding:10px; text-transform:uppercase;">
            <input type="number" id="size" value="10" style="padding:10px; width:60px;">
            <input type="number" id="max" value="4" style="padding:10px; width:60px;">
            <button onclick="split()" style="padding:10px 20px; background:#00e676; font-weight:bold;">SPLIT</button>
            <pre id="out" style="background:#000; color:#0f0; padding:20px; text-align:left; margin-top:20px;"></pre>
            <script>
                async function split() {
                    const code = document.getElementById('code').value.trim();
                    const out = document.getElementById('out');
                    out.innerText = "Processing...";
                    const res = await fetch('/split?code=' + code + '&size=' + document.getElementById('size').value + '&max=' + document.getElementById('max').value);
                    const data = await res.json();
                    out.innerText = data.error ? "ERROR: " + data.error : "GENERATED CODES:\\n" + data.codes.map(c => "Group: " + c.code + " (Odds: " + c.odds + ")").join("\\n");
                }
            </script>
        </body>
    `);
});

app.get('/split', async (req, res) => {
    try {
        const { code, size, max } = req.query;
        const groupSize = parseInt(size);
        const maxGroups = parseInt(max);

        // EXACT headers from verified MCP documentation
        const headers = { 
            'Accept': 'application/json', 
            'Content-Type': 'application/json',
            'Current-Country': 'NG', 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        // 1. Read the code
        const readRes = await fetch(`https://www.sportybet.com/api/ng/orders/share/${code}?t=${Date.now()}`, { headers, cache: 'no-store' });
        const readData = await safeJSON(readRes);

        if (!readData || !readData.data) {
            return res.json({ error: "Invalid code or blocked by SportyBet." });
        }

        let matches = readData.data.outcomes || (readData.data.ticket && readData.data.ticket.selections) || [];
        if (matches.length < groupSize) {
            return res.json({ error: `Only ${matches.length} matches found. Need at least ${groupSize}.` });
        }

        const generated = [];

        // 2. Generate groups with stable retry logic
        for (let i = 0; i < maxGroups; i++) {
            let success = false;
            let attempts = 0;

            while (!success && attempts < 3) { // MAX 3 ATTEMPTS
                attempts++;
                
                // Shuffle and pick
                const shuffled = [...matches].sort(() => Math.random() - 0.5);
                const group = shuffled.slice(0, groupSize);

                const selections = group.map(m => ({
                    eventId: m.eventId,
                    marketId: String(m.marketId),
                    outcomeId: String(m.outcomeId),
                    ...(m.specifier ? { specifier: m.specifier } : {})
                }));

                // CRITICAL: Wait 3 seconds before booking to avoid rate limits
                await new Promise(r => setTimeout(r, 3000));

                const bookRes = await fetch('https://www.sportybet.com/api/ng/orders/share', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ selections })
                });
                const bookData = await safeJSON(bookRes);

                if (bookData && bookData.data && bookData.data.shareCode) {
                    generated.push({
                        code: bookData.data.shareCode,
                        odds: bookData.data.combinedOdds || 'N/A'
                    });
                    success = true;
                } else {
                    console.log(`Attempt ${attempts} failed:`, JSON.stringify(bookData));
                    // Wait 3 more seconds before retrying
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        }

        res.json({ codes: generated });

    } catch (e) {
        res.json({ error: e.message });
    }
});

app.listen(9000, () => console.log("Stable server on http://localhost:9000"));