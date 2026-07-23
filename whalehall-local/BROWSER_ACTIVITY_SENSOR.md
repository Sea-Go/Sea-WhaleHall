# Browser Activity Sensor

## Purpose and ownership

The browser activity sensor is implemented in `core/src/sensors/browser_activity.rs`. It is a resident Rust service that records current-tab sessions and imports browser history, search records, and downloads into `browser.sqlite3`.

Browser data is isolated from foreground application usage, process inventory, and presence data because URLs, search terms, titles, and download paths have the highest local privacy sensitivity in the client. Every Agent Tool requires `browser.read`.

## Current-tab collection

A current tab contains:

- browser and profile names;
- window/tab identity supplied by the bridge;
- title, full URL, and parsed domain;
- nullable audio-playing state;
- observed start, latest observation, and end timestamps.

The sensor defines a tab session by `(browser, profile, windowId, tabId, URL)`. A navigation closes the previous session and opens the next at the same observed timestamp. A tab absent from a successful snapshot is closed at that snapshot time. An unavailable provider never closes an existing session or invents an empty desktop.

All platforms support an atomic JSON bridge file at the path reported by `browser.status`, normally `browser-current-tabs.json` beside the sensor database:

```json
{
  "observedAtMs": 1700000000000,
  "tabs": [
    {
      "browser": "Google Chrome",
      "profile": "Default",
      "windowId": "12",
      "tabId": "45",
      "title": "Example",
      "url": "https://example.com/page",
      "audible": true
    }
  ]
}
```

The browser-side integration must replace the file atomically and refresh `observedAtMs`. Snapshots older than `WHALEHALL_BROWSER_BRIDGE_MAX_AGE_MS` are rejected instead of being presented as current. The default maximum age is 15 seconds.

On macOS, when no bridge file is available, the sensor can query the front Safari or Chromium-family browser through Apple Events. This fallback obtains title and URL but reports `audible: null`; exact audio state requires the bridge. Windows and Linux require the bridge for current URL/title/audio because ordinary process/window APIs cannot reliably expose tab URLs or browser audio state.

## History, search, and download import

The sensor discovers:

- Google Chrome, Chromium, Brave, Microsoft Edge, and Arc Chromium profiles;
- Firefox profiles;
- Safari history on macOS.

It never opens a writable handle to an original browser database. The main SQLite file and present `-wal`/`-shm` companions are copied into a private, generated snapshot directory. The copy is opened read-only and removed after the import connection closes.

Chromium imports `urls`, `downloads`, and `downloads_url_chains`. Firefox imports `moz_places` plus `downloads.json` when present. Safari imports `history_items` and `history_visits`; Safari download import is not currently available. macOS can deny Safari history access unless the packaged client has the required privacy permission, which appears as an explicit warning without stopping other browser imports.

Search records are derived from recognized search query parameters such as `q`, `query`, `text`, `wd`, and `search_query`. Percent encoding and `+` spaces are decoded. This works across common and custom search engines but can miss searches stored outside the URL and can classify an unrelated URL using a search-like parameter.

At most 100,000 history and download rows per profile are imported on each refresh. Existing local rows are upserted by stable source identity; repeated refreshes do not increase visit counts. If a user deletes source browser history, the already imported local row remains as a local sensor record.

## Resident lifecycle and configuration

`BrowserActivityService::start` opens and migrates SQLite, bounds tab sessions left open by an unclean shutdown, and starts two Tokio intervals:

- `WHALEHALL_BROWSER_TAB_POLL_MS`: current-tab polling, default 1 second, range 50 milliseconds through 60 seconds;
- `WHALEHALL_BROWSER_HISTORY_REFRESH_MS`: profile import, default 5 minutes, range 1 second through 24 hours;
- `WHALEHALL_BROWSER_BRIDGE_MAX_AGE_MS`: bridge freshness, default 15 seconds, range 1 second through 5 minutes.

`WHALEHALL_BROWSER_PROFILE_ROOT` restricts discovery to a supplied Chromium-style root. It exists for isolated tests, managed deployments, and embedders that know the exact profile root. When set, ordinary user browser directories are not scanned.

## SQLite schema

The database uses WAL mode, normal synchronization, a five-second busy timeout, and schema version `1`.

- `browser_tab_sessions`: browser/profile identity, title, URL, domain, nullable audible flag, start, last-seen, and end times.
- `browser_history`: browser/profile, URL, domain, title, latest visit time, source visit count, and import timestamps.
- `browser_searches`: search term, source URL/domain/title, and search time.
- `browser_downloads`: source URL/domain, local target path, start/end times, received/total bytes, state, and import time.

All timestamps are Unix epoch milliseconds in SQLite and `*AtMs` JSON fields. Tool records also expose RFC 3339 UTC strings.

## Rust and Agent APIs

Rust integrations can provide `SystemBrowserActivityProvider` or a custom `BrowserActivityProvider`. The custom provider makes tab transitions and record import deterministic in unit tests.

Read-only Agent Tools:

- `browser.status`: service state, capability flags, counts, paths, warnings, and current tabs;
- `browser.tabs`: current or completed tab sessions;
- `browser.history`: URLs, titles, visit times, and visit counts;
- `browser.searches`: derived search terms and times;
- `browser.downloads`: source URLs, local paths, times, byte counts, and state.

Example calls:

```json
{"id":"browser-1","method":"tool.call","params":{"name":"browser.status","arguments":{}}}
{"id":"browser-2","method":"tool.call","params":{"name":"browser.tabs","arguments":{"currentOnly":true,"limit":20}}}
{"id":"browser-3","method":"tool.call","params":{"name":"browser.history","arguments":{"domainContains":"example.com","limit":100}}}
{"id":"browser-4","method":"tool.call","params":{"name":"browser.searches","arguments":{"termContains":"rust","limit":100}}}
{"id":"browser-5","method":"tool.call","params":{"name":"browser.downloads","arguments":{"state":"complete","limit":100}}}
```

## CI/CD contract

`tests/native-integration.test.ts` automatically discovers `browser_activity.rs` and requires exactly one native probe. The probe creates an isolated Chromium-format History database, download chain, search URL, and fresh tab bridge inside the temporary data directory. It then starts the real packaged JSONL server and verifies:

- all three capability flags and resident scan timestamps;
- current title, URL, domain, audible state, and open session boundary;
- imported history title/URL/time/visit count;
- decoded search term;
- download URL/path/time/bytes/state;
- creation of `browser.sqlite3`;
- registration and successful execution of every browser Tool.

The same probe runs in hosted macOS, Windows, Ubuntu, every Linux distribution container, and virtual X11. The fixture intentionally avoids reading a CI account's personal browser data. Real profile permissions and a production browser-side bridge remain deployment checks rather than safe hosted-runner fixtures.

## Privacy and limitations

Browser URLs, titles, search terms, download paths, and timestamps can reveal authentication tokens, private documents, health data, finances, and personal interests. The implementation keeps data local and does not expose a network server, but callers must treat `browser.read` as a high-impact permission.

The sensor does not read page contents, cookies, passwords, form fields, typed keystrokes, or response bodies. Private/incognito profiles are not intentionally imported, but browser-specific profile layout and extensions can vary. Protected or incompatible profiles produce warnings and do not stop other supported profiles.
