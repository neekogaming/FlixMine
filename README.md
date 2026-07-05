# FlixMine — Web

Static web client for FlixMine. Same catalog as the TV app, no build step, no backend, no API keys.

## Files

- `index.html` / `styles.css` / `app.js` — the entire app
- `channels.json` — bundled fallback for approved channels (used when the GitHub copy is missing, same as the TV app)
- `assets/` — FlixMine icon + neeko logo

## Data

Fetched at page load from:

- `https://raw.githubusercontent.com/neekogaming/FreeFlix/main/movies.json`
- `https://raw.githubusercontent.com/neekogaming/FreeFlix/main/approved_channels.json` (falls back to local `channels.json` on 404)

Posters/backdrops come from the TMDB image CDN. Playback is the official YouTube embed or a link out to youtube.com.

## Run locally

Any static file server works:

```
npx serve website
```

## Deploy

Upload the `website/` folder as-is to Netlify, Vercel, GitHub Pages, or any static host. No build step needed.
