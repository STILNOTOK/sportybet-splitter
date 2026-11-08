const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send(`
        <body style="background: #121212; color: white; padding: 20px; font-family: sans-serif;">
            <h2>Raw API Test</h2>
            <input type="text" id="code" placeholder="Type code here" style="padding: 10px; font-size: 16px;">
            <button onclick="test()" style="padding: 10px; font-size: 16px;">TEST RAW DATA</button>
            <pre id="out" style="background: #000; color: #00e676; padding: 20px; margin-top: 20px; font-size: 12px; overflow-x: auto;"></pre>

            <script>
                async function test() {
                    const code = document.getElementById('code').value.trim();
                    document.getElementById('out').innerText = "Loading...";
                    
                    const res = await fetch('/raw?code=' + code);
                    const text = await res.text();
                    document.getElementById('out').innerText = text;
                }
            </script>
        </body>
    `);
});

app.get('/raw', async (req, res) => {
    try {
        const code = req.query.code;
        console.log("Browser requested raw data for code:", code);

        // We add a timestamp to FORCE SportyBet to give us fresh data
        const url = `https://www.sportybet.com/api/ng/orders/share/${code}?t=${Date.now()}`;
        
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'Current-Country': 'NG',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            cache: 'no-store'
        });

        const data = await response.json();
        
        // Just send the raw JSON back to the screen
        res.send(JSON.stringify(data, null, 2));

    } catch (error) {
        res.send("Error: " + error.message);
    }
});

app.listen(9000, () => console.log("Raw test server on http://localhost:9000"));