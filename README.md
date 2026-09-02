# Padel court finder

Finds free padel courts on Playtomic **by the hours you can actually play**, across
every club in an area at once, instead of opening each club and scrolling its day grid.

## Run it

```bash
"/Users/Denis/Claude/Nux Game Project/Nux Game/padel-finder/padel"
```

It starts a local server on <http://localhost:8123> and opens your browser.
`Ctrl-C` stops it. No dependencies, no npm install, no account or login needed.

Options: `--port 9000`, `--no-open`.

The interface is mobile-first: a four-step search (When → Hours → Game → Clubs)
with a sticky action bar, and results grouped day → start time → clubs so a
thousand-slot result stays readable on a phone. On screens wider than 900px the four
steps become a single sidebar with results beside them.

## Using it

1. **Area** - `Limassol` is already indexed (26 padel clubs). Type any other place
   and press **Rescan clubs** to index it; the list is cached on disk afterwards.
2. **Hours** - set the window you can play, e.g. 18:00 to 22:00. *Whole session must
   fit in the window* means a 90-minute game must both start and finish inside it;
   uncheck it to match anything merely starting in the window.
3. **Game** - duration, indoor/outdoor, price cap.
4. **Clubs** - narrow to the ones you would actually drive to. Fewer clubs means a
   much faster search.
5. **Search**. Days come back nearest-first and appear as they arrive; the button
   turns into **Stop**. In the day view each start time is a chip showing how many
   clubs have it free - tap one to open the clubs, courts and prices behind it.
6. **Use my location** (step 4) asks the browser for your position and shows the
   drive time and distance to every club, on both the club picker and each result.
   A **Nearest** sort appears once it is on.
7. **Book** opens the Playtomic **app** on a phone and the **website** on a desktop;
   the small `app` / `web` link next to Directions gives you the other one. Booking
   itself still happens in Playtomic, in your own account.

Save any filter combination under **Saved searches** to re-run it in one click.

### Why the links open the app

`playtomic.com` does not serve its own `apple-app-site-association` file - it 301s to
`app.playtomic.com`, and iOS does not follow redirects for that file. So no
`playtomic.com/...` link can ever open the app. `app.playtomic.com` does serve the
association, and `/tenant/*` is one of its declared paths, so
`app.playtomic.com/tenant/<tenantId>` opens the native app when it is installed and
falls back to Playtomic's own download page when it is not. The underlying custom
scheme is `playtomic://tenant/<tenantId>`, but that fails silently with no app
installed, so the https form is used instead.

The web link keeps the `?date=` parameter, which the app link cannot carry - one more
reason both are offered.

### Courts, not open matches

Everything here is **court booking** - renting a court for a slot. Playtomic's *open
matches* (joining an existing game with a free player spot) are a separate feature:
`app.playtomic.com` declares `/matches/*` deep links for them, and the club pages we
read expose no match data at all, only `/api/clubs/availability`. Adding open matches
would mean a different data source.

### About the travel times

Your coordinates are rounded to about 110 m and sent to the public
[OSRM](https://project-osrm.org) demo router, which answers one origin against every
club in a single request and needs no API key. Durations are **free-flow driving
estimates with no live traffic**, so treat them as "roughly how far out this club is",
not an ETA. For a real ETA, the **Directions** link on each result opens Google Maps
with live traffic - that is a plain maps URL and needs no API key either. Google's
Routes / Distance Matrix *API* would give traffic-aware times inside the app, but it
requires a Google Cloud account with billing enabled, which is why it is not used. The position is held in `sessionStorage` only and is never written to
disk. If the router is unreachable the app shows straight-line distance and says so,
rather than inventing a duration from an assumed speed.

## Speed and rate limits

Playtomic exposes availability one club-day at a time, and its CDN rate-limits bursts
per IP. A cold 26-club × 7-day search is therefore ~180 lookups and takes 1-2 minutes;
results stream in from about five seconds. Responses are cached for 10 minutes, so
changing the hours or duration afterwards re-filters instantly with no new requests.

If the limiter does trip, the app backs off automatically and tells you exactly how
many club-days it could not check, so a throttled lookup is never silently shown as
"no courts free". Searching again fills the gaps, reusing whatever is still cached.

## Making it public (passphrase-protected)

Set one environment variable and the app switches into public mode: it requires a
passphrase, issues a signed session cookie valid for 30 days, and listens on all
interfaces. Without the variable it stays local-only on `127.0.0.1` and asks for
nothing - so an unprotected instance can never be exposed by accident.

```bash
PADEL_PASSPHRASE='something-long-and-random' node server.js
```

The passphrase is never written to disk or committed; only a SHA-256-derived key is
held in memory. Failed logins are throttled per client (free for three tries, then a
doubling delay up to five minutes). Changing the passphrase signs everyone out.

### Deploying to Render

1. Push this repo to GitHub (private is fine).
2. Render -> **New** -> **Blueprint** -> pick the repo. `render.yaml` configures it.
3. Set **PADEL_PASSPHRASE** in the dashboard when prompted. Do not skip this: with no
   passphrase the app refuses to listen publicly and the health check will fail.
4. Open the URL, enter the passphrase.

Two things to expect on a free cloud tier:

- **Cold starts.** The instance sleeps after ~15 minutes idle and takes ~50s to wake.
- **Ephemeral disk.** Saved searches would reset on each restart, so the browser keeps
  a mirror in `localStorage` and restores them automatically. The club catalog is
  committed to the repo, so it survives regardless.

**Rate limiting is the thing to watch.** Playtomic's CDN budgets requests per IP, and
datacenter IPs tend to be treated more strictly than home ones. If searches from the
cloud instance come back with a lot of unchecked club-days, run it from your own
machine behind a Cloudflare Tunnel instead - same code, same passphrase, your home IP.

## How it works

`playtomic.com` renders its club pages server-side and serves availability from its
own same-origin endpoint, both without authentication:

| What | Request |
|---|---|
| Clubs in an area | `GET /search?q=<place>` -> `/clubs/<slug>` links |
| Club details, courts, timezone | `GET /clubs/<slug>` -> tenant object in the RSC payload |
| Free slots | `GET /api/clubs/availability?tenant_id=&date=&sport_id=PADEL` |

Two things that are easy to get wrong and are handled in `lib/playtomic.js`:

- **Slot times are UTC.** They are converted to each club's own timezone before any
  filtering. Verified against club opening hours (03:00 UTC = 06:00 in Nicosia).
- **A local day can span two UTC dates.** Late-night slots come back stamped with the
  previous UTC date, so they are re-bucketed by local date.

`api.playtomic.io` is deliberately not used: it sits behind a WAF that rejects
non-browser TLS fingerprints.

## Files

```
padel              launcher
server.js          local HTTP server, search engine, SSE streaming
lib/playtomic.js   Playtomic client, request pacing, timezone handling
lib/store.js       club catalog + saved searches on disk
public/            UI
data/clubs.json    cached club catalog (rebuild with Rescan clubs)
data/presets.json  saved searches
```
