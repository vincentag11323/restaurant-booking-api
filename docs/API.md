# The booking API, in plain words

This guide explains every address ("endpoint") of the booking API: who may call it, what to send, what comes back, and the exact error messages. The formal version is [API_SPEC.md](../../requirements/API_SPEC.md). The database behind it is explained in [DATABASE.md](DATABASE.md).

## 1. Basics

| Topic | Rule |
|---|---|
| Format | JSON in, JSON out. |
| Times in answers | ISO-8601 in UTC, e.g. `2026-11-20T10:30:00.000Z`. |
| Dates you send | The restaurant's local date, `YYYY-MM-DD`. |
| Sittings | 11:00, 13:30, 17:00 and 19:30 restaurant time; each lasts 2.5 hours. Bookable up to 60 days ahead. |
| Errors | Always `{ "message": "..." }` with one of: `400` bad input, `401` not signed in, `403` signed in but not allowed, `404` not found, `429` too many requests. |
| Unknown address | `404 Route not found`. |
| Requests from other websites | Any request other than GET/HEAD/OPTIONS whose `Origin` header isn't the web app's address (`CORS_ORIGIN`) gets `403 Cross-origin request blocked`. This stops other sites from acting on a signed-in guest's behalf. |
| Rate limits today | Sign-up, sign-in and sign-out: 20 requests per 15 minutes per IP address (`429 Too many attempts. Please wait a few minutes and try again.`). Assistant guest lookup: 60 per minute (`429 Too many lookups. Please slow down.`). |

Validation messages for a field start with the field's name, e.g. `partySize: Party size must be between 1 and 50`. Rule messages (like "the slot is full") have no prefix.

## 2. How signing in works

* Signing up or signing in sets a cookie called `session`. The browser sends it back by itself; JavaScript can't read it (`HttpOnly`), it isn't sent from other sites' forms (`SameSite=Lax`), and in production only over HTTPS (`Secure`).
* The cookie holds a long random secret. The server keeps only its fingerprint, in the `Session` table.
* A session lasts **1 hour from sign-in** and is never extended. There is no refresh: after the hour, calls get `401` and the guest signs in again.
* **Signing out ends the session at once.** Its row is deleted, so the cookie, and any saved copy of it, is refused from the next request on.
* Signing out on one device doesn't touch the others. Each browser has its own session.
* Deleting a user deletes all their sessions, so they're signed out everywhere at once.
* `Authorization: Bearer ...` headers are ignored.

## 3. The assistant's key

The AI booking assistant has no password. It sends `X-Agent-Key: <AGENT_API_KEY>` on its own routes. The server keeps only the key's fingerprint, in the `ApiKey` table, and accepts it only if the key belongs to the assistant's account (role `AGENT`). To change the key, set a new `AGENT_API_KEY` and run `npm run db:seed`; the old key stops working at once.

## 4. Route groups: who may call what

Every address starts with one of five groups. Each group runs its own check before the route itself.

| Group | Who | Check that runs first |
|---|---|---|
| `/api/public/...` | Anyone, including the assistant | None. No cookie or key is read. |
| `/api/auth/...` | Anyone | Only the rate limit. |
| `/api/users/...` | Signed-in guests (and admins for their own profile) | **Sign-in check**: reads only the `session` cookie. No cookie → `401 Authentication required`. Unknown or ended session → `401 Invalid or expired token`. |
| `/api/admins/...` | Admins | The same sign-in check, then: not an admin → `403 Forbidden`. |
| `/api/agents/...` | The AI assistant | **Key check**: reads only `X-Agent-Key`. Missing or empty → `401 Authentication required`. Unknown key, or a key not owned by the assistant → `401 Invalid API key`. |

So a guest's cookie means nothing on `/api/agents/...`, and the assistant's key means nothing on `/api/users/...` or `/api/admins/...`: both get `401 Authentication required`.

The person's role is read from the database on every request, so a role change applies at once.

**Two layers of permission.** After the group check, each route checks the role's permissions:

| Role | May |
|---|---|
| `USER` (guest) | See and change their own profile and bookings; get menu recommendations. |
| `ADMIN` | See their own profile; read all bookings, stats and exports. Can't book or get recommendations (`403 Forbidden`). |
| `AGENT` (assistant) | Book for one guest; look up one guest by exact email. Nothing else. |

A guest asking for someone else's booking gets `404 Reservation not found`, so booking ids can't be guessed.

## 5. Every endpoint

### 5.1 Public (`/api/public`), no sign-in

| Method and path | What it does | Send | Get back | Errors |
|---|---|---|---|---|
| `GET /api/public/health` | Is the API up? | — | `200 { "status": "ok" }` | — |
| `GET /api/public/menus` | All dishes, or one menu | optional `?type=SEASONAL_FINE_DINING` or `A_LA_CARTE` | `200` list of dishes | `400` for an unknown type |
| `GET /api/public/availabilities` | Free tables or rooms per sitting on one day | `?branch=BRANCH_1&sector=MAIN_HALL&date=2026-11-20` (all three needed) | `200` list of sittings | `400` for a missing or wrong value, e.g. `date: Expected date as YYYY-MM-DD` |

A dish: `{ id, name, description, type, priceCents, allergens, chefPick }`.
A sitting: `{ startTime, slotStart, slotEnd, totalUnits, freeUnits, bookable }`. `freeUnits` counts free tables (Main Hall) or rooms (VIP). `bookable` is false for a sitting that has started or is more than 60 days ahead.

### 5.2 Sign-up, sign-in, sign-out (`/api/auth`)

| Method and path | What it does | Send | Get back | Errors |
|---|---|---|---|---|
| `POST /api/auth/register` | Make an account and sign in. Signing up with an email the assistant already used claims that account and keeps its bookings. | `{ email, password, name, phone? }` (password 8–72 characters) | `201 { "user": {...} }` and the `session` cookie | `400 Email is already registered`; `400` validation, e.g. `password: Password must be at least 8 characters`, `phone: Invalid phone number` |
| `POST /api/auth/login` | Sign in | `{ email, password }` | `200 { "user": {...} }` and the `session` cookie | `400` validation; `401 Invalid email or password` (same answer for an unknown email, a wrong password, or an account the assistant made that hasn't signed up) |
| `POST /api/auth/logout` | Sign out this browser | — (the cookie) | `200 { "message": "Logged out" }`, cookie cleared | — (works even with no cookie or an old one) |

A user: `{ id, email, name, phone, allergies, role }`. Passwords and hashes are never returned.
Signing in also deletes that person's sessions that had already run out. After 10 failed sign-ins from one IP in 5 minutes, a `SECURITY_ALERT` is written to the audit diary.

### 5.3 Signed-in guests (`/api/users`)

All need the `session` cookie. Without it: `401 Authentication required`; with an ended one: `401 Invalid or expired token`.

| Method and path | Who | What it does | Send | Get back | Errors |
|---|---|---|---|---|---|
| `GET /api/users/me` | guest or admin | My profile | — | `200` user | — |
| `PATCH /api/users/me` | guest or admin | Change my name, phone or allergies | any of `{ name, phone (or null to clear), allergies: ["gluten", ...] }` | `200` user | `400` validation |
| `GET /api/users/reservations` | guest | My bookings, latest sitting first | — | `200` list of bookings | `403 Forbidden` for an admin |
| `GET /api/users/reservations/:id` | guest | One of my bookings | — | `200` booking | `404 Reservation not found` |
| `POST /api/users/reservations` | guest | Book | `{ branch, sector, date, startTime, partySize, specialRequests? }` | `201` booking | `400` (list below); `403 Forbidden` for an admin |
| `PATCH /api/users/reservations/:id` | guest | Change the time (and party size) | `{ date, startTime, partySize? }` | `200` booking | `400` (list below); `404 Reservation not found` |
| `DELETE /api/users/reservations/:id` | guest | Cancel (the booking is kept, marked `CANCELLED`; the tables are freed) | — | `200` booking | `400` (list below); `404 Reservation not found` |
| `GET /api/users/menus/recommendations` | guest | Dishes without my allergens, chef's picks first | — | `200` list of dishes | `403 Forbidden` for an admin |

A booking: `{ id, code, branch, sector, slotStart, slotEnd, partySize, specialRequests, status, source, tableIds, createdAt, updatedAt, cancelledAt }`.

Booking `400` messages (exact):

| Message | When |
|---|---|
| `startTime: startTime must be one of 11:00, 13:30, 17:00, 19:30` | Not one of the four sittings |
| `partySize: Party size must be between 1 and 50` | Fewer than 1 or more than 50 people |
| `Selected slot is in the past or too far ahead` | Started already, or more than 60 days ahead |
| `Insufficient capacity for the selected slot` | Not enough free tables or rooms |
| `Table overlap conflict, please try again` | Someone took the same table at the same moment |
| `Only confirmed reservations can be changed` | Changing or cancelling a booking that isn't `CONFIRMED` |
| `Reservation slot has already started` | Changing or cancelling after the sitting started |

Main Hall joins one two-seat table per two guests. VIP bookings take one to four 13-seat rooms.

### 5.4 Admins (`/api/admins`), read-only

All need an admin's `session` cookie. No cookie: `401 Authentication required`; ended session: `401 Invalid or expired token`; a guest: `403 Forbidden`. There is no admin address that creates, changes or deletes bookings.

| Method and path | What it does | Send | Get back | Errors |
|---|---|---|---|---|
| `GET /api/admins/stats` | Numbers for one day | `?date=YYYY-MM-DD` (default today) `&branch=` (optional) | `200 { date, totalBookings, agentBookings, totalCovers, cancellations, utilization[] }` | `400` validation |
| `GET /api/admins/reservations` | Search the booking log | filters (below) + `?page=1&pageSize=20` (at most 100) | `200 { items, total, page, pageSize }`; each item is a booking plus `customer: { name, email, phone }` | `400` validation |
| `GET /api/admins/reservations/export` | Download the log | filters + `?format=csv` (default) or `json` | `200` file download, at most 10,000 rows | `400` validation |
| `GET /api/admins/reservations/:id` | One booking with the customer | — | `200` booking with `customer` | `404 Reservation not found` |

Filters: `branch`, `sector`, `status`, `source` (`APP` or `AGENT`), `from` and `to` (local dates, both included), `q` (a booking code exactly, or part of a name, email or phone).
Side effects: viewing one booking writes `VIEW_RESERVATION_DETAIL` to the audit diary; an export writes `EXPORT_RESERVATIONS`, and a `SECURITY_ALERT` too when it has more than 1,000 rows. In the CSV, cells that start with `=`, `+`, `-` or `@` get a `'` in front so spreadsheets don't run them.

### 5.5 The AI assistant (`/api/agents`)

All need `X-Agent-Key`. Missing or empty: `401 Authentication required`; wrong: `401 Invalid API key`.

| Method and path | What it does | Send | Get back | Errors |
|---|---|---|---|---|
| `POST /api/agents/reservations` | Book for a guest by email. Makes a guest account with no password if the email is new. | `{ email, phone?, branch, sector, date, startTime, partySize, specialRequests?, clientIp? }`; optional header `Idempotency-Key` (8–200 characters) | `201` booking with `source: "AGENT"`; the same `Idempotency-Key` again → `200` with the same booking | the booking `400`s above, plus the ones below |
| `POST /api/agents/guests/lookup` | Does this one email have an account, and how many upcoming assistant bookings? | `{ email }` | `200 { exists, upcomingAssistantBookings, assistantBookingLimit }` | `400` for anything but one email; `429 Too many lookups. Please slow down.` |

Extra `400` messages for assistant bookings (exact):

| Message | When |
|---|---|
| `This email already has a booking made with the assistant. To book a different time, sign up with this email in the app, cancel that booking there, then ask me again.` | The email hasn't signed up and already has 1 upcoming assistant booking |
| `This email already has 3 upcoming assistant bookings. Sign in to manage them.` | A signed-up guest already has 3 |
| `This email can't be booked through the assistant` | The email belongs to an admin or the assistant |
| `Idempotency-Key was already used for another booking` | The retry key was used for a different email |

Admins and the assistant's own account show as `exists: false` in a lookup. Every lookup writes `VIEW_GUEST` to the audit diary; every booking writes `CREATE_RESERVATION` (with who it was for).

## 6. Try it in the browser (Swagger)

| Address | What it is |
|---|---|
| `GET /api/public/docs` | The Swagger page: every endpoint with its rules, examples and exact error messages, and a "Try it out" button. `/api/public/docs` sends you on to `/api/public/docs/`. |
| `GET /api/public/docs/openapi.json` | The same information as an OpenAPI 3.1 file, for tools. |

* The document is built from the same rules that check every request, so it can't fall out of date. A test fails if a route is added without being documented.
* It is on in development and tests. In production it is **off** unless `API_DOCS=true`, so the list of routes isn't advertised.
* "Try it out" for changes (POST, PATCH, DELETE) only works when the page is opened through the web app's address (`CORS_ORIGIN`), e.g. `http://localhost:5173/api/public/docs`, because changes from any other site are refused (`403 Cross-origin request blocked`). Reads work from anywhere.
* For routes that need sign-in, first call `POST /api/auth/login` on the same page; the browser then keeps the `session` cookie for the other calls.

## 7. Logs

Two files, one line each, both also printed to the console. Every line starts with the request's method in brackets, then JSON:

```
[POST] {"time":"…","status":201,"method":"POST","path":"/api/users/reservations","action":"RESERVATION_CREATED","resourceId":"RSV-7K3Q9X","userId":"cm3…","ip":"…"}
```

| File | Setting | What goes in |
|---|---|---|
| `logs/app.log` | `APP_LOG_PATH` | Every request that **changed the database** and succeeded (printed with `console.log`). |
| `logs/errors.log` | `ERROR_LOG_PATH` | Every **failed** request: any 4xx or 5xx, including unknown addresses and rate limits (printed with `console.error`). 5xx lines also carry the error name and stack. |

What lands in `app.log`:

| Request | `action` | `resourceId` |
|---|---|---|
| `POST /api/auth/register` | `USER_CREATED` (or `USER_CLAIMED` when it claims an account the assistant made), then `SESSION_CREATED` | user id, then session id |
| `POST /api/auth/login` | `SESSIONS_EXPIRED_DELETED` with a `count` (only when old sessions were removed), then `SESSION_CREATED` | session id |
| `POST /api/auth/logout` (the cookie matched a session, live or ended) | `SESSION_DELETED` | session id |
| `PATCH /api/users/me` | `PROFILE_UPDATED` | user id |
| `POST /api/users/reservations` | `RESERVATION_CREATED` | booking code |
| `PATCH /api/users/reservations/:id` | `RESERVATION_RESCHEDULED` | booking code |
| `DELETE /api/users/reservations/:id` | `RESERVATION_CANCELLED` | booking code |
| `POST /api/agents/reservations` | `GUEST_ACCOUNT_CREATED` (only for a new email), then `RESERVATION_CREATED` | user id, then booking code |

`userId` is the signed-in caller, or on sign-up and sign-in the account just signed in. Reads, and requests that change nothing (signing out without a session, an assistant retry with the same key), write no line.

**Never logged:** request bodies, passwords, session tokens or cookies, API keys, query strings, names, emails, phone numbers, allergies, guest messages.

**Size limit:** before writing, a file over 5 MB (`APP_LOG_MAX_BYTES`, `ERROR_LOG_MAX_BYTES`) is renamed to `.1` (e.g. `app.log.1`) and the previous `.1` is deleted. So each log has one live file and at most one old copy. Set `APP_LOG_CONSOLE=false` or `ERROR_LOG_CONSOLE=false` to stop printing to the console.

## 8. Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | Where the database is. The app won't start without it. |
| `PORT` | `4000` | The API's port. |
| `CORS_ORIGIN` | `http://localhost:5173` | The web app's address; the only `Origin` allowed to send changes. |
| `SESSION_TTL` | `1h` | How long a session lasts, e.g. `30m` or `8s`. |
| `RESTAURANT_UTC_OFFSET` | `+07:00` | The restaurant's time zone. |
| `AUTH_RATE_LIMIT` | `20` | Sign-up/sign-in/sign-out requests per 15 minutes per IP. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | Used by the seed script to make the admin. |
| `AGENT_API_KEY` | — | The assistant's key (at least 32 characters); the seed script stores only its fingerprint. |
| `APP_LOG_PATH`, `APP_LOG_MAX_BYTES`, `APP_LOG_CONSOLE` | `logs/app.log`, 5 MB, on | The success log. |
| `ERROR_LOG_PATH`, `ERROR_LOG_MAX_BYTES`, `ERROR_LOG_CONSOLE` | `logs/errors.log`, 5 MB, on | The error log. |
| `NODE_ENV` | — | `production` turns on `Secure` cookies, trusts the hosting proxy's client IP, and hides the Swagger page. |
| `API_DOCS` | off in production | `true` shows the Swagger page and `openapi.json` in production too. |
