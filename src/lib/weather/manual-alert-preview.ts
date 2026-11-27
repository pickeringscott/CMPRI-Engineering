const PREVIEW_BRANCH = "codex/weather-alert-radar-review";

export function isHostedWeatherPreview() {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_URL || process.env.VERCEL_GIT_COMMIT_REF);
}

export function isManualWeatherPreview() {
  return process.env.VERCEL_ENV === "preview"
    && (!isHostedWeatherPreview() || process.env.VERCEL_GIT_COMMIT_REF === PREVIEW_BRANCH);
}
