/**
 * Structured JSON logging to stderr.
 * stdout is reserved for the MCP stdio protocol — never log there.
 * Logs NEVER contain passwords, OTPs, tokens, API keys, or payment data
 * because this server never accepts or stores such values.
 */
const MIN_LEVEL = process.env.SPORTYBET_LOG_LEVEL || "info";
const ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
export function log(level, fields = {}) {
    if (ORDER[level] < ORDER[MIN_LEVEL])
        return;
    const entry = { ts: new Date().toISOString(), level, ...fields };
    process.stderr.write(JSON.stringify(entry) + "\n");
}
export const logger = {
    debug: (f = {}) => log("debug", f),
    info: (f = {}) => log("info", f),
    warn: (f = {}) => log("warn", f),
    error: (f = {}) => log("error", f),
};
