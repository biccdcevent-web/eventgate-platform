# EventGate: Event Registration System

**Version 1.1** · 23 October 2026 · Jupiter Systems, Inc.

What's new in 1.1: up to 2 images per event, optimized automatically on upload; each image placed and sized on its own on the registration page, in the email and on the name tag; "the" before the event name in the email's closing line; clients with their own client administrators, who create and manage their own events and accounts.

One system for many events. Each event gets its own registration page at `yourdomain.com/<event-address>`, with its own branding, form fields, confirmation email, name tag, check-in PIN, records, backups and client logins. Registrants receive a QR pass by email, and staff scan it at the door to check them in and print a name tag.

## Pages

| Address | What it is |
|---|---|
| `/admin` | Admin page. The administrator signs in with username `admin` (or `ADMIN_USERNAME`) and `ADMIN_KEY` as the password. |
| `/<event>` | An event's registration page, e.g. `/cdc-bic`. |
| `/<event>/checkin` | That event's check-in station (needs the event's staff PIN). Works with a USB/Bluetooth barcode scanner or a phone camera, and prints name tags. |
| `/` | Opens the event you choose on the admin page (“… opens”), or a general page if none is chosen. |

## Admin page

**Events**: create events (from standard settings or copied from another event), see each event's numbers, and choose which event opens at the main address. New events start as **Draft** (hidden) until you open registration.

**Settings** for each event, with a live preview of the page, the email and the name tag:
- **Details**: name, web address, status (Draft, Open, Closed, Archived), date (one day or several, picked from a calendar) and start and end time, venue, organizer, introduction, time zone, optional capacity, staff check-in PIN.
- **Branding**: logo upload (PNG/JPG up to 2 MB), main, accent and background colours, heading and body fonts, text size.
- **Registration form**: show/hide, rename, reorder and require fields; add your own (short or long text, dropdown, options, tick box, number, date, phone, Philippine address). Consent statement, button text and messages.
  - **Philippine address** fields ask for the unit, floor, building and street, then Region → Province → City/Municipality → Barangay, each list limited to the one above (choosing NCR fills in Metro Manila). The postal code fills in when the city has one code, or offers that city's codes to choose from. Locations come from the PSA's PSGC (2025-2Q) and ZIP codes from the PHLPost directory (about 95% of cities and municipalities; for the rest the registrant types the code). Exports and the dashboard list the address in this order: street, barangay, city/municipality, province, region, postal code. To refresh the data, run `tools/build-ph-address-data.py`.
- **Email**: sender name, reply-to address, subject, message with registrant details like `{first_name}`, the details listed under the QR code, footer note, and a test send.
- **Name tag**: the two lines under the attendee's name, event name and logo.

**Images**: each event can have up to 2 images (for example the event logo and a partner's logo). Uploads are trimmed of blank margins, resized and compressed automatically. For the registration page, the email and the name tag separately, each image has its own spot (above the event name on the left, centre or right; left or right of the name; at the bottom on the left, centre or right; or not shown) and its own size. Images that share a row are sized to look balanced.

**QR code for invitations**: each event's page has a "QR code for invitations" link that opens the registration page's QR code, with the link to copy and downloads as PNG, SVG (for print) or a ready-made image with the event name and date.

**Dashboard** for each event: live check-ins and attendance, registrations per day, arrivals every 15 minutes, top companies, latest activity, an attendee list (select a person to see all their answers), Excel download, and an Analysis section for your own charts, including charts of custom fields.

**Backup & reset** for each event: reset check-ins after a rehearsal, delete all records, back up on demand, download or restore any backup, and archive or delete the event. A backup is always made first.

**Signing out**: closing the admin page (the tab or the whole browser) signs the user out; refreshing the page does not. Sessions also end after 12 hours.

**Accounts and clients**: three kinds of account.
- **Platform administrator** (you): signs in as `admin` with ADMIN_KEY. Sees and manages everything: all events, all accounts, and the **Clients** page.
- **Client administrator**: belongs to one client (a company you offer the platform to). Creates and manages that client's own events (settings, branding, form, email, name tags, check-in, backups, reports) and the client's accounts. Sees nothing of other clients.
- **Viewer**: sees the dashboards of the events they're given, with optional Excel download and chart editing.

On the **Clients** page the platform administrator adds clients, can set a limit on how many events a client may have active (not archived), and can turn a client off, which signs out all its accounts. Each event belongs to one client or to Jupiter (no client); the platform administrator can move an event in its Settings.

## Running it

Requires Node.js 22.

```bash
npm install
cp .env.example .env
npm run secret          # copy the output into PASS_SECRET in .env, and set ADMIN_KEY
npm start
```

Open http://localhost:3000/admin. Until SMTP is set, emails are saved to the `outbox/` folder as `.eml` files.

## Deploying (Render or any Node host)

1. Set the variables from `.env.example` in the host's environment settings, and set `TRUST_PROXY=1`.
2. Attach a **persistent disk** and set `DB_PATH` on it (e.g. `/var/data/registrations.db`). The database, uploaded logos (`uploads/`) and backups (`backups/`) are all stored there.
3. Serve over **HTTPS** (Render does this automatically). Phone cameras on the check-in page need it.

Never change `PASS_SECRET` after passes have been sent, or existing passes stop scanning.

## Upgrading from the single-event version

Upload the new files over the old ones. On first start the server saves a copy of the database (`backups/pre-upgrade-*.db`), creates the first event from the old `EVENT_*` settings with the old form, staff PIN and charts, moves every registration, check-in and client user into it, and makes it the event at the main address, so old links and QR codes keep working. Set `FIRST_EVENT_SLUG` beforehand to choose its web address. Backups made by the old version can still be restored into that event.

## Data privacy

The platform collects personal information, so in the Philippines it falls under the Data Privacy Act of 2012 (RA 10173). Each event's form asks for consent with a statement you can edit. Give each client their own user account limited to their events, turn accounts off after the event, and delete records and old backups when they are no longer needed.
