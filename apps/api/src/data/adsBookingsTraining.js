/* ------------------------------------------------------------------ */
/* Ads & Bookings Operations — Training Academy track (modules       */
/* 39–50, added 2026-11-18 at Ramone's direction: "a full package    */
/* training on everything step by step to get ready to use system    */
/* for ads — and processing bookings and requests").                 */
/*                                                                   */
/* Twelve ARTICLE lessons in the same shape as the System Navigator  */
/* course (modules 30–38): seeded create-only by slug through        */
/* data/mediaOsSeed.js, tagged training-academy + ads-and-bookings,  */
/* PUBLISHED from day one. Part A (modules 39–44) teaches the ads    */
/* system end to end; Part B (modules 45–50) teaches processing      */
/* bookings and requests end to end.                                 */
/*                                                                   */
/* Every lesson is step-by-step against the REAL consoles and the    */
/* REAL rules as shipped: owner-only gates are named as owner-only,  */
/* and anything not yet open (SMS, Stripe payouts, plan prices, the  */
/* external campaigns) is taught as a gate — never as if it were     */
/* already live. Prices named are the platform's standing terms:     */
/* $99 residential diagnostic credited toward an approved repair,    */
/* $210 flat repair labor, $150 flat installation, parts at written  */
/* quote, commercial work by custom quote only.                      */
/* ------------------------------------------------------------------ */

export const ADS_BOOKINGS_LESSONS = [
  /* ============================ PART A — ADS ============================ */
  {
    module: 39, part: 'the-ads-landscape', title: 'The Ads Landscape',
    teaches: 'The two ads worlds — in-house Top Speed Ads on our own surfaces, and the external platforms — where each console lives, and how the house campaign works.',
    destinationUrl: '/ad-studio',
    body: `WHAT THIS LESSON COVERS:
Top Speed advertising runs in two worlds. IN-HOUSE ads ("Top Speed Ads") run on our own websites and apps through our own system — no outside platform takes a cut and nothing spends per click. EXTERNAL ads run inside Google, Meta (Facebook + Instagram), Microsoft and TikTok accounts. This track teaches both, in the order you will actually touch them.

WHERE EVERYTHING LIVES:
- Ad Studio — topspeedserviceos.com/ad-studio. The staff control room for in-house ads: campaigns, the approval queue, the creative library, attribution, the flywheel loop, the external readiness board, advertiser plans and subscriptions, and the streaming pack. Staff sign-in.
- Advertiser Console — topspeedserviceos.com/advertiser. The advertisers' own console: their campaigns, the campaign tools (planner, copy builder, tracking link builder, scorecard), channel connections, and Plans & Billing.
- Marketing OS — topspeedserviceos.com/marketing-os. The pages-and-SEO side: landing pages, the SEO dashboard, Insights. Ads send people to pages; Marketing OS owns the pages.
- The house banner — the flagship homepage and other Top Speed surfaces carry the in-house display feed. Approved ACTIVE house campaigns appear there, labeled as ads.

STEP BY STEP — TAKE THE TOUR:
1. Sign in with your staff account and open Ad Studio (/ad-studio).
2. Open the Campaigns view. Find the house campaign "Refrigerator Repair — Speedy Booking Launch" and note its status: ACTIVE. A house campaign promotes Top Speed itself on Top Speed surfaces.
3. Open the Advertiser Console (/advertiser) in a second tab. This is what an outside advertiser sees — their own campaigns only, never the whole platform.
4. Open the flagship homepage in a private window (signed out, the way a customer sees it). Find the house banner: it is labeled as an ad, its button goes to /book, and it can be dismissed. That banner is the in-house display feed serving the ACTIVE campaign.
5. Back in Ad Studio, open the External readiness board. This is the mirror of the campaigns that live in the OUTSIDE platforms — 13 of them today. Module 40 teaches how to read it.

THE HOUSE CAMPAIGN, IN ONE PARAGRAPH:
House campaigns are created in Ad Studio, submitted for approval, and only the owner can approve them. Approval is what turns a campaign ACTIVE, and ACTIVE display campaigns are what the banner feed serves — one raw impression is counted per serve. The streaming channel is separate: streaming ads never leak into the banner feed. One house campaign is live today; approving more is always the owner's click.

THE RULES:
- Nothing in the in-house system spends money. External spend happens only inside the external platforms.
- Nobody on staff enables, funds or publishes an external campaign. That is the owner's per-campaign decision, every time.
- If you cannot find a screen, ask the System Navigator (/navigator) — it answers from the same system map this Academy teaches from.

CHECK YOURSELF:
- Can you name which console an advertiser uses, and which one staff use?
- Can you explain why the homepage banner is labeled, and what made it appear?`,
  },
  {
    module: 40, part: 'readiness-before-spend', title: 'Readiness Before Any Spend',
    teaches: 'The External Readiness Board in Ad Studio: every gate standing between today and real ad spend, what each gate means, and exactly who can unblock it.',
    destinationUrl: '/ad-studio',
    body: `WHY THIS LESSON COMES BEFORE ANY ADS WORK:
Every external campaign in this business already exists — built, paused or drafted, with $0 spent. What stands between them and running is a short list of gates. Your job is to know each gate, who owns it, and never to describe a gate as open until it is verified open in the place it lives.

STEP BY STEP — READ THE BOARD:
1. Open Ad Studio (/ad-studio) and go to the External readiness board.
2. Read the label at the top first: the board is a MIRROR of the campaigns built in each platform, with statuses as last verified (2026-11-17). It does not call any external API. If a status matters, verify it inside the platform itself.
3. Count the campaigns: 3 in Google Ads (all PAUSED), 9 in Meta (all unpublished DRAFTS), 1 in Microsoft Ads (PAUSED). 13 total, $0 spent anywhere.
4. Open any campaign row and read its missing steps. Steps marked owner-only can only be done by Ramone. Everything else is preparation staff can do.

THE GATES, ONE BY ONE:
- STRIPE PAYOUTS (owner-only). Payments are live — customers can pay the $99 diagnostic by card today. But payouts are DISABLED because no bank account is on file. Only the owner can fix it: Stripe dashboard, Settings, Payouts, add the bank account and pass the identity check. Nobody can do this for him, and no training step substitutes for it.
- GOOGLE ADS FUNDING (owner-only). The Google Ads account (648-991-4065) is unfunded; funding charges were declined on 2026-11-17. Until the owner adds a working payment method and makes the funding decision, all 3 Google campaigns stay paused no matter what anyone clicks.
- META LEAD ADS TERMS (owner-only). Before Lead Ads can run for the Top Speed repair Page, the owner must accept Meta's Lead Ads terms in Meta. Until then that format is blocked.
- TIKTOK ACCOUNT (owner-only). There is no TikTok Ads account. Creating one is a business signup (ads.tiktok.com, as Top Speed Appliance LLC) that only the owner does.
- ADVERTISER PLAN PRICES (owner-only). The advertiser plans exist as structure, but their prices are UNSET. Until the owner sets a price in Ad Studio, an advertiser cannot check out — the system refuses with "pricing not set". Never quote a plan price that is not set. Module 43 teaches plans in full.
- TWILIO UPGRADE (owner-only). Text messaging runs on a trial Twilio account, so platform SMS honestly fails today — Layer 2 sign-in codes and Link Center texts included. Email carries those flows meanwhile. The owner upgrades Twilio by adding a payment method; the moment he does, SMS starts working with no rebuild.
- META PIXEL (staff can prepare, owner approves install). No Meta pixel is installed, so Meta campaigns run on the Traffic objective until the pixel exists and is approved.

WHAT YOU SHOULD SAY, AND NEVER SAY:
- Say: "The campaigns are built and paused. The remaining steps are the owner's: funding, terms, and the launch decision."
- Never say a campaign is "live", "running" or "about to start" while its gate is closed — and never promise a customer or advertiser a start date that depends on a gate.

CHECK YOURSELF:
- Pick any campaign on the board. Can you list its missing steps and name who unblocks each one?
- Which gate blocks payouts even though card payments already work?`,
  },
  {
    module: 41, part: 'ad-studio-workflow', title: 'Ad Studio: Approvals, Campaigns & the Streaming Pack',
    teaches: 'The daily Ad Studio workflow: the approval queue, creating a campaign, banner vs streaming channels, and loading the Flywheel Streaming Pack.',
    destinationUrl: '/ad-studio',
    body: `THE ONE RULE THAT RUNS THIS CONSOLE:
Nothing publishes itself. Every campaign — written by a person or drafted by Speedy — lands in PENDING_APPROVAL, and only the owner approves. Approval is the publish button. If you remember one thing from this module, make it that.

STEP BY STEP — WORK THE APPROVAL QUEUE:
1. Open Ad Studio (/ad-studio) and go to Campaigns.
2. Filter by status PENDING_APPROVAL. These are waiting on the owner — staff cannot approve, and the approve action is owner-only in the system itself, not just by policy.
3. Open a pending campaign and review it the way the owner will: headline and body within limits, destination URL correct, creative appropriate, copy inside the law (Module 42 — no reviews or ratings, no invented prices, no phone numbers in ad text).
4. If something is wrong, send it back through editing before it reaches the owner. A clean queue is your job; the decision is his.
5. When the owner approves, the campaign becomes ACTIVE. Display campaigns join the banner feed at that moment. Paused campaigns can be paused by staff; resuming one is owner-only.

STEP BY STEP — CREATE A CAMPAIGN:
1. In Campaigns, choose Create Campaign.
2. Name it for its job (service + destination), pick its category, and set the destination URL — the real page the ad sends people to, usually /book, /commercial, /speedy or /refer.
3. Choose the channel: DISPLAY (the banner on Top Speed surfaces) or STREAMING (text/display formats aimed at streaming providers — Module 41's streaming section below).
4. Write the headline and body, or use Draft with Speedy and the creative picker (Module 42 teaches both).
5. Save the draft, check it once more, then Submit. It lands in PENDING_APPROVAL. You are done — the owner takes it from there.

BANNER VS STREAMING, PLAINLY:
- DISPLAY campaigns serve in the in-house banner feed on Top Speed websites and apps. Approving one puts it in front of our own visitors.
- STREAMING campaigns are built to streaming formats (text and display) with streaming providers as TARGET LABELS — Roku, YouTube TV, Hulu and the rest are labels for where the ad is aimed, not live placements. Real placement on a provider needs that provider's ad account and budget, a later owner activation. Approving a streaming campaign never puts it in the banner feed.

STEP BY STEP — THE FLYWHEEL STREAMING PACK (OWNER-ONLY CLICK):
1. The pack is 10 ready-made house ads: refrigerator repair, same-day repair, washer and dryer repair, oven and range repair, dishwasher repair, appliance installation, property managers and commercial, Speedy photo diagnosis, the referral program, and tri-county coverage — each pointing at its real page.
2. Only the owner clicks "Load Flywheel Streaming Pack" in Ad Studio. The load creates the 10 ads as house campaigns in PENDING_APPROVAL. Loading twice does not duplicate them — the load is idempotent.
3. The owner then approves the ads he wants in the approval queue, one decision at a time, like any other campaign.
4. Staff role: know the pack exists, know it is loaded and approved only by the owner, and never describe the streaming ads as "running on Roku" — they are approved in-house creatives until a provider account exists.

CHECK YOURSELF:
- A campaign you submitted is still PENDING_APPROVAL. Who can move it, and what is your job while it waits?
- Why can a streaming approval never appear on the homepage banner?`,
  },
  {
    module: 42, part: 'writing-ads-that-pass', title: 'Writing Ads That Pass the Rules',
    teaches: 'Draft with Speedy, the creative picker, the character limits, and the copy law every Top Speed ad obeys — enforced by the system for Speedy drafts, and by you for everything else.',
    destinationUrl: '/ad-studio',
    body: `STEP BY STEP — DRAFT WITH SPEEDY:
1. In the Ad Studio campaign editor, choose Draft with Speedy.
2. Give Speedy the service or offer and the destination page. Speedy writes headline and body options inside the channel's character limits, from the platform's real facts.
3. Read every option against the copy law below before you keep it. Speedy's drafts are brand-checked by the server — review claims and stray price lines are stripped — but you are the second pair of eyes.
4. Keep the draft you want and submit the campaign. Speedy drafts land in PENDING_APPROVAL like everything else; the AI never publishes.
5. If Draft with Speedy answers that it is unavailable (the AI provider is not configured), write the copy yourself inside the same limits and the same law. The queue does not stop for a tool outage.

STEP BY STEP — THE CREATIVE PICKER:
1. In the campaign editor, open the creative picker.
2. Choose from the house library: the six house posters and the scenario image library, or Media OS creative when it exists.
3. If both a picker image and Media OS creative are set, the Media OS creative wins. Know which one will actually serve before you submit.

THE CHARACTER LIMITS (THE SYSTEM ENFORCES THESE):
- Google-style and streaming headlines: 30 characters maximum. Descriptions: 90 characters maximum.
- In-house banner: headline up to 120 characters, body up to 400 characters.
- Write to the limit of the channel the ad will run on — not the loosest limit you can find.

THE COPY LAW (EVERY AD, EVERY CHANNEL):
- No reviews, ratings, stars or testimonials in ad copy. Ratings are earned from real reviews of real jobs; ad copy never claims them.
- No invented prices, discounts or statistics. The only price line allowed is Top Speed's own standing terms, worded exactly: the $99 diagnostic is residential, collected at booking, and credited toward an approved repair.
- The $99 diagnostic NEVER appears in commercial copy. Commercial work is priced by custom quote — that is the whole commercial price story.
- No vent prices, ever. Cleanout Vents is the network's vent partner and has no price on Top Speed surfaces; never offer vent cleaning as a bookable appliance service.
- No phone numbers inside ad text. On Google, the number rides as a call asset, not in the copy.
- Never advertise under another business's identity. Top Speed ads run under Top Speed pages and accounts — never the Appliance Plus Air page or name; that is a separate LLC (Module 44 returns to this).

CHECK YOURSELF:
- Draft a refrigerator headline in 30 characters or fewer that obeys the copy law.
- A draft says "4.9 stars — $99 for all customers, homes and businesses". Name every violation.`,
  },

  {
    module: 43, part: 'advertiser-plans-and-billing', title: 'Advertiser Plans & Billing',
    teaches: 'The three advertiser plan tiers as structure, why unset prices mean no checkout, grandfathered accounts, office grants, and what the advertiser sees.',
    destinationUrl: '/ad-studio',
    body: `THE SHAPE OF THE SYSTEM:
Outside businesses advertise on the Top Speed network through the Advertiser Console (/advertiser). What an advertiser can do is set by their plan. Plans are real, billing runs on the same production Stripe as the diagnostic payments, and every price in this module is deliberately absent — because prices are the owner's numbers to set, not the training's to invent.

THE THREE TIERS (STRUCTURE ONLY — PRICES UNSET):
- Starter: campaigns + display channel. Up to 3 active campaigns. Banner (DISPLAY) placements.
- Growth: everything in Starter, plus attribution reporting and the creative picker. Up to 10 active campaigns. DISPLAY.
- Pro: all seven features — campaigns, display, streaming, the Speedy ad drafter, attribution, the flywheel loop view, and the creative picker. Unlimited campaigns. DISPLAY + STREAMING.
An advertiser who tries to use a feature above their plan gets a clear upgrade message from the system (plan_upgrade_required), and campaign caps stop new campaigns at the plan limit (plan_limit_reached). Pausing a campaign is never blocked by the plan gate.

STEP BY STEP — HOW A PRICE COMES TO EXIST (OWNER):
1. The owner opens Ad Studio and goes to Advertiser plans.
2. He sets a plan's price. The system creates that plan's Stripe product and price with exactly the amount he entered — the plan record is the single source of truth.
3. Only then can advertisers check out for that plan. An unpriced plan refuses checkout with "pricing not set" and no Stripe call is made.
4. In the Advertiser Console, Plans & Billing shows a price only when one is set. Until then it reads "Pricing launching soon" — that is the honest state, not a bug to report.

GRANDFATHERED ACCOUNTS AND OFFICE GRANTS:
- Advertisers who were already on the platform when plans launched, and accounts the office issues, keep the baseline they had: campaigns + display, unlimited. Plans never take access away from them.
- The owner can office-grant a plan to an advertiser for free from Ad Studio's Advertiser subscriptions view — and revoke it there too. Grants and revocations are audited.
- Owner, staff and marketing-manager accounts bypass plan gates by role. An advertiser never does.

BILLING, AS THE ADVERTISER LIVES IT:
- Checkout is a Stripe subscription checkout. When it completes, the subscription turns ACTIVE.
- A failed payment moves the subscription to PAST_DUE, then a grace period (7 days by default) where access continues, then SUSPENDED if it is still unpaid.
- A downgrade takes effect at the end of the current period, not mid-period. Cancelling sets the subscription to end at period end — access runs until then.
- There is no fake "billing portal" link anywhere; billing questions go to the office.

WHAT STAFF SAY:
- Say: "Plans are launching with pricing set by the owner. Your existing access continues unchanged."
- Never quote a plan price, a discount, or a launch date. If it is not set in Ad Studio, it does not exist.

CHECK YOURSELF:
- An advertiser on Starter wants a streaming campaign. What does the system do, and what do you tell them?
- Why does "Pricing launching soon" appear in Plans & Billing, and who changes it?`,
  },
  {
    module: 44, part: 'measurement-and-going-live', title: 'Measurement, Insights & Going Live Externally',
    teaches: 'First-touch attribution and click IDs, reading the Insights console honestly, the flywheel loop, and the exact per-platform steps between a paused campaign and a live one.',
    destinationUrl: '/ad-studio',
    body: `HOW WE KNOW AN AD WORKED — ATTRIBUTION:
1. When a visitor lands on a Top Speed page, the system captures first-touch attribution and keeps it for 30 days: utm_source, utm_medium, utm_campaign, and the platform click IDs — gclid (Google), fbclid (Meta), msclkid (Microsoft). First touch wins; later visits do not overwrite it.
2. When that visitor books or submits a request, the attribution attaches to the booking or connection record. That is how a completed job traces back to the ad that started it.
3. Click IDs are accepted loosely on purpose: a malformed click ID can never break a booking. The booking matters more than the tracking.

STEP BY STEP — READ INSIGHTS:
1. Open the Insights console (/insights). Staff sign-in.
2. Overview: the first-party funnel for the last 28 days (Eastern) — leads to bookings to completed jobs — broken down by UTM source, landing page, surface and intake source, with click-ID counts. An "(not captured)" bucket is normal: it means those bookings arrived without tracking, and the console says so instead of guessing.
3. PageSpeed board: mobile performance snapshots for the portfolio homepages — 10 are tracked today, including the newest domains. Refresh is staff-triggered; hit "Refresh all snapshots" to fill fresh numbers. A row marked ERROR means that measurement failed and was stored as a failure — it is data about the measurement, not proof the site is down.
4. Connections: Google Analytics, Search Console and Google Business Profile each show a connection status. Until the owner's grants and keys are in place they read NOT_CONNECTED and show NO metrics. That blank is honesty, not a broken console — never fill it in from memory or estimate numbers for anyone.

THE FLYWHEEL LOOP (AD STUDIO):
The loop view follows a campaign's work around the wheel: banner serves, then clicks, then attributed bookings are REAL numbers. Completed jobs, reviews and referrals show as placeholders that connect when jobs actually complete. Read the placeholders as "not connected yet", never as zeros you can quote.

COUNTING, HONESTLY:
The display feed counts one raw impression per serve and counts a click when the banner's button is used. Click-through rate is shown only when there are impressions, and it is labeled "raw serves/clicks". Report it with that label, or do not report it.

GOING LIVE EXTERNALLY — THE STEPS PER PLATFORM (EVERY LAUNCH IS THE OWNER'S DECISION):
- GOOGLE ADS (account 648-991-4065): 3 campaigns stand PAUSED — appliancepro.net Commercial Portal ($15/day proposed), Refer & Earn ($5/day proposed), and the YouTube video campaign ($5/day proposed). Steps to live: (1) the owner funds the account with a working payment method; (2) the owner unpauses each campaign he chooses, one at a time. Budgets stay proposals until he approves them in the platform.
- META (account 834084027055828): 9 campaigns stand as unpublished DRAFTS in Ads Manager — repair bookings, the .net site, the commercial portal, Cleanout Vents, Appliance Connect Pro, Pepper Lists, CocoCane and the referral program. Steps to live: the owner publishes each campaign he chooses, under each brand's OWN page. The Top Speed campaigns run under the Top Speed Appliance Repair and Installation page.
- MICROSOFT ADS: 1 campaign stands PAUSED ("Flywheel — .net Residential Repair (Bing)", $20/day placeholder budget). It sits in an advertiser account NAMED "Appliance Plus Air, LLC" — whether it stays there or is rebuilt under a Top Speed name is the owner's call, flagged since the day it was built.
- TIKTOK: no account exists. The owner's signup comes first (Module 40); there is nothing to launch until then.

THE IDENTITY RULE (NO EXCEPTIONS):
Top Speed ads never run under the Appliance Plus Air page, name or accounts. Appliance Plus Air, LLC is a completely separate business from Top Speed Appliance LLC. The Meta ad account's default page is the Appliance Plus Air page — always override it per brand, every time, and check the page on the campaign before anything is submitted or published.

CHECK YOURSELF:
- A booking shows gclid but no UTM campaign. What does that tell you, and what does it not tell you?
- A Meta draft is ready. List, in order, everything between today and that campaign serving — and whose hands each step is in.`,
  },

  /* ====================== PART B — BOOKINGS & REQUESTS ====================== */
  {
    module: 45, part: 'how-a-booking-is-born', title: 'How a Booking Is Born',
    teaches: 'Every intake that creates a booking — the web form first, Speedy chat behind its summary-confirm gate, wired landing pages, Pepper Lists Book, and the phone — and what the customer receives.',
    destinationUrl: '/book-os',
    body: `THE ORDERING RULE (SET BY THE OWNER, NEVER REVERSED):
The classic web form is the PRIMARY booking path on every surface. Traditional customers book on the form. Speedy AI booking sits below the form as the option for high-tech customers. Speedy CHAT — questions and photo diagnosis — stays everywhere; this rule is only about which booking door leads.

THE FIVE INTAKES:
1. THE WEB FORM. /book, the homepage booking section, the /app Book tab, and every wired landing page (topspeedappliancerepair.com, totalhomeappliance.com and the rest) run the same form into the same queue. The form asks for name, phone, city, ZIP, appliance, issue and preferred window — and captures the visitor's attribution (Module 44) on the way in.
2. SPEEDY CHAT. A customer chatting with Speedy can book from the chat — but Speedy must first SUMMARIZE everything it collected and show the customer a summary card. Nothing goes to the Service Setters office until the customer confirms the summary with a tap. No confirmation, no booking. In fallback mode (the AI provider is down) no summary card can appear and no chat booking can be sent at all — the customer is pointed to the form and the phone instead.
3. PEPPER LISTS — BOOK. Inside Pepper Lists, the Book purpose leads with the same web form, then Speedy booking, then Scan & Send. Same queue on the other side.
4. THE PHONE. A customer calls 954-931-7997 and the setter creates the booking in Book OS from the call. The booking is the same record either way.
5. COMMERCIAL AND PM DOORS. Businesses and property managers come through Appliance Pro and Appliance Connect Pro with business accounts; their work orders land in the same setter world with their own references (Module 50 covers the request types that are NOT bookings).

WHAT THE CUSTOMER RECEIVES:
- A real reference code for their booking — shown on the confirmation and used with their phone number for tracking.
- Honest area states: a booking inside the 12 auto-match cities (Module 46) flows straight to the setter queue. A booking from a wider-area city is accepted and lands in AREA_REVIEW — the customer is told the office reviews new-area requests, never promised a window the office has not approved.
- Confirmations by email and text follow the booking's life: received, appointment set, tech assigned, on the way — each one sent only when the recorded state actually changed.

TRACE IT YOURSELF (READ-ONLY):
1. Open the CRM and find a recent booking by its reference code.
2. Read its source and attribution fields: which door it came through, and which campaign touched it first.
3. Follow its status history. Every state you see was set by a person or a real event — never by a timer pretending work happened.

THE RULES:
- Production is not a practice field. Never create test bookings, test accounts or test sends in the live system — drills run on local copies only.
- A booking is one record from birth to completion. If two doors seem to show two jobs for one customer visit, stop and reconcile — do not work both.

CHECK YOURSELF:
- A customer in chat says "just book it" before the summary appears. What happens, and why?
- A booking arrives from a city outside the 12. What state does it land in, and what was the customer told?`,
  },
  {
    module: 46, part: 'working-the-setter-queue', title: 'Working the Setter Queue in Book OS',
    teaches: 'The Service Setters daily craft: reading the queue in Book OS, the 12 auto-match cities and AREA_REVIEW, setting appointments, and confirmations.',
    destinationUrl: '/book-os',
    body: `WHERE THE WORK LIVES:
Book OS (topspeedserviceos.com/book-os) is the Service Setters' home: the setter queue, appointments, the dispatch board, exceptions, recovery queues and capacity. The queue is the single list every intake from Module 45 lands in. If it is not in the queue, it is not a booking yet.

STEP BY STEP — READ A NEW BOOKING:
1. Open Book OS and go to the setter queue. New bookings arrive at the top with their status.
2. Open one. Read it in this order: customer name and phone; appliance and issue; city and ZIP; preferred window; the source door; attribution.
3. Check the area state before anything else (next section). Then the phone number — a booking you cannot call back is a booking you cannot confirm.

THE 12 AUTO-MATCH CITIES:
Lauderhill, Plantation, Sunrise, Tamarac, Fort Lauderdale, Lauderdale Lakes, North Lauderdale, Davie, Coral Springs, Pompano Beach, Oakland Park, Margate.
- Bookings from these 12 cities auto-match: they are ready for appointment-setting and assignment right away.
- Top Speed publishes service pages for 65 tri-county cities. Bookings from the other cities are ACCEPTED and land in AREA_REVIEW. The office reviews them and resolves the area on the booking (the resolve-area action in Book OS) before any window is promised.
- Never tell a customer in an AREA_REVIEW city that they are booked for a window. Say the office is reviewing their area and will call — then make sure the review actually happens the same day.

STEP BY STEP — SET THE APPOINTMENT:
1. From the booking, open the appointment setter and look at the day's slots.
2. Pick the window that fits the customer's preference and the route (Module 47's capacity view helps you pace the day).
3. Save the appointment. The booking's confirmation updates go out from the recorded state — appointment set is a real state change, and the customer hears about it because it happened, not because a script fired.
4. If the customer needs a different time later, use the reschedule action on the appointment — never delete and recreate; the record's history is the business's memory.

CONFIRMATIONS AND REMINDERS:
- The day-before reminder run sends appointment reminders for bookings with appointments set on the target date. If a reminder did not go out, the notifications console (Module 50) shows why — read the state, do not guess.
- When you set or move an appointment, you are making a promise in the customer's messages. Set only windows the day can actually hold.

THE SETTER'S STANCE:
Speed to lead wins jobs, but accuracy keeps them. A booking read carefully once beats a booking fixed three times. When in doubt about area, price or promise — ask before you confirm, and write what you decided on the record.

CHECK YOURSELF:
- A booking from Hollywood arrives. Which state does it land in, what do you do first, and what exactly do you tell the customer?
- Name the 12 auto-match cities from memory. (They are listed above until you can.)`,
  },

  {
    module: 47, part: 'exceptions-priorities-recovery', title: 'Exceptions, Priorities & Recovery Queues',
    teaches: 'P1–P4 priority tiers and how to set them, the exception queue and its five thresholds, the recovery queues, and the capacity view that never blocks a booking.',
    destinationUrl: '/book-os',
    body: `PRIORITY TIERS — THE OFFICE'S URGENCY SIGNAL:
- Every booking carries a tier: P1 (most urgent) through P4. The tier is how the office tells the whole team what to work first.
- Defaults are derived: a new booking starts at P3; installations start at P4.
- A tier a person sets wins over the derived default everywhere the tier is shown.
- STEP BY STEP: open the booking in Book OS, use the priority action, choose the tier, save. Set tiers deliberately — when everything is P1, nothing is. Raise a tier when a promise is at risk (a window about to be missed, a customer already waiting on a recovery), lower it when the urgency passes.

THE EXCEPTION QUEUE — WHERE TROUBLE SURFACES ITSELF:
Open Book OS and go to Exceptions. The queue builds itself from recorded states and five thresholds. Nothing here is a guess; every row is a booking whose recorded facts crossed a line:
1. MISSED ACCEPTANCE — an approved offer the tech has not accepted within 60 minutes.
2. LATE ARRIVAL — a job whose arrival is running past its window.
3. PARTS DELAY — a job flagged awaiting-parts for more than 48 hours.
4. UNRESOLVED ESTIMATE — an estimate with no recorded authorization 24 hours after it was written.
5. ESCALATED COMPLAINT — an escalated customer review with no office reply; it falls due 24 hours after it was created.
Work the queue top-down: open the booking, fix the underlying state (call the tech, call the customer, reply to the review), and the row clears because the facts changed — not because anyone hid it.

THE RECOVERY QUEUES — WORK THAT MUST NOT DIE QUIETLY:
Open Book OS and go to Recovery Queues. Five lists, each with its own action on the booking:
- AWAITING PARTS: jobs paused on parts. Watch the 48-hour exception threshold; keep the customer told.
- PENDING ESTIMATES: estimates written, authorization not yet recorded. The 24-hour clock is running (threshold 4 above).
- RETURN VISITS: jobs that need a second visit. Use the return-visit action on the booking to book it — a return visit is a real booking state, not a note in a margin.
- CANCELLATIONS: use the cancel action on the booking. A cancelled booking keeps its record and its reason; never delete.
- UNPAID: completed work with a balance, shown in exact cents owed. Chase with facts: the Link Center payment link (Module 50) sends the customer their real checkout.

THE CAPACITY VIEW — A PLANNING ESTIMATE, NEVER A WALL:
- Book OS capacity settings default to a 25 percent buffer, 120 minutes per job, and an 8-hour working day. The view estimates how much of the day the current bookings consume.
- It is labeled a planning estimate because that is all it is: capacity NEVER blocks a booking. Use it to pace windows and spot an overloaded day early — never to refuse work or tell a customer "we are full" as if the system decided.

MISSED CALLS — THE HONEST GAP:
There is no missed-calls list, because there is no call-log source feeding one. The system shows none and says why. Never reconstruct call history from memory or present a guess as a call log — if a customer says they called, work from the booking and CRM records that exist.

CHECK YOURSELF:
- An estimate was written yesterday morning and nobody recorded an authorization. Where does it appear, and after how long?
- A day's capacity reads over 100 percent. What may you do — and what may you never do — with that number?`,
  },
  {
    module: 48, part: 'assignment-and-dispatch', title: 'Assignment: Suggestions Advise, Humans Decide',
    teaches: 'The ranked assignment suggestions in Book OS — what the ranking weighs, why it never dispatches by itself, and what the tech receives when you assign.',
    destinationUrl: '/book-os',
    body: `THE RULE THAT NEVER BENDS:
There is no auto-dispatch in Top Speed Service OS. The system ranks; a human assigns. Every assignment in this business is a person's decision on a real record — that is deliberate, and it is the Service Setters' core responsibility.

STEP BY STEP — ASSIGN A BOOKING:
1. Open the booking in Book OS and open Assignment suggestions.
2. Read the ranked list. The ranking weighs, in order: specialty match (the tech works on this appliance), serving the booking's city, and the tech's earned rating — ratings come only from real reviews of real completed jobs, and a tech with no reviews yet simply has no rating score, which the ranking treats honestly.
3. Weigh what the ranking cannot see: today's route, the tech's current load (Module 47's capacity view), parts on the van, and anything the customer told you on the phone.
4. Choose the tech yourself and confirm the assignment. The booking records who was assigned, and the customer receives the assigned update with tracking.
5. Watch the acceptance. If the tech has not accepted within 60 minutes, the booking surfaces in the exception queue (Module 47) — reassign or chase, do not let it sit.

WHAT THE TECH RECEIVES:
The job appears in the tech's Speedy Pro app (Module 49): customer, appliance, issue, city, window and the job's record. The tech accepts from the app. An offer that is not accepted is not an assignment — it is a question waiting for an answer, and the 60-minute exception is how the office hears the silence.

WHAT THE CUSTOMER SEES:
Assignment fires the customer update: a technician is assigned, with the tracking door (Track My Tech) for the visit's live stages. The customer sees stages change when the work really changes them — en route means en route.

COMMON MISTAKES:
- Assigning the top-ranked tech without reading the day. The ranking is advice with good eyesight and no calendar.
- Reassigning silently. If the tech changes, the customer update must reflect the real new state.
- Treating a suggestion list as a queue to empty. Each assignment is a promise: right tech, right window, reachable customer.

CHECK YOURSELF:
- The top-ranked tech is across the county with two jobs left; the second-ranked tech is idle in the booking's city. Who do you assign, and what makes your answer right?
- An assigned job shows in Exceptions at 61 minutes. What are your two moves?`,
  },
  {
    module: 49, part: 'the-tech-flow-in-speedy-pro', title: 'The Tech Flow in Speedy Pro',
    teaches: 'The technician workflow end to end: the Today list, Start Work, before/during/after photos, the structured diagnosis, the estimate builder and its math, authorization, van stock, external receipts, and the completion quality gate.',
    destinationUrl: '/tech',
    body: `WHERE TECHS WORK:
Speedy Pro, the Tech App (topspeedserviceos.com/tech), is the technician's only workplace. If it did not happen in Speedy Pro, it did not happen — photos on a personal camera roll and numbers on paper do not exist to the office, the customer, or the record.

STEP BY STEP — RUN A JOB:
1. TODAY LIST. Open Speedy Pro and read your Today list. Open the job: customer, appliance, issue, city, window. Accept the assignment if you have not (Module 48 — the office's 60-minute clock is running).
2. START WORK. When you begin, set Start Work. If you are blocked, set the honest flag instead: Awaiting Parts or Awaiting Diagnosis. A true flag beats a silent delay every time — flags are what the exception queue reads.
3. PHOTOS. Take before, during and after photos on the job, in the app. Before shows the state you found; during shows the work; after shows the finished state. The photo report is what property managers and customers see — shoot it like they are standing beside you.
4. STRUCTURED DIAGNOSIS. Record the confirmed diagnosis and the recommended repair on the job. "Confirmed" means you tested it — Speedy's photo diagnosis is a head start, never the diagnosis of record.
5. ESTIMATE BUILDER. Build the estimate from the standing terms (the math is below). Parts go in at their quoted prices; add the discount if one applies and the tax on parts as it applies.
6. AUTHORIZATION. Get the customer's approval and record the authorization on the job. No work without an approved written quote — the authorization log is the proof, and an estimate with no recorded authorization lands in the office's exception queue at 24 hours.
7. VAN STOCK. Pulling a part from your van? Allocate it to the job from van stock: the stock count drops and the usage is written on the job. The system refuses over-allocation — if it says the van does not have it, the van does not have it.
8. PAYMENTS IN THE FIELD. The $99 diagnostic was collected at booking by card. If a customer pays any balance another way, record it as an external receipt on the job — NEVER type card numbers into the app, ever.
9. COMPLETE. Tap Complete. The quality gate (below) decides whether the job may close.

THE ESTIMATE MATH (THE STANDING TERMS):
- Repair labor: $210 flat. Installation labor: $150 flat. Parts and materials are extra, at quoted prices.
- The $99 diagnostic is credited toward an approved repair — residential only. It is NEVER part of a commercial job's numbers; commercial work is priced by custom quote.
- Worked example (residential repair): labor $210.00 + parts $45.00 + tax on parts $3.15 − diagnostic credit $99.00 = $159.15 due. The builder computes this server-side; your job is entering true inputs, not doing arithmetic on a receipt.

THE COMPLETION QUALITY GATE:
Complete is refused — with a list of exactly what is missing — until BOTH of these exist on the record: (1) the confirmed diagnosis with the recommended repair, and (2) a recorded estimate authorization. Payment is NEVER part of the gate: a job can complete with a balance owed (the office sees it in Unpaid, Module 47), but it cannot complete undocumented. If the gate refuses you, read the missing list, go record the thing, and complete again.

CHECK YOURSELF:
- A customer approved the repair verbally and paid in full, but you never recorded the authorization. Can the job complete? What do you do?
- Build the numbers for a residential installation with $60 of parts and no tax: what labor applies, and does the diagnostic credit apply the same way?`,
  },
  {
    module: 50, part: 'completion-and-follow-through', title: 'Completion, Payments, Links & the Daily Rhythm',
    teaches: 'What completion fires (the review request and the referral code), how payments and receipts work, the Link Center, the request types that are not bookings, the Email Manager and notifications console, and the daily rhythm checklist.',
    destinationUrl: '/book-os',
    body: `WHAT COMPLETION FIRES:
The moment a job completes (Module 49's gate passed), two things go out to the customer from the recorded facts: the REVIEW REQUEST — an invitation to review the service, which is also the moment to make anything right first if it is not right — and the REFERRAL CODE, the customer's personal code for the referral program. Reviews are earned this way, one real job at a time; ratings exist only because these requests follow real completions.

THE REFERRAL TERMS (APPROVED — QUOTE THEM EXACTLY):
$25 credit for each completed referral. At 5–9 referrals the credit is $35 each; at 10 or more, $50 each. Milestones: $100 at 10 referrals and $250 at 25. Credits expire after 12 months. The friend who was referred gets $25 off their first repair — a different offer from the referrer's credit; do not merge them.

PAYMENTS AND RECEIPTS:
- The $99 diagnostic is collected at booking through Stripe checkout. The balance is due on completion unless something else was agreed in writing.
- A receipt is composed ONLY from recorded data: it says PAID only when the payment record says PAID, and otherwise states the diagnostic terms as booked. Never tell a customer a payment "went through" from memory — read the record.
- Payouts to the business bank account are a separate Stripe switch and stay disabled until the owner adds the bank account (Module 40). Money can be collected while payouts are pending; that is normal, not an error to fix in the field.

THE LINK CENTER — SEND THE LINK YOURSELF:
Open the Link Center (topspeedserviceos.com/link-center; there is also a door in Book OS). Staff pick a link, a channel, and a recipient, and press send — sends happen only on that human click.
1. Choose the link type: PAYMENT, BOOKING, ACCOUNT or REVIEW.
2. PAYMENT needs the booking reference: the system sends that booking's real Stripe checkout for the $99 diagnostic — reusing the open checkout if one exists. Unknown reference, already paid, or Stripe unconfigured: it stops and tells you instead of sending a bad link.
3. Choose EMAIL or SMS and enter the recipient. Email delivers today. SMS is attempted and lands FAILED with Twilio's reason until the owner upgrades the Twilio account — the console shows a warning banner saying exactly that. Send the email; do not promise the text arrived.
4. Every send lands in the send log with its true state and the recipient masked. SENT means the provider accepted it — nothing else earns that word.

REQUESTS THAT ARE NOT BOOKINGS:
- CONNECTIONS INBOX. Provider applications, commercial account requests, property-manager inquiries and other submissions arrive through the connections intake. Humans review them; a provider application is not a booking and never enters dispatch.
- PEPPER LISTS SELL SUBMISSIONS. A customer's sale listing records as its own kind of submission. It is NEVER a booking, never a dispatch lead, and never gets a tech assigned. Sell, Post and Book are three different purposes — keep them separate in your head and in the system.
- REVIEWS MODERATION. The Pepper Lists reviews wall is moderated from Book OS; escalated reviews with no office reply feed the exception queue (Module 47).

THE EMAIL MANAGER AND THE NOTIFICATIONS CONSOLE:
- Email Manager (inside Book OS): the service@ mailbox forwards a copy of every message into the platform, and incoming mail files itself onto the customer's CRM record. Replies and new messages are HUMAN-CLICKED only — the system never sends office email on its own.
- Notifications console: every platform message lives in one outbox with a truthful state — QUEUED, then SENT, FAILED (with the provider's reason) or GATED (held by a setting or a missing recipient, with the reason named). "Send queued now" drains a stuck backlog by hand. When a customer says "I never got it", this console — not memory — is where you look.

THE DAILY RHYTHM CHECKLIST:
1. Exceptions first (Module 47): missed acceptances, late arrivals, parts over 48 hours, estimates over 24 hours, unanswered escalated reviews.
2. Today's appointments: windows set, reminders gone out, routes sane against capacity.
3. AREA_REVIEW and new requests: same-day review, honest customer calls.
4. Recovery queues: parts, pending estimates, return visits, unpaid balances.
5. Outbox failures: anything FAILED that a customer is waiting on.
6. Weather posture: in flood conditions, windows may run late — call customers before heading out, tell them plainly, and NEVER drive through standing water of unknown depth. Safety outranks every window on the board.

CHECK YOURSELF:
- A customer asks you to "just text me the payment link". Walk the exact steps, name what the log will show, and say what you tell them about the text.
- Name the three Pepper Lists purposes, and which of them can ever put a job on the dispatch board.`,
  },
];

/* --------------------- Record builder (Navigator shape) --------------------- */

function slugify(text) {
  return String(text).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function lessonTranscript(lesson) {
  return [
    `Ads & Bookings Operations — Lesson ${lesson.module - 38} of 12 (Academy Module ${lesson.module}).`,
    lesson.teaches,
    '',
    lesson.body.trim(),
    '',
    'This lesson teaches the live Top Speed Service OS as shipped. Where a step is owner-only, the lesson says so — gates are part of the system, and working them honestly is the job.',
  ].join('\n');
}

export function buildAdsBookingsLessonRecords() {
  return ADS_BOOKINGS_LESSONS.map((lesson) => ({
    slug: `training-module-${lesson.module}-ads-and-bookings-${slugify(lesson.part)}`,
    type: 'ARTICLE',
    division: 'PUBLISHING',
    title: `Module ${lesson.module}: Ads & Bookings Operations — ${lesson.title}`,
    description: `Ads & Bookings Operations, lesson ${lesson.module - 38} of 12. ${lesson.teaches}`,
    assetUrl: null,
    thumbnailUrl: null,
    durationSec: null,
    transcript: lessonTranscript(lesson),
    destinationUrl: lesson.destinationUrl,
    status: 'PUBLISHED',
    publishAt: null,
    publishedAt: '2026-11-18T22:00:00.000Z',
    tags: ['training-academy', 'ads-and-bookings'],
  }));
}
