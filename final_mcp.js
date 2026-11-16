const express = require('express');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require('path');

const app = express();
app.use(express.json());

// SERVE THE HTML FRONTEND
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

function formatSelectionsForMCP(group) {
    return group.map(g => {
        let marketId = "1";
        let outcomeId = "1";
        let specifier = undefined;

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

        const sel = { eventId: g.eventId, marketId, outcomeId };
        if (specifier && specifier.trim() !== '') sel.specifier = specifier;
        return sel;
    });
}

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

async function tryBookGroup(initialGroup, fullPool, isStrict, usedIds) {
    let currentGroup = [...initialGroup];
    let attempts = 0;
    let deadEventIds = new Set();

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
                return { success: true, newCode: generatedCode, url: `http://www.sportybet.com/ng/?shareCode=${generatedCode}`, odds: bookData.combinedOdds || 'N/A', matchCount: currentGroup.length };
            } 
            
            if (bookData && bookData.error && bookData.error.code === "VALIDATION_FAILED" && bookData.error.details) {
                const badEventId = bookData.error.details[0].eventId;
                console.log(`⚠️ Match ${badEventId} suspended. Replacing...`);
                deadEventIds.add(badEventId);
                
                currentGroup = currentGroup.filter(m => m.eventId !== badEventId);
                
                // Find a replacement from the pool
                for (const m of fullPool) {
                    if (currentGroup.length >= initialGroup.length) break;
                    if (!deadEventIds.has(m.eventId) && !currentGroup.find(x => x.eventId === m.eventId)) {
                        if (isStrict && usedIds.has(m.eventId)) continue;
                        currentGroup.push(m);
                        if (isStrict) usedIds.add(m.eventId);
                    }
                }
            } else {
                console.log(`❌ Rejected:`, JSON.stringify(bookData));
                return { success: false };
            }
        } catch (err) {
            console.log(`❌ Error:`, err.message);
            return { success: false };
        }
        await new Promise(r => setTimeout(r, 2500));
    }
    return { success: false };
}

// ROUTE: STRICT SPLIT (POST)
app.post('/api/split', async (req, res) => {
    try {
        const { originalCode, groupSize, maxGroups } = req.body;
        console.log(`\n--- STRICT SPLIT: ${originalCode} ---`);
        
        const matches = await fetchMatches(originalCode);
        if (!matches) return res.status(400).json({ error: "Invalid code or blocked." });
        if (matches.length < groupSize) return res.status(400).json({ error: "Not enough matches." });

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

            if (initialGroup.length < groupSize) break;

            const result = await tryBookGroup(initialGroup, availablePool, true, globalUsedIds);
            if (result.success) generated.push(result);
        }

        if (generated.length === 0) return res.status(400).json({ error: "SportyBet rejected all groups." });
        res.json({ codes: generated });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ROUTE: SHUFFLE (POST)
app.post('/api/shuffle', async (req, res) => {
    try {
        const { originalCode, groupSize, maxGroups } = req.body;
        console.log(`\n--- SHUFFLE: ${originalCode} ---`);
        
        const matches = await fetchMatches(originalCode);
        if (!matches) return res.status(400).json({ error: "Invalid code or blocked." });
        if (matches.length < groupSize) return res.status(400).json({ error: "Not enough matches." });

        const generated = [];

        for (let i = 0; i < maxGroups; i++) {
            const shuffledPool = shuffleArray(matches);
            const initialGroup = shuffledPool.slice(0, groupSize);
            
            const result = await tryBookGroup(initialGroup, shuffledPool, false, new Set());
            if (result.success) generated.push(result);
        }

        if (generated.length === 0) return res.status(400).json({ error: "SportyBet rejected all groups." });
        res.json({ codes: generated });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server running on port ${PORT}`);
    await initMCP();
});