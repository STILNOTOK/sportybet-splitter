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

// ★★★ STRICT MAPPING: ONLY 4 FIELDS FOR MCP SERVER ★★★
function formatSelectionsForMCP(group) {
    return group.map(g => {
        let marketId = "1";
        let outcomeId = "1";
        let specifier = undefined;

        // Extract exact nested IDs from the Direct API response
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

        const sel = { 
            eventId: g.eventId, 
            marketId: marketId, 
            outcomeId: outcomeId 
        };
        
        if (specifier && specifier.trim() !== '') {
            sel.specifier = specifier;
        }
        
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
                    out.innerText = "⏳ Processing " + action.toUpperCase() + "... (Basketball may take longer)";
                    
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

// Read the original code
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

// Book a group with replacement logic
async function tryBookGroup(initialGroup, fullPool, isStrict) {
    let currentGroup = [...initialGroup];
    let attempts = 0;
    let deadEventIds = new Set();
    let usedIds = new Set(initialGroup.map(m => m.eventId)); // Track used so we don't pick same game twice in strict

    while (currentGroup.length > 0 && attempts < 15) {
        attempts++;
        const formattedSelections = formatSelectionsForMCP(currentGroup);

        try {
            const bookRes = await mcpClient.callTool({
                name: "sportybet_book_bet",
                arguments: { selections: formattedSelections }
            });

            const bookData = parseMCPResponse(bookRes);
            const generatedCode = bookData.shareCode || bookData.bookingCode || (bookData.data && (bookData.data.shareCode || bookData.data.bookingCode));

            if (bookData && bookData.success === true && generatedCode) {
                return { success: true, code: generatedCode, odds: bookData.combinedOdds || 'N/A' };
            } 
            
            // Handle suspended matches
            if (bookData && bookData.error && bookData.error.code === "VALIDATION_FAILED" && bookData.error.details) {
                // It could be multiple problems. We only drop the first one and retry.
                const badEventId = bookData.error.details[0].eventId;
                console.log(`⚠️ Match ${badEventId} suspended. Replacing...`);
                deadEventIds.add(badEventId);
                
                // Remove bad match
                currentGroup = currentGroup.filter(m => m.eventId !== badEventId);
                
                // Try to fill the gap
                for (const m of fullPool) {
                    if (currentGroup.length >= initialGroup.length) break;
                    // In strict mode, don't pick used matches. In shuffle, usedIds is empty.
                    if (!deadEventIds.has(m.eventId) && !currentGroup.find(x => x.eventId === m.eventId)) {
                        if (isStrict && usedIds.has(m.eventId)) continue; // Strict mode: skip used
                        currentGroup.push(m);
                        if (isStrict) usedIds.add(m.eventId);
                    }
                }
            } else {
                console.log(`❌ Rejected by API:`, JSON.stringify(bookData));
                return { success: false };
            }
        } catch (err) {
            console.log(`❌ Error:`, err.message);
            return { success: false };
        }
        await new Promise(r => setTimeout(r, 2500)); // 2.5s delay for basketball odds
    }
    return { success: false };
}

// 1. STRICT SPLIT (No overlapping games)
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

            if (initialGroup.length < groupSize) {
                console.log("Ran out of unique matches for strict split.");
                break;
            }

            const result = await tryBookGroup(initialGroup, availablePool, true);
            if (result.success) {
                generated.push({ code: result.code, odds: result.odds });
            }
        }

        res.json({ total: matches.length, codes: generated });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// 2. SHUFFLE (Allows overlapping games)
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
            const shuffledPool = shuffleArray(matches);
            const initialGroup = shuffledPool.slice(0, groupSize);
            
            // False means it's not strict, so it can reuse matches
            const result = await tryBookGroup(initialGroup, shuffledPool, false);
            if (result.success) {
                generated.push({ code: result.code, odds: result.odds });
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