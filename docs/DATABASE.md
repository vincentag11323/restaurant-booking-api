# The database, in plain words

This guide explains what the booking API stores and why. The formal version is [DATA_MODEL.md](../../requirements/DATA_MODEL.md); the code version is `prisma/schema.prisma`.

The database is PostgreSQL. All times are stored in UTC ("timestamptz"). The app talks to it only through Prisma, never with hand-written SQL (hand-written SQL lives only in the migration files).

## 1. The big picture

```
User 1 ──── * Reservation 1 ──── * ReservationTable * ──── 1 DiningTable
                                        (which tables a booking holds)
User 1 ──── * Session     (one per signed-in browser)
User 1 ──── 0..1 ApiKey   (only the AI assistant's account has one)

MenuItem   (the dishes; stands alone)
AuditLog   (a diary of important actions; can only grow)
```

Read `1 ──── *` as "one ... has many ...". For example, one user has many reservations.

| Table | In one sentence |
|---|---|
| `User` | Everyone who can be named in the system: guests, admins and the AI assistant's account. |
| `Session` | One row per signed-in browser. Deleting the row signs that browser out. |
| `ApiKey` | The secret key the AI assistant uses instead of a password. |
| `DiningTable` | The restaurant's tables and private rooms. Fixed; the app never edits them. |
| `Reservation` | A booking: who, where, when, how many people, and its status. |
| `ReservationTable` | Which tables a live booking is holding. This is what stops double-booking. |
| `MenuItem` | The dishes on the menu, with allergy tags. |
| `AuditLog` | A permanent diary: sign-ins, bookings, admin exports, security alerts. |

## 2. Fixed lists of values (enums)

| List | Values | Meaning |
|---|---|---|
| `Role` | `USER`, `ADMIN`, `AGENT` | A guest, a restaurant admin (read-only), or the AI booking assistant's account. |
| `BookingSource` | `APP`, `AGENT` | Booked by the guest in the app, or by the AI assistant for the guest. |
| `Branch` | `BRANCH_1`, `BRANCH_2` | The two restaurant branches. |
| `Sector` | `MAIN_HALL`, `VIP_WING` | Main Hall (two-seat tables) or the VIP Wing (private rooms). |
| `ReservationStatus` | `CONFIRMED`, `SEATED`, `COMPLETED`, `CANCELLED`, `NO_SHOW` | Where a booking stands. The app itself only sets `CONFIRMED` and `CANCELLED`. |
| `MenuType` | `SEASONAL_FINE_DINING`, `A_LA_CARTE` | The two menus. |

## 3. The tables

### `User`
Everyone with an account.

| Column | What it holds |
|---|---|
| `id` | A unique id made by the app (a "cuid", like `cm3x…`). |
| `email` | The email address, always stored in lowercase. No two users share one. |
| `passwordHash` | The password, scrambled with bcrypt so it can't be read back. **Empty** for a guest account the AI assistant created (the guest hasn't signed up yet) and for the assistant's own account. |
| `name` | The name shown in the app (1 to 100 characters). |
| `phone` | Phone number. Optional. |
| `allergies` | A list of lowercase tags such as `gluten` or `shellfish` (at most 20). Used only to pick safe dishes. |
| `role` | `USER`, `ADMIN` or `AGENT`. Only the seed script creates admins and the assistant. |
| `createdAt` | When the account was made. |

Rules:
* When a guest signs up with an email the assistant already used, the app fills in the password on that existing account ("claims" it) and the guest keeps their bookings.
* Deleting a user also deletes their sessions and their API key (see "cascade" below). A user who still has reservations can't be deleted.

### `Session`
One row for each browser that is signed in.

| Column | What it holds |
|---|---|
| `id` | A unique id for the session. |
| `tokenHash` | A fingerprint (SHA-256) of the random secret in the browser's `session` cookie. The secret itself is never stored, so a copy of the database can't be used to sign in. No two rows share a fingerprint. |
| `userId` | Whose session it is. |
| `createdAt` | When the person signed in. |
| `expiresAt` | Sign-in time plus 1 hour (`SESSION_TTL`). It is never extended. |

Rules:
* **Signing in** adds a row and, at the same time, deletes that person's rows that have already run out.
* **Every request** that needs sign-in looks the row up. It counts only if it exists and `expiresAt` is still in the future.
* **Signing out** deletes the row. From the next request on, that cookie (and any copy of it) is refused.
* There is no clean-up job: a row that ran out simply stops counting, and the person's next sign-in deletes it.

### `ApiKey`
Secret keys for callers that aren't a person in a browser. Today there is exactly one: the AI booking assistant's.

| Column | What it holds |
|---|---|
| `id` | A unique id. |
| `name` | Who the key is for, e.g. `AI booking assistant`. |
| `keyHash` | A fingerprint (SHA-256) of the key. The key itself is never stored. No two rows share one. |
| `userId` | The account the key belongs to. For now one key per account at most. |
| `createdAt` | When the key row was made. |

Rules:
* The API accepts a key only if its owner's role is `AGENT`.
* Running the seed script again with a new `AGENT_API_KEY` replaces the fingerprint in the same row, so the old key stops working at once.
* Keys for other callers (vendors, special users) may come later; the owner hasn't decided yet.

### `DiningTable`
The restaurant's seats. Created by the seed script and never changed by the app.

| Column | What it holds |
|---|---|
| `id` | A readable code: `B1-MH-01` … `B1-MH-50` (Branch 1, Main Hall), `B1-VIP-1` … `B1-VIP-4` (Branch 1, VIP rooms), and the same with `B2-`. |
| `branch` | Which branch. |
| `sector` | Main Hall or VIP Wing. |
| `seats` | 2 for a Main Hall table, 13 for a VIP room. |

There are 108 rows: 2 branches × (50 tables + 4 rooms).

### `Reservation`
A booking. Cancelled bookings are kept (marked `CANCELLED`), never deleted.

| Column | What it holds |
|---|---|
| `id` | The internal id. |
| `code` | The short code guests and staff use, like `RSV-7K3Q9X`. It never uses 0, O, 1 or I, so it can be read aloud. Unique. |
| `userId` | The guest the booking is for. |
| `branch`, `sector` | Where. |
| `slotStart`, `slotEnd` | When. Sittings start at 11:00, 13:30, 17:00 or 19:30 restaurant time and last 2.5 hours. |
| `partySize` | How many people (1 to 50). |
| `specialRequests` | A note from the guest (up to 500 characters). Optional. |
| `status` | `CONFIRMED` when made; `CANCELLED` when the guest cancels. |
| `source` | `APP` (the guest booked) or `AGENT` (the AI assistant booked for them). |
| `createdById` | Who pressed "book": the guest, or the assistant's account. |
| `idempotencyKey` | Lets the assistant safely retry the same booking: the same key returns the same booking instead of making a second one. Unique. |
| `tableIds` | A copy of the table codes the booking was given. Kept after cancelling so admins can still see them. |
| `createdAt`, `updatedAt` | When it was made and last changed. |
| `cancelledAt` | When it was cancelled. Empty otherwise. |

### `ReservationTable`
The tables a live booking is holding right now.

| Column | What it holds |
|---|---|
| `reservationId` | The booking. |
| `tableId` | The table or room. |
| `slotStart` | The sitting, copied from the booking. |

Rules:
* **Double-booking guard:** the database refuses a second row with the same table and the same sitting. If two people try to grab the last table at the same moment, one of them gets `Table overlap conflict, please try again`.
* Cancelling deletes these rows (the tables are free again) but keeps the booking.
* Changing the time deletes the old rows and adds new ones in one step. If the new time is full, nothing changes and the original booking stays.

### `MenuItem`
The dishes. Created by the seed script.

| Column | What it holds |
|---|---|
| `id` | A unique id. |
| `name` | The dish name. Unique. |
| `description` | A short description. |
| `type` | Seasonal fine dining or à la carte. |
| `priceCents` | The price as a whole number of cents, so there are no rounding errors. |
| `allergens` | Lowercase allergy tags, matching the ones guests pick. |
| `chefPick` | `true` for the chef's recommendations, which are listed first. |

### `AuditLog`
A permanent diary of important actions. It can only grow.

| Column | What it holds |
|---|---|
| `id` | A running number. |
| `timestamp` | When it happened. |
| `actorId` | Who did it (a user id), if known. It is not linked to `User`, so the diary survives when a user is deleted. |
| `action` | What happened, e.g. `LOGIN_SUCCESS`, `CREATE_RESERVATION`, `EXPORT_RESERVATIONS`, `SECURITY_ALERT`. |
| `resourceId` | What it happened to (e.g. a booking id). |
| `ipAddress`, `userAgent` | Where the request came from. |
| `metadata` | Extra details. Never passwords or tokens. |

Rules:
* A database trigger blocks every change and delete on this table, so no one can rewrite history through the app.
* In production, the app's database account should be allowed only to add and read rows here.

## 4. How deleting a user works ("cascade")

| When a user is deleted | What happens |
|---|---|
| Their `Session` rows | Deleted with them, so their browsers are signed out at once. |
| Their `ApiKey` row | Deleted with them, so the key stops working at once. |
| Their reservations | Block the delete. Bookings are never removed silently. |
| Bookings they made for others (`createdById`) | Kept; the "made by" field is emptied. |
| Their `AuditLog` rows | Kept. |

## 5. What the seed script puts in (`npm run db:seed`)

* The 108 dining tables.
* About 10 dishes with allergy tags.
* One admin account from `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
* The AI assistant's account, `assistant@resortos.internal`, with no password, and its one `ApiKey` row holding the fingerprint of `AGENT_API_KEY` (at least 32 characters). If `AGENT_API_KEY` is empty, the script prints a warning and skips the assistant.

The seed script can be run again safely: it updates what is there instead of adding copies.

## 6. Migrations (changes to the database's shape, in order)

| Folder in `prisma/migrations/` | What it changed |
|---|---|
| `20261103000000_init` | Created users, tables, reservations, table locks, menu and the audit diary, plus the trigger that keeps the diary unchangeable. |
| `20261103010000_agent_bookings` | Added the `AGENT` role, the booking source, "made by", the retry key, and let a guest account have no password. |
| `20261103020000_agent_api_key` | Stored the assistant's key fingerprint on its user row (replaced by the next migration). |
| `20261104000000_sessions_api_keys` | Added the `Session` and `ApiKey` tables, moved the assistant's key fingerprint into `ApiKey`, and removed the old column from `User`. |

Apply them with `npm run db:migrate`.
