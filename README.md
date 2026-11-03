# RE:ACTORS STUDIO booking app

A website where people can read about your classes, ask questions, book and pay (£95 a month or £295 a term) through Stripe, and log in to see their booking. You get a private admin page listing every booking and question, plus an email for each one.

It has no add-on packages. It only needs Node 22.13 or newer and a place to keep one small database file.

## What it does

| Page | What it is |
| --- | --- |
| `/` | The public site: info, FAQ, policies, booking form, question form |
| `/account` | Student login by emailed one-time link, shows their booking, button to manage payments in Stripe |
| `/admin` | Your password-protected list of bookings and questions, CSV download |
| `/thanks` | Where Stripe sends people after paying |

When someone books, the app records them as "pending" and sends them to Stripe. When Stripe confirms the payment, the app marks the booking "paid", emails the student and you, and counts the place (the term closes at 20). If a monthly subscription is cancelled, the booking becomes "cancelled" and the place is freed.

## Putting it online (Render, step by step)

You need accounts with GitHub, Render and Stripe. Allow about an hour the first time.

### 1. Put the code on GitHub
1. Create a free account at github.com and make a **private** repository called `reactors-studio`.
2. Click **Add file > Upload files**, drag in everything from this folder (not `.env`), and commit.

### 2. Create the web service on Render
1. At render.com choose **New > Web Service** and connect your GitHub repository.
2. Settings: Runtime **Node**, Build Command `echo ok`, Start Command `npm start`.
3. Choose a **paid** instance type (the free type forgets your data every restart).
4. Under **Disks**, add a disk named `data`, mount path `/var/data`, 1 GB.
5. Under **Environment**, add these variables:

| Name | Value |
| --- | --- |
| `NODE_VERSION` | `22.13.0` |
| `NODE_ENV` | `production` |
| `BASE_URL` | the address Render gives you for now, e.g. `https://reactors-studio.onrender.com` (no trailing slash). Change it when you add your own domain. |
| `DATA_DIR` | `/var/data` |
| `SESSION_SECRET` | a long random string (mash the keyboard for 40 characters) |
| `ADMIN_PASSWORD` | a long password, 12+ characters, only you know |
| `STUDIO_EMAIL` | `reactorshq@gmail.com` |
| `STRIPE_SECRET_KEY` | from step 3 |
| `STRIPE_WEBHOOK_SECRET` | from step 3 |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | `reactorshq@gmail.com` |
| `SMTP_PASS` | from step 4 |

6. Click **Create Web Service**. When it says "Live", open the address and check the site loads.

### 3. Connect Stripe
1. In Stripe, go to **Developers > API keys** and copy the **Secret key**. Start in **test mode** (`sk_test_...`) and swap to live (`sk_live_...`) once everything works.
2. Go to **Developers > Webhooks > Add endpoint**. Address: your `BASE_URL` followed by `/api/stripe/webhook`. Select these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.deleted`, `invoice.payment_failed`.
3. Copy the endpoint's **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
4. Go to **Settings > Billing > Customer portal**, switch it on, and allow customers to **cancel subscriptions** and update payment methods. This powers the "Manage payments and subscription" button.
5. Redeploy on Render after changing variables.

Your two existing Payment Links are not used by this app. The app creates its own checkout pages at £95 a month and £295.

### 4. Set up email (Gmail)
1. In your Google account, turn on 2-step verification.
2. Search "App passwords" in your Google account, create one called "Re:Actors website", and copy the 16 characters into `SMTP_PASS` (no spaces).
3. Emails will come from reactorshq@gmail.com. Gmail limits sending to a few hundred emails a day, which is plenty here.

### 5. Test before telling anyone
In Stripe **test mode**, book using the card `4242 4242 4242 4242`, any future date, any 3 digits. Check that:
- you land on the thank-you page,
- the booking shows as **paid** in `/admin`,
- the student and you both receive emails,
- `/account` login works and the payments button opens Stripe.
Then switch to live keys and do one real small test.

### 6. Your own domain (optional)
In Render, **Settings > Custom Domains**, add your domain and follow the DNS instructions. Then update `BASE_URL` to the new address and update the Stripe webhook address.

## Day to day
- `/admin` shows bookings and questions. Change a booking's status there if you refund someone (refunds themselves are made in Stripe).
- The "Download bookings (CSV)" button gives you a spreadsheet.
- The database lives in `DATA_DIR`. Back it up now and then by downloading the file `reactors.db` from the disk, or ask a developer to set up automatic backups.

## For a developer
- `server.js` is the whole HTTP server. `lib/` holds the database (Node's built-in `node:sqlite`), a small Stripe client and a small SMTP client.
- `npm test` runs an end-to-end test using a fake Stripe and fake mail server.
- Settings are environment variables, listed in `.env.example`. Locally: copy it to `.env` and run `npm run dev`.
- Booking policy version is recorded against each booking (`POLICY_VERSION` in `server.js`). Change it when the policy text changes.
- Not covered by the automated test: real Stripe, and encrypted (TLS) SMTP. Test both once in your environment.
