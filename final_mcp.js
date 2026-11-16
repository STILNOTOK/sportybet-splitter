const express = require('express');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require('path');

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

let mcpClient;

async function initMCP() {
    const transport = new StdioClientTransport({
        command: "node",
        args: [path.join(__dirname, "dist", "index.js")] 
    });
    mcpClient = new Client({ name: "splitter-app", version: "1.0.0" }, { capabilities: {} });
    await mcpClient.connect(transport);
    console.log("✅ Connected to SportyBet MCP Server!");
}

function parseMCPResponse(response) {
    if (response.content && response.content[0] && response.content[0].text) {
        try { return JSON.parse(response.content[0].text); } 
        catch (e) { return response.content[0].text; }
    }
    return response;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ★★★ EXACT NESTED MAPPING FOR ALL SPORTS ★★★
function formatSelectionsForMCP(group) {
    return group.map(g => {
        let marketId = "1";
        let outcomeId = "1";
        let specifier = undefined;
        let sportId = "sr:sport:1";
        let productId = 3;

        if (g.markets && g.markets.length > 0) {
            const market = g.markets[0];
            marketId = String(market.id);
            if (market.specifier) specifier = market.specifier;
            if (market.product) productId = market.product;
            if (market.outcomes && market.outcomes.length > 0) {
                outcomeId = String(market.outcomes[0].id);
            }
        } 
        
        if (g.sport && g.sport.id) sportId = g.sport.id;

        const sel = { eventId: g.eventId, marketId, outcomeId, sportId, productId };
        if (specifier && specifier.trim() !== '') sel.specifier = specifier;
        return sel;
    });
}

app.get('/', (req, res) => {
    res.send(`
        <body style="background: #121212; color: white; padding: 20px; font-family: sans-serif; text-align: center;">
            <h1 style="color: #00e676;">SportyBet Splitter & Shuffler</h1>
            
            <div style="margin-bottom: 20px;">
                <input type="text" id="code" placeholder="Type code here" style="padding: 10px; font-size: 16px; text-transform: uppercase;">
                <br><br>
                <label>Matches per Code: </label>
                <input type="number" id="size" value="5" style="padding: 10px; width: 60px;">
                
                <label style="margin-left: 20px;">Max Codes: </label>
                <input type="number" id="max" value="2" style="padding: 10px; width: 60px;"> 
            </div>

            <button onclick="runAction('split')" style="padding: 10px 20px; font-size: 16px; background: #00e676; border: none; font-weight: bold; cursor: pointer; margin-right: 10px;">STRICT SPLIT</button>
            <button onclick="runAction('shuffle')" style="padding: 10px 20px; font-size: 16px; background: #2196f3; color: white; border: none; font-weight: bold; cursor: pointer;">SHUFFLE</button>
            
            <pre id="out" style="background: #000; color: #00e676; padding: 20px; margin-top: 20px; text-align: left; font-size: 14px; white-space: pre-wrap;"></pre>

            <script>
                async function runAction(action) {
                    const code = document.getElementById('code').value.trim();
                    const out = document.getElementById('out');
                    out.innerText = "⏳ Processing " + action.toUpperCase() + "...";
                    
                    try {
                        const res = await fetch('/' + action + '?code=' + code + '&size=' + document.getElementById('size').value + '&max=' + document.getElementById('max').value);
                        const data = await res.json();
                        
                        if (data.error) {
                            out.innerText = "❌ ERROR: " + data.error;
                            return;
                        }
                        
                        let text = "✅ Found " + data.total + " matches in code " + code + "\\n\\n";
                        text += "GENERATED CODES (" + action.toUpperCase() + "):\\n";
                        if (data.codes.length === 0) {
                            text += "❌ SportyBet rejected all combinations. Matches may have started.";
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

// HELPER: Read the original code
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

// HELPER: Book a group with MCP
async function tryBookGroup(currentGroup) {
    let success = false;
    let attempts = 0;
    let generatedCode = null;
    let odds = "N/A";
    
    while (!success && currentGroup.length > 0 && attempts < 5) {
        attempts++;
        const formattedSelections = formatSelectionsForMCP(currentGroup);

        try {
            const bookRes = await mcpClient.callTool({
                name: "sportybet_book_bet",
                arguments: { selections: formattedSelections }
            });

            const bookData = parseMCPResponse(bookRes);
            const code = bookData.shareCode || bookData.bookingCode || (bookData.data && (bookData.data.shareCode || bookData.data.bookingCode));

            if (bookData && bookData.success === true && code) {
                generatedCode = code;
                odds = bookData.combinedOdds || 'N/A';
                success = true;
            } else if (bookData && bookData.error && bookData.error.code === "VALIDATION_FAILED" && bookData.error.details) {
                const badEventId = bookData.error.details[0].eventId;
                console.log(`⚠️ Match ${badEventId} suspended. Retrying...`);
                // Remove the bad match
                currentGroup = currentGroup.filter(m => m.eventId !== badEventId);
            } else {
                console.log(`❌ Rejected:`, JSON.stringify(bookData));
                break; 
            }
        } catch (err) {
            console.log(`❌ Error:`, err.message);
            break;
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return { success, generatedCode, odds };
}

// 1. STRICT SPLIT ENDPOINT (No overlapping games)
app.get('/split', async (req, res) => {
    try {
        const { code, size, max } = req.query;
        const groupSize = parseInt(size);
        const maxGroups = parseInt(max);
        
        console.log(`\n--- STRICT SPLIT: ${code} ---`);
        const matches = await fetchMatches(code);
        if (!matches) return res.json({ error: "Invalid code or blocked." });
        if (matches.length < groupSize) return res.json({ error: "Not enough matches." });

        const generated = [];
        let availablePool = shuffleArray(matches); // Shuffle once
        let usedIds = new Set();

        for (let i = 0; i < maxGroups; i++) {
            let currentGroup = [];
            // Pick matches strictly not used yet
            for (let m of availablePool) {
                if (!usedIds.has(m.eventId)) {
                    currentGroup.push(m);
                    usedIds.add(m.eventId);
                }
                if (currentGroup.length === groupSize) break;
            }

            if (currentGroup.length < groupSize) {
                console.log("Ran out of unique matches for strict split.");
                break;
            }

            const result = await tryBookGroup(currentGroup);
            if (result.success) {
                generated.push({ code: result.generatedCode, odds: result.odds });
            }
        }

        res.json({ total: matches.length, codes: generated });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// 2. SHUFFLE ENDPOINT (Allows overlapping games)
app.get('/shuffle', async (req, res) => {
    try {
        const { code, size, max } = req.query;
        const groupSize = parseInt(size);
        const maxGroups = parseInt(max);
        
        console.log(`\n--- SHUFFLE: ${code} ---`);
        const matches = await fetchMatches(code);
        if (!matches) return res.json({ error: "Invalid code or blocked." });
        if (matches.length < groupSize) return res.json({ error: "Not enough matches." });

        const generated = [];

        for (let i = 0; i < maxGroups; i++) {
            // Shuffle the ENTIRE pool for every group
            const shuffledPool = shuffleArray(matches);
            const currentGroup = shuffledPool.slice(0, groupSize);

            const result = await tryBookGroup(currentGroup);
            if (result.success) {
                generated.push({ code: result.generatedCode, odds: result.odds });
            }
        }

        res.json({ total: matches.length, codes: generated });
    } catch (e) {
        res.json({ error: e.message });
    }
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server running on port ${PORT}`);
    await initMCP();
});