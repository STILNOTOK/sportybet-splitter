export function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
}
export function toIso(ms) {
    if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) <= 0)
        return null;
    return new Date(Number(ms)).toISOString();
}
export function normalizeOutcome(raw) {
    return {
        outcomeId: String(raw.id ?? ""),
        outcomeName: String(raw.desc ?? ""),
        odds: toNumber(raw.odds),
        rawOdds: String(raw.odds ?? ""),
        isActive: (raw.isActive ?? 1) === 1,
        probability: toNumber(raw.probability) || undefined,
    };
}
export function normalizeMarket(raw, eventId) {
    return {
        eventId,
        marketId: String(raw.id ?? ""),
        marketName: raw.desc || raw.name || raw.title || String(raw.id ?? ""),
        specifier: raw.specifier ?? null,
        status: raw.status ?? 0,
        group: raw.group,
        lastOddsChangeTime: raw.lastOddsChangeTime,
        outcomes: (raw.outcomes ?? []).map(normalizeOutcome),
    };
}
export function normalizeFixture(raw, tournament) {
    const startTimeMs = toNumber(raw.estimateStartTime);
    return {
        eventId: String(raw.eventId ?? ""),
        gameId: raw.gameId ? String(raw.gameId) : undefined,
        league: tournament?.name ?? "",
        leagueId: tournament?.id ? String(tournament.id) : "",
        category: tournament?.categoryName ?? "",
        categoryId: tournament?.categoryId ? String(tournament.categoryId) : "",
        homeTeam: String(raw.homeTeamName ?? ""),
        awayTeam: String(raw.awayTeamName ?? ""),
        startTime: toIso(startTimeMs) ?? "",
        startTimeMs,
        matchStatus: String(raw.matchStatus ?? "Not start"),
        sport: raw.sport?.name ?? "Football",
        markets: (raw.markets ?? []).map((m) => normalizeMarket(m, String(raw.eventId ?? ""))),
    };
}
export function flattenFixtures(tournaments) {
    const out = [];
    for (const t of tournaments ?? []) {
        for (const e of t.events ?? []) {
            out.push(normalizeFixture(e, t));
        }
    }
    return out;
}
export function fixtureToOdds(fixture) {
    const timestamp = new Date().toISOString();
    const out = [];
    for (const market of fixture.markets) {
        for (const outcome of market.outcomes) {
            out.push({
                eventId: fixture.eventId,
                marketId: market.marketId,
                outcomeId: outcome.outcomeId,
                event: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
                market: market.marketName,
                specifier: market.specifier,
                outcome: outcome.outcomeName,
                odds: outcome.odds,
                timestamp,
            });
        }
    }
    return out;
}
export function normalizeBookingLeg(raw) {
    const firstMarket = (raw.markets ?? [])[0];
    const firstOutcome = firstMarket?.outcomes?.[0];
    return {
        eventId: String(raw.eventId ?? ""),
        homeTeam: String(raw.homeTeamName ?? ""),
        awayTeam: String(raw.awayTeamName ?? ""),
        startTime: toIso(toNumber(raw.estimateStartTime)),
        startTimeMs: toNumber(raw.estimateStartTime) || null,
        matchStatus: String(raw.matchStatus ?? ""),
        market: firstMarket
            ? normalizeMarket(firstMarket, String(raw.eventId ?? ""))
            : {
                eventId: String(raw.eventId ?? ""),
                marketId: "",
                marketName: "",
                specifier: null,
                status: 0,
                outcomes: [],
            },
        outcome: firstOutcome
            ? normalizeOutcome(firstOutcome)
            : { outcomeId: "", outcomeName: "", odds: NaN, rawOdds: "", isActive: false },
    };
}
export function normalizeBooking(raw) {
    const deadlineMs = toNumber(raw.deadline);
    return {
        shareCode: String(raw.shareCode ?? ""),
        shareURL: String(raw.shareURL ?? ""),
        deadlineMs: Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : null,
        expiresAt: toIso(deadlineMs),
        betType: raw.betType,
        legs: (raw.outcomes ?? []).map(normalizeBookingLeg),
        unavailableOutcomes: raw.unavailableOutcomes ?? [],
    };
}
