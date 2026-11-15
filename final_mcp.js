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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildGroup(allMatches, size) {
    const shuffled = shuffle([...allMatches]);
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

// ★★★ DYNAMIC MAPPING FOR ALL SPORTS ★★★
function formatSelectionsForMCP(group) {
    return group.map(g => {
        let marketId = "1";
        let outcomeId = "1";
        let specifier = undefined;
        let sportId = "sr:sport:1"; // Default to Football
        let productId = 3;

        // Dig into the nested markets array for exact IDs
        if (g.markets && g.markets.length > 0) {
            const market = g.markets[0];
            marketId = String(market.id);
            if (market.specifier) specifier = market.specifier;
            if (market.product) productId = market.product;

            if (market.outcomes && market.outcomes.length > 0) {
                outcomeId = String(market.outcomes[0].id);
            }
        } 
        
        // Pull the exact sport ID (Football vs Basketball)
        if (g.sport && g.sport.id) {
            sportId = g.sport.id;
        }

        const sel = {
            eventId: g.eventId,
            marketId: marketId,
            outcomeId: outcomeId,
            sportId: sportId,
            productId: productId
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
            <h1 style="color: #00e676;">SportyBet Splitter (Final)</h1>
            <input type="text" id="code" placeholder="Type code here" style="padding: 10px; font-size: 16px; text-transform: uppercase;">
            <input type="number" id="size" value="5" style="padding: 10px; width: 60px;">
            <input type="number" id="max" value="1" style="padding: 10px; width: 60px;"> 
            <button onclick="split()" style="padding: 10px 20px; font-size: 16px; background: #00e676; border: none; font-weight: bold; cursor: pointer;">SPLIT</button>
            <pre id="out" style="background: #000; color: #00e676; padding: 20px; margin-top: 20px; text-align: left; font-size: 14px; white-space: pre-wrap;"></pre>

            <script>
                async function split() {
                    const code = document.getElementById('code').value.trim();
                    const out = document.getElementById('out');
                    out.innerText = "⏳ Processing... (This may take a minute)";
                    
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
                            text += "❌ SportyBet rejected all combinations.";
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

        // Read using Direct API
        const readRes = await fetch(`${BASE}/api/ng/orders/share/${code}?t=${Date.now()}`, { headers: HEADERS });
        const json = await readRes.json();

        if (!json || !json.data) {
            return res.json({ error: "Invalid code or blocked by SportyBet." });
        }

        let allMatches = [];
        if (json.data.outcomes) allMatches = json.data.outcomes;
        else if (json.data.ticket && json.data.ticket.selections) allMatches = json.data.ticket.selections;

        if (allMatches.length === 0) {
            return res.json({ error: "Could not read matches." });
        }

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
        
        for (let i = 0; i < max; i++) {
            let currentGroup = buildGroup(uniqueMatches, size);
            let success = false;
            let attempts = 0;

            // Increased retries for volatile sports like Basketball
            while (!success && currentGroup.length > 0 && attempts < 8) {
                attempts++;
                
                const formattedSelections = formatSelectionsForMCP(currentGroup);

                try {
                    // Book using MCP Server
                    const bookRes = await mcpClient.callTool({
                        name: "sportybet_book_bet",
                        arguments: { selections: formattedSelections }
                    });

                    const bookData = parseMCPResponse(bookRes);
                    const generatedCode = bookData.shareCode || bookData.bookingCode || (bookData.data && (bookData.data.shareCode || bookData.data.bookingCode));

                    if (bookData && bookData.success === true && generatedCode) {
                        console.log(`✅ Success: ${generatedCode}`);
                        generated.push({
                            code: generatedCode,
                            odds: bookData.combinedOdds || 'N/A'
                        });
                        success = true;
                    } else if (bookData && bookData.error && bookData.error.code === "VALIDATION_FAILED" && bookData.error.details) {
                        const badEventId = bookData.error.details[0].eventId;
                        console.log(`⚠️ Match ${badEventId} suspended. Retrying...`);
                        // Remove the suspended match
                        currentGroup = currentGroup.filter(m => m.eventId !== badEventId);
                    } else {
                        console.log(`❌ Rejected:`, JSON.stringify(bookData));
                        break; 
                    }
                } catch (err) {
                    console.log(`❌ Error:`, err.message);
                    break;
                }
                // 3 second delay gives basketball odds time to stabilize
                await new Promise(r => setTimeout(r, 3000));
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        if (generated.length === 0) {
            return res.json({ error: "SportyBet rejected all groups. Matches may be live." });
        }

        res.json({ total: uniqueMatches.length, codes: generated });

    } catch (e) {
        console.error("SERVER ERROR:", e.message);
        res.json({ error: e.message });
    }
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server running on port ${PORT}`);
    await initMCP();
});