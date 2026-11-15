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

app.get('/', (req, res) => {
    res.send(`
        <body style="background: #121212; color: white; padding: 20px; font-family: sans-serif; text-align: center;">
            <h1 style="color: #00e676;">SportyBet Splitter (Hybrid Mode)</h1>
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

        // STEP 1: Read using Direct API to get EXACT marketIds and outcomeIds
        console.log("Reading code via Direct API...");
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

        // Log the first leg to confirm we have the exact numbers
        if (allMatches.length > 0) {
            console.log("🔍 SAMPLE LEG DATA:", JSON.stringify(allMatches[0], null, 2));
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
            console.log(`Generating Group ${i+1}...`);
            let currentGroup = buildGroup(uniqueMatches, size);
            let success = false;
            let attempts = 0;

            while (!success && currentGroup.length > 0 && attempts < 5) {
                attempts++;
                
                // Use the exact IDs from the Direct API response
                const formattedSelections = currentGroup.map(g => {
                    const sel = {
                        eventId: g.eventId,
                        marketId: String(g.marketId),
                        outcomeId: String(g.outcomeId)
                    };
                    if (g.specifier && typeof g.specifier === 'string' && g.specifier.trim() !== '') {
                        sel.specifier = g.specifier;
                    }
                    return sel;
                });

                try {
                    // STEP 2: Book using MCP Server to bypass Cloudflare
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
                        currentGroup = currentGroup.filter(m => m.eventId !== badEventId);
                    } else {
                        console.log(`❌ Rejected:`, JSON.stringify(bookData));
                        break; 
                    }
                } catch (err) {
                    console.log(`❌ Error:`, err.message);
                    break;
                }
                await new Promise(r => setTimeout(r, 1500));
            }
            await new Promise(r => setTimeout(r, 1500));
        }

        if (generated.length === 0) {
            return res.json({ error: "SportyBet rejected all groups." });
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