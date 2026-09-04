// Custom Worker entry (instead of plain static-assets-only) purely so a scheduled/cron handler
// can exist alongside serving the built SPA — see wrangler.jsonc's `triggers.crons`. The fetch
// handler just hands every request straight to the static asset binding, unchanged behavior from
// the assets-only setup this replaces.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },

  // Keeps the Render backend (free tier, sleeps after ~15 min idle — see project_hosting_plan
  // memory) warm so a real player never eats a 30-60s cold-start mid-game. `waitUntil` lets the
  // ping finish after the handler returns; failures are swallowed since there's nothing useful to
  // do about a missed keep-alive beat other than let the next one (10 min later) try again.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      fetch(`${env.API_BASE_URL}/api/health`).catch(() => {})
    );
  },
};
