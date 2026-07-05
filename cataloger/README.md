# FlixMine Cataloger — Web Edition

Browser-based tool for adding free YouTube movies to the FlixMine catalog.
No install needed — helpers just open the link, add two keys, and start cataloging.

## For helpers: getting started

1. **Open the Cataloger** (link from neeko, e.g. `https://neekogaming.github.io/FreeFlix/cataloger/`).
2. **TMDb key (required)** — free:
   - Sign up at [themoviedb.org](https://www.themoviedb.org/signup)
   - Go to [Settings → API](https://www.themoviedb.org/settings/api), request a key ("Developer", personal use)
   - Paste either the API Key or the Read Access Token into Settings → TMDb, hit **Test**
3. **GitHub token (required for direct writing)**:
   - Ask neeko to add you as a collaborator on the catalog repo
   - Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
     - Repository access: **Only select repositories** → the catalog repo
     - Permissions → **Contents: Read and write** (nothing else)
   - Paste into Settings → GitHub, hit **Test write access**
   - No GitHub access? Switch the publish target to **Download updated movies.json** and send the file to neeko instead.
4. **OMDb key (optional)** — free at [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx). Used automatically when TMDb can't find a title.
5. **Save settings.** Keys stay in your own browser (localStorage); nothing is uploaded anywhere except to the APIs themselves.

## Adding one movie

1. Paste a YouTube link — everything starts automatically:
   the video title is fetched, cleaned, and searched on TMDb; the best match is pre-selected with a HIGH / MEDIUM / LOW confidence label.
2. Check the poster and backdrop against the video thumbnail. Click a different candidate card if the auto-pick is wrong.
3. The channel is auto-matched against `approved_channels.json`; a warning appears if it isn't approved yet.
4. Click **Add to Catalog**. Duplicates (same video or same movie) are blocked automatically.

If nothing matches: edit the detected title and press Enter, or open *Manual lookup tools* (TMDb ID, IMDb ID, IMDb browser search, OMDb).

## Batch mode

1. Paste many links into the Batch tab and click **Build Queue & Auto-Match**.
2. The app looks up and matches every link by itself; items become **Ready** (match found), **Already in catalog**, **No match**, or **Error**.
3. Click **Review Next Ready** — each item loads pre-matched; you just confirm, pick another candidate, or skip.
4. The queue survives page reloads. Nothing is ever added without your confirmation.

## Safety

- Append-only: the app never rewrites or deletes existing catalog entries.
- Duplicate check runs against the live catalog immediately before every write.
- Simultaneous helpers are safe: writes use GitHub's SHA check; on a collision the app refetches, re-checks duplicates, re-assigns the ID, and retries.
- New entries follow the FreeFlix extended format (`movie_XXXX`, no `provider` field, `last_checked` = today).

## For neeko: deploying updates

The source of truth is `website/cataloger/` in the FreeFlix Android project.
To publish, copy the folder into the GitHub Pages tree of the catalog repo:

```
docs/cataloger/index.html
docs/cataloger/styles.css
docs/cataloger/app.js
```

Commit to `main` and it's live at `https://neekogaming.github.io/FreeFlix/cataloger/` for every helper instantly.
