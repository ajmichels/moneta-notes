// Prompts are explicitly out of scope for S007 — see docs/specs/S007-mcp-server.md "Prompts". The
// README names 5 candidates (weekly review automation, note triage, stale note detection, weekly
// note scaffolding, orphan note identification) as identified but undesigned; each needs its own
// design pass, deferred to a dedicated follow-up spec once the tool set above is built and in use.
// This function is a stub — zero prompts registered — so server.js has one uniform bootstrap call
// site that doesn't need to change shape once prompts eventually land.
export function registerPrompts() {
    // Intentionally empty.
}
