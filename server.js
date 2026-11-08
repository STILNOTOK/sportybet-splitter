const express = require('express');
const app = express();
app.use(express.json());

const BASE = 'https://www.sportybet.com';
const HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Current-Country': 'NG',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

// 1. Serve the entire website directly from this file
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>SportyBet Splitter V2</title>
    <style>
        body { background: #0f0f0f; color: white; font-family: 'Segoe UI', sans-serif; text-align: center; padding: 40px; }
        .container { max-width: 600px; margin: 0 auto; background: #1a1a1a; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        h1 { color: #00e676; margin-bottom: 5px; }
        p { color: #888; font-size: 14px; margin-bottom: 30px; }
        input, button { padding: 12px; font-size: 16px; margin: 5px; border-radius: 6px; border: 1px solid #333; }
        input { background: #2a2a2a; color: white; width: 60%; }
        input[type="number"] { width: 60px; }
        button { background: #00e676; color: black; font-weight: bold; cursor: pointer; width: 200px; border: none; }
        button:hover { background: #00c853; }
        button:disabled { background: #555; cursor: not-allowed; }
        #results { margin-top: 30px; text-align: left; }
        .card { background: #222; padding: 15px; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid #00e676; }
        .error { color: #ff5252; font-weight: bold; background: #330000; padding: 10px; border-radius: 6px; border-left: 4px solid #ff5252;}
    </style>
</head>
<body>
    <div class="container">
        <h1>SportyBet Splitter V2</h1>
        <p>100% Clean Build. No Cache. No Ghosts.</p>

        <input type="text" id="code" placeholder="Enter Code (e.g. Q3VG9D)" style="text-transform: uppercase;" autocomplete="off">
        <br>
        <label>Matches per code: </label><input type="number" id="size" value="10">
        <label>Max codes: </label><input type="number" id="max" value="4">
        <br><br>
        <button id="btn" onclick="start()">Split Code</button>

        <div id="results"></div>
    </div>

    <script>
        async function start() {
            const code = document.getElementById('code').value.trim();
            const btn = document.getElementById('btn');
            const results = document.getElementById('results');

            if(!code) { alert("Please enter a code!"); return; }

            btn.disabled = true;
            results.innerHTML = "<p style='color:#00e676;'>⏳ Reading code from SportyBet...</p>";

            try {
                const res = await fetch('/split', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        code: code,
                        size: parseInt(document.getElementById('size').value),
                        max: parseInt(document.getElementById('max').value)
                    })
                });

                const data = await res.json();

                if(data.error) {
                    results.innerHTML = '<div class="error">❌ ' + data.error + '</div>';
                } else {
                    let html = '<h3 style="color:#00e676;">✅ Read ' + data.total + ' Matches from ' + code + '</h3><br>';
                    
                    if(data.codes.length === 0) {
                        html += '<div class="error">❌ SportyBet rejected the groups. Try a different code.</div>';
                    } else {
                        data.codes.forEach((c, i) => {
                            html += '<div class="card">' +
                                        '<strong>Group ' + (i+1) + '</strong><br>' +
                                        'Code: <span style="color:#00e676; font-size:18px;">' + c.code + '</span><br>' +
                                        '<span style="color:#888; font-size:12px;">Odds: ' + c.odds + '</span>' +
                                     '</div>';
                        });
                    }
                    results.innerHTML = html;
                }
            } catch(e) {
                results.innerHTML = '<div class="error">Network Error: ' + e.message + '</div>';
            } finally {
                btn.disabled = false;
            }
        }
    </script>
</body>
</html>
    `);
});

// 2. The Engine
app.post('/split', async (req, res) => {
    try {
        const { code, size, max } = req.body;
        console.log(`\n--- NEW CODE INPUT: ${code} ---`);

        // Read code
        const readRes = await fetch(`${BASE}/api/ng/orders/share/${code}`, { headers: HEADERS });
        const readData = await readRes.json();

        if (!readData.data || !readData.data.outcomes) {
            return res.status(400).json({ error: "Invalid or expired code." });
        }

        const matches = readData.data.outcomes;
        console.log(`Found ${matches.length} matches.`);

        if (matches.length < size) {
            return res.status(400).json({ error: `Only ${matches.length} matches found. Cannot make groups of ${size}.` });
        }

        const generated = [];

        // Generate
        for (let i = 0; i < max; i++) {
            console.log(`Generating group ${i+1}...`);
            
            // Shuffle
            const shuffled = [...matches].sort(() => Math.random() - 0.5);
            const group = shuffled.slice(0, size);

            // Format
            const selections = group.map(m => ({
                eventId: m.eventId,
                marketId: String(m.marketId || "1"),
                outcomeId: String(m.outcomeId || "1"),
                ...(m.specifier ? { specifier: m.specifier } : {})
            }));

            // Book
            const bookRes = await fetch(`${BASE}/api/ng/orders/share`, {
                method: 'POST',
                headers: HEADERS,
                body: JSON.stringify({ selections })
            });
            const bookData = await bookRes.json();

            if (bookData && bookData.data && bookData.data.shareCode) {
                console.log(`✅ Success: ${bookData.data.shareCode}`);
                generated.push({
                    code: bookData.data.shareCode,
                    odds: bookData.data.combinedOdds || 'N/A'
                });
            } else {
                console.log(`❌ Rejected`);
            }

            await new Promise(r => setTimeout(r, 1500));
        }

        res.json({ total: matches.length, codes: generated });

    } catch (e) {
        console.error("SERVER ERROR:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Port 4000 - Completely new port
app.listen(4000, () => {
    console.log("-----------------------------------------");
    console.log(`✅ SERVER RUNNING ON http://localhost:4000`);
    console.log("-----------------------------------------");
});