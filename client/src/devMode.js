// Single on/off switch for every dev-only affordance (the Dev button, auto-login as the fixed
// "Calvin" / "The Eggheads" identity, the POI popup's Set GPS button). Toggled by editing
// VITE_GOOGLE_MAPS_API_KEY's neighbor in client/.env.local and restarting the dev server — not a
// runtime UI toggle, since the whole point is a build the user hands off with dev tooling either
// fully present or fully absent.
export const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true'
