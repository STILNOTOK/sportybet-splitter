const express = require('express');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require('path');

const app = express();
app.use(express.json());

let mcpClient;

// 1. Setup the MCP Client
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

function split(arr, size) {
  const shuffled = shuffle(arr);
  const groups = [];
  for (let i = 0; i < shuffled.length; i += size) {
    groups.push(shuffled.slice(i, i + size));
  }
  return groups;
}

// 2. The Frontend
app.get('/', (req, res) => {
    res.send(`
        <body style="background: #121212; color: white; padding: 20px; font-family: sans-serif; text-align: center;">
            <h1 style="color: #00e676;">SportyBet Splitter (MCP Server)</h1>
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

// 3. The Engine (Your exact working MCP logic)
app.get('/split', async (req, res) => {
    try {
        const code = req.query.code;
        const size = parseInt(req.query.size);
        const max = parseInt(req.query.max);
        
        console.log(`\n--- PROCESSING: ${code} ---`);

        const readRes = await mcpClient.callTool({
            name: "sportybet_get_booking_status",
            arguments: { bookingCode: code }
        });

        let parsedData = parseMCPResponse(readRes);
        
        let allSelections = [];
        if (parsedData && parsedData.legs) allSelections = parsedData.legs;
        else if (parsedData && parsedData.data && parsedData.data.legs) allSelections = parsedData.data.legs;

        if (allSelections.length === 0) {
            return res.json({ error: "Could not read matches." });
        }

        if (allSelections.length < size) {
            return res.json({ error: `Not enough matches (${allSelections.length} < ${size})` });
        }

        let groups = split(allSelections, size);
        groups = groups.slice(0, max);
        
        const newCodes = [];

        for (let i = 0; i < groups.length; i++) {
            let currentGroup = groups[i];
            console.log(`\nBooking Group ${i + 1} (${currentGroup.length} matches)...`);

            let success = false;
            let attempts = 0;

            while (!success && currentGroup.length > 0 && attempts < 5) {
                attempts++;
                
                const formattedSelections = currentGroup.map(g => {
                    const sel = {
                        eventId: g.eventId,
                        marketId: String(g.marketId || "1"),
                        outcomeId: String(g.outcomeId || "1")
                    };
                    if (g.specifier && g.specifier.trim() !== '') {
                        sel.specifier = g.specifier;
                    }
                    return sel;
                });

                try {
                    const bookRes = await mcpClient.callTool({
                        name: "sportybet_book_bet",
                        arguments: { selections: formattedSelections }
                    });

                    const bookData = parseMCPResponse(bookRes);
                    const generatedCode = bookData.shareCode || bookData.bookingCode || (bookData.data && (bookData.data.shareCode || bookData.data.bookingCode));

                    if (bookData && bookData.success === true && generatedCode) {
                        console.log(`✅ Success! New Code: ${generatedCode}`);
                        newCodes.push({
                            code: generatedCode,
                            odds: bookData.combinedOdds || 'N/A'
                        });
                        success = true;
                    } else if (bookData && bookData.error && bookData.error.code === "VALIDATION_FAILED") {
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
                await new Promise(r => setTimeout(r, 1000));
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        if (newCodes.length === 0) {
            return res.json({ error: "SportyBet rejected all groups." });
        }

        res.json({ total: allSelections.length, codes: newCodes });

    } catch (e) {
        console.error("SERVER ERROR:", e.message);
        res.json({ error: e.message });
    }
});

// 4. Start server (Render compatible)
const PORT = process.env.PORT || 9000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server running on port ${PORT}`);
    await initMCP();
});