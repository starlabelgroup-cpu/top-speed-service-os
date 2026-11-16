/**
 * Top Speed Academy — AI Specialists & Strategists (2026-11-16).
 *
 * The roster is structured the way the platform is: DEPARTMENT →
 * CATEGORY → SPECIALIST. Departments mirror the Oversight / Turbo Boss
 * map; every category is derived from a real console, endpoint group,
 * or taxonomy in this codebase (named in each department's `basis`).
 * The Ecosystem Guide sits above the departments as the
 * cross-department explainer.
 *
 * Grounding rule (same as the Speedy knowledge base): every fact below
 * comes from the platform itself — PLATFORM_CONSTANTS, the knowledge
 * packs, the Academy curriculum, and the audited consoles/endpoints.
 * No invented prices, policies, or procedures: where a fact lives in a
 * human-owned record (a provider agreement, a campaign record), the
 * coach says so and points at the record instead of summarizing it.
 *
 * Governance: specialists EXPLAIN and GUIDE only. They hold no tools
 * and perform no operations — see services/academyCoach.js.
 */

export const ECOSYSTEM_GUIDE = {
  id: 'guide',
  kind: 'guide',
  name: 'Atlas',
  title: 'Ecosystem Guide',
  scope: 'The whole Top Speed ecosystem — how every door, app, console, and department fits together.',
  explains:
    'Start here for the big picture: one Service OS backend behind every front door, how a job flows department to department, which console runs what, and where any question belongs. Atlas routes you to the right department specialist when a question gets specific.',
  starters: [
    'Explain the whole ecosystem in one pass',
    'How does a job flow from booking to review?',
    'Which console runs what?',
    'What is the difference between the apps?',
  ],
  keywords: ['ecosystem', 'platform', 'overview', 'whole system', 'front doors', 'how it all fits', 'departments'],
  kbIds: ['gloss-domain-doors', 'gloss-top-speed-group', 'site-services-overview', 'site-business-basics', 'gloss-speedy'],
  answer:
    'The Top Speed ecosystem runs on ONE backend — the Top Speed Service OS. The front doors are topspeedappliance.net (the customer flagship), topspeedapplianceservice.com (the provider-network home and a service-request door), Appliance Connect (customers), Appliance Connect Pro (homeowners + property managers), Appliance Pro (commercial only), and ApplianceReferral. A job booked anywhere is the same job everywhere: Booking → Service Setters dispatch (a human approves every dispatch) → Field Service → Parts Supply → Billing → Referrals & Rewards. Staff run it from the consoles: Book OS and the Dispatch Dashboard for dispatch, the CRM for customers, Finance OS for money, Marketing OS and Ad Studio for growth, Parts Supply OS for parts — with Oversight and Turbo Boss watching and commanding the whole floor.',
};

export const DEPARTMENTS = [
  {
    id: 'dispatch',
    name: 'Bookings & Dispatch',
    basis: 'Book OS + Dispatch Dashboard + Track Console (routes/bookos.js, routes/tracking.js)',
    consoles: [
      { name: 'Book OS', path: '/book-os' },
      { name: 'Dispatch Dashboard', path: '/dispatch-dashboard' },
      { name: 'Track Console', path: '/track-console' },
    ],
    blurb: 'Where every request lands, gets reviewed by a Service Setter, matched to a provider, and tracked through all 8 stages.',
    specialist: {
      name: 'Dana',
      title: 'Dispatch & Service Setters Specialist',
      scope: 'Booking intake, the setter queue, provider assignment, scheduling windows, service areas, and live tracking.',
      explains:
        'How requests arrive from every door into one queue, how Service Setters review and approve dispatch, how matching and assignment work, and how a job moves through the 8 tracking stages.',
      starters: [
        'How does a booking get from request to dispatched?',
        'What does a Service Setter check before approving dispatch?',
        'How does provider matching work?',
      ],
    },
    keywords: ['dispatch', 'booking', 'setter', 'queue', 'assignment', 'tracking', 'schedule', 'window', 'area'],
    kbIds: ['site-booking-how', 'site-tracking-stages', 'gloss-service-setters', 'gloss-smart-booking', 'gloss-track-my-tech'],
    categories: [
      {
        id: 'intake',
        name: 'Intake & Booking Doors',
        blurb: 'Every way a request arrives — one queue behind all of them.',
        explains: 'The booking doors (Speedy chat, the classic web form, phone, bulk requests), what a complete booking contains, and the $99 diagnostic at booking.',
        starters: ['What are the booking doors?', 'What makes a booking complete?', 'How does Speedy chat booking work?'],
        keywords: ['intake', 'booking doors', 'smart booking', 'web form', 'speedy chat booking', 'guest booking'],
        answer:
          'Requests arrive through Speedy chat (which summarizes the details and gets the customer\'s confirmation before anything is sent to the office), the classic Smart Booking web form — the primary booking path, always available and never gated behind chat — the /book form, by phone, and through commercial bulk requests. Every door lands in the SAME Service Setters queue and creates the same booking record with a TS-XXXXXX reference. A residential booking collects the $99 diagnostic at booking, credited in full toward the approved repair. A guest booking also creates the customer\'s record automatically — a record is not an account, and coaches never present it as one.',
      },
      {
        id: 'setter-queue',
        name: 'Setter Queue & Review',
        blurb: 'The human review every request passes before anyone rolls.',
        explains: 'The setter queue in Book OS, what review means, AREA_REVIEW flags, and the dispatch scorecard.',
        starters: ['What is the setter queue?', 'What is AREA_REVIEW?', 'What does the dispatch scorecard show?'],
        keywords: ['setter queue', 'review', 'area_review', 'approve dispatch', 'book os queue', 'scorecard'],
        answer:
          'The setter queue (Book OS → Setter Queue, fed by GET /bookos/setter-queue) is where every new request waits for a human. Dispatch is HYBRID: the platform proposes a provider match by service area, appliance, and standing, and a Service Setter reviews and approves EVERY booking and every dispatch before a technician rolls — nobody is dispatched by AI alone. A booking whose address does not resolve cleanly into the service-area model is flagged AREA_REVIEW; a setter resolves it with the resolve-area action in Book OS. The queue also carries segment badges (residential / commercial / property-manager) so setters see what kind of job each request is. The Dispatch Dashboard shows the same intake with today\'s board, and Turbo Boss surfaces aging queue items in its Needs-a-Decision list.',
      },
      {
        id: 'assignment',
        name: 'Assignment & Matching',
        blurb: 'One qualified provider per job — matched, never sold as a lead.',
        explains: 'How setters assign from the tracking console, what makes a good match, and how unassigned jobs surface in Turbo Boss.',
        starters: ['How do I assign a provider to a job?', 'What makes a good match?', 'Where do unassigned jobs show up?'],
        keywords: ['assign', 'assignment', 'matching', 'provider match', 'unassigned', 'tracking console assign'],
        answer:
          'Assignment happens in the Track Console (POST /tracking/console/:reference/assign): a setter picks the provider for a booking reference, which confirms the job and notifies the provider. A good match is judged on service area, appliance skill, and provider standing — the platform proposes, the human decides (Module 20 teaches the judgment). Top Speed matches ONE provider to a job; the job is never sold to several techs as a lead. Jobs waiting without a provider appear on the Dispatch Dashboard board and in Turbo Boss\'s Needs-a-Decision queue, oldest first, until a setter assigns them.',
      },
      {
        id: 'tracking',
        name: 'Tracking & the 8 Stages',
        blurb: 'One truth about where a job is — for staff and customers alike.',
        explains: 'The 8 job stages, who advances them, tracking links, and the en-route-only GPS rule.',
        starters: ['What are the 8 job stages?', 'Who can advance a stage?', 'When does the customer see the technician\'s location?'],
        keywords: ['tracking', 'stages', 'track my tech', 'gps', 'en route', 'tracking link', 'stage'],
        answer:
          'Every job moves through 8 stages: 1 Request received → 2 Appointment confirmed → 3 Technician assigned → 4 Technician en route → 5 Technician arrived → 6 Diagnosis in progress → 7 Estimate approved → 8 Repair completed. A stage changes only when the work really happened: stages advance from real technician job events in the Tech App, or by a Service Setter in the Track Console. Customers follow at /track with their reference + phone, or through a secure per-job tracking link the team can issue. The technician\'s live location appears ONLY while en route (stage 4) — never before, never generated — and any ETA is the technician\'s own estimate, never one the system invents.',
      },
      {
        id: 'scheduling',
        name: 'Windows, Slots & Reminders',
        blurb: 'Five two-hour windows a day, honest capacity, and reminders that run on time.',
        explains: 'The booking windows, slot capacity in Book OS, rescheduling, and the reminders run.',
        starters: ['What are the booking windows?', 'How do I reschedule an appointment?', 'How do reminders work?'],
        keywords: ['window', 'slot', 'schedule', 'reschedule', 'appointment', 'reminder', 'capacity'],
        answer:
          'Appointments are booked into five two-hour windows: 8–10 AM, 10 AM–12 PM, 12–2 PM, 2–4 PM, and 4–6 PM. Book OS reads live slot capacity (GET /bookos/slots) so setters never promise a window the day cannot hold. Appointments are created and rescheduled from Book OS (POST /bookos/appointments, …/:bookingId/reschedule) — a reschedule keeps the same booking record and reference. The reminders run (POST /bookos/reminders/run) sends the scheduled customer reminders for upcoming appointments. A window is an arrival window, never a promised completion time.',
      },
      {
        id: 'areas',
        name: 'Areas & the Waitlist',
        blurb: 'The 12 core cities, the wider coverage map, and honest answers outside both.',
        explains: 'The area model (in-area, AREA_REVIEW, out-of-area), the area-day view, and the expansion waitlist.',
        starters: ['Which cities auto-match?', 'What happens to an out-of-area request?', 'What is the waitlist?'],
        keywords: ['area', 'cities', 'coverage', 'waitlist', 'out of area', 'expansion', 'area day'],
        answer:
          'The booking matcher auto-matches the 12 core Broward cities: Lauderhill, Plantation, Sunrise, Tamarac, Fort Lauderdale, Lauderdale Lakes, North Lauderdale, Davie, Coral Springs, Pompano Beach, Oakland Park, and Margate. The published landing coverage is wider — 131 landing pages across 65 tri-county cities — but a booking from a city outside the core 12 lands in AREA_REVIEW for a setter to decide, and a clearly out-of-area request is recorded on the expansion waitlist: the customer is told honestly that no visit has been booked and no charge made, and never sent a confirmation with service terms. Book OS has an area-day view (GET /bookos/area-day) so setters see the day by area.',
      },
    ],
  },
  {
    id: 'commercial',
    name: 'Commercial',
    basis: 'Appliance Pro + routes/commercial.js (accounts, facilities, equipment, work orders, bulk requests, billing)',
    consoles: [
      { name: 'Appliance Pro', path: '/appliance-pro' },
      { name: 'Oversight — Commercial tile', path: '/oversight' },
    ],
    blurb: 'Business accounts, facilities, the TS-EQ equipment registry, priority work orders, and one consolidated monthly invoice.',
    specialist: {
      name: 'Marcus',
      title: 'Commercial Specialist',
      scope: 'Commercial accounts, facilities and equipment, work orders, bulk requests, and commercial billing and pricing.',
      explains:
        'How commercial accounts are opened and run: facilities, TS-EQ equipment records, the priority work-order track, bulk requests, consolidated monthly invoicing, and why commercial pricing is always a custom quote.',
      starters: [
        'How does a commercial account start?',
        'What is a TS-EQ equipment record?',
        'How is commercial pricing different from residential?',
      ],
    },
    keywords: ['commercial', 'business account', 'facility', 'equipment', 'work order', 'apc', 'bulk request'],
    kbIds: ['site-commercial-pricing', 'gloss-appliance-pro', 'gloss-appliance-connect-pro'],
    categories: [
      {
        id: 'accounts',
        name: 'Commercial Accounts & Requests',
        blurb: 'How a business becomes a commercial account (APC- references).',
        explains: 'Commercial account requests, the APC- reference, and the business-login rule for commercial access.',
        starters: ['How does a business open a commercial account?', 'What is an APC- reference?', 'Who can access a commercial account?'],
        keywords: ['commercial account', 'apc', 'account request', 'business login', 'open account'],
        answer:
          'A business starts with a commercial account request, which is issued an APC- reference the team works from (the request also surfaces in Turbo Boss\'s decision queue and the CRM). Accounts live in the commercial system (POST /commercial/accounts) and are worked by the team — there is no self-serve commercial activation. Access follows the platform access rules: a commercial account must pass a BUSINESS login before access, and a signed-in consumer session never unlocks commercial doors. Commercial customers work in Appliance Pro; property managers work in Appliance Connect Pro.',
      },
      {
        id: 'equipment',
        name: 'Facilities & the TS-EQ Equipment Registry',
        blurb: 'Every unit on record, tagged, with its full service history.',
        explains: 'Facilities under an account, TS-EQ asset tags and QR codes, and equipment status.',
        starters: ['What is a TS-EQ tag?', 'How is equipment registered?', 'What does the QR code on a unit do?'],
        keywords: ['ts-eq', 'equipment registry', 'facility', 'asset tag', 'qr code', 'unit record'],
        answer:
          'Every commercial account holds one or more facilities, and every unit in a facility gets an equipment-registry record with a TS-EQ asset tag: brand, model, serial, warranty status, and the unit\'s full service history. A QR code on the unit opens its record, so a technician standing in front of the machine sees its history before touching it. Equipment is added per facility (POST /commercial/facilities/:facilityId/equipment) and its status is maintained on the record (PATCH /commercial/equipment/:id/status).',
      },
      {
        id: 'work-orders',
        name: 'Work Orders & the Priority Track',
        blurb: 'Commercial jobs run the priority track through the same setter queue.',
        explains: 'How work orders are created, prioritized, and closed with a photo report.',
        starters: ['How does a commercial work order flow?', 'What makes it priority?', 'How does a work order close?'],
        keywords: ['work order', 'priority', 'commercial job', 'photo report', 'downtime'],
        answer:
          'Commercial work orders (POST /commercial/work-orders) enter the same Service Setters queue as every job but are flagged for priority review — downtime costs a business money, and the queue treats it that way. A setter still reviews and approves dispatch; priority changes the order of attention, not the human gate. The assigned provider works the job in the Tech App like any other, and the work order closes with a photo report (what failed, what was done, what to watch) filed to the account\'s record.',
      },
      {
        id: 'bulk',
        name: 'Bulk Service Requests',
        blurb: 'Many units, one submission — setters sort and schedule.',
        explains: 'Bulk requests for multi-unit properties and how the list becomes individual work orders.',
        starters: ['How do bulk requests work?', 'Who can submit a bulk request?', 'What happens after a bulk submission?'],
        keywords: ['bulk', 'multi-unit', 'bulk request', 'many units', 'property manager bulk'],
        answer:
          'Businesses and property managers can submit a bulk service request — one submission covering many units (POST /commercial/bulk-requests). The list lands with the Service Setters, who review it and turn it into scheduled work orders unit by unit; nothing in a bulk list dispatches itself. It is the same door property managers use in Appliance Connect Pro for multi-unit requests across a portfolio.',
      },
      {
        id: 'billing',
        name: 'Consolidated Monthly Invoicing',
        blurb: 'One itemized monthly invoice instead of per-visit paperwork.',
        explains: 'How commercial billing rolls up per account, and where the billing summary lives.',
        starters: ['How does commercial billing work?', 'Where do I see an account\'s billing summary?', 'Is commercial billed per visit?'],
        keywords: ['consolidated invoice', 'monthly invoice', 'billing summary', 'commercial billing', 'itemized'],
        answer:
          'Commercial accounts are billed on ONE consolidated monthly invoice, itemized by unit — not a pile of per-visit paperwork. Each account\'s billing position is readable from its billing summary (GET /commercial/accounts/:id/billing-summary), and the money side is reconciled in Finance OS, where QuickBooks stays the book of record. Per-visit payment collection is the residential pattern; it does not apply to commercial accounts on consolidated billing.',
      },
      {
        id: 'pricing',
        name: 'Commercial Pricing & Service Agreements',
        blurb: 'Custom quotes only — the $99 diagnostic never applies commercially.',
        explains: 'Why commercial work is quoted per facility, and the three service-agreement tiers.',
        starters: ['How is commercial work priced?', 'What are the service agreement tiers?', 'Does the $99 diagnostic apply to businesses?'],
        keywords: ['commercial pricing', 'custom quote', 'service agreement', 'essential', 'priority tier', 'total care'],
        answer:
          'Commercial pricing is a CUSTOM QUOTE per facility — the residential $99 diagnostic model never applies commercially, and no coach or assistant may quote a commercial figure. Service agreements come in three tiers — Essential, Priority, and Total Care — sized by equipment count, locations, and hours, and priced by quote. No guaranteed response-time clocks are published, so never promise one. Commercial scope is commercial refrigeration (walk-ins, reach-ins, ice machines), commercial laundry, cooking lines, and dish/sanitation machines; building HVAC, plumbing mains, and electrical panels belong to the licensed trades for those systems.',
      },
    ],
  },
  {
    id: 'providers',
    name: 'Providers & Field Ops',
    basis: 'Speedy Pro / Tech App + routes/provider.js (assignments, workspace, checklist, notes, plate-read, parts-finder, parts-orders)',
    consoles: [
      { name: 'Speedy Pro (Tech App)', path: '/tech' },
      { name: 'Speedy Pro hub', path: '/speedy-pro' },
    ],
    blurb: 'The provider network and the field day: offers, the Field Pro workspace, status and GPS, Appliance Plug, and completion reports.',
    specialist: {
      name: 'Felix',
      title: 'Field Ops Specialist',
      scope: 'Provider onboarding, offers and assignments, the Field Pro workspace, job status and GPS, Appliance Plug, and AI notes.',
      explains:
        'How providers join the network and get work, how the Field Pro workspace runs a job on site, how status and location sharing behave, and how Appliance Plug turns a model plate into a parts order.',
      starters: [
        'How does a provider get work?',
        'What is inside the Field Pro workspace?',
        'How does Appliance Plug find parts without a part number?',
      ],
    },
    keywords: ['provider', 'technician', 'tech app', 'field pro', 'assignment', 'offer', 'appliance plug', 'plate read'],
    kbIds: ['gloss-speedy-pro', 'gloss-field-pro', 'gloss-appliance-plug', 'gloss-photo-diagnosis', 'gloss-track-my-tech'],
    categories: [
      {
        id: 'onboarding',
        name: 'Provider Network & Onboarding',
        blurb: 'Three kinds of hands, one verification standard.',
        explains: 'The Field Team, network businesses, and independents — and how a new provider business joins.',
        starters: ['Who provides the service in the network?', 'How does a new provider business join?', 'Are providers verified?'],
        keywords: ['onboarding', 'provider network', 'field team', 'network business', 'independent provider', 'verification', 'who provides', 'provides the service', 'who does the work', 'service providers', 'who provides the service'],
        answer:
          'The network has three kinds of hands: the Top Speed Field Team (in-house technicians), network businesses, and independent service providers — all dispatched through the one Service Setters team. Providers are verified by the team before they receive work, and nobody\'s credentials can be overridden by AI or by request — that is a hard governance line. A brand-new provider BUSINESS is onboarded in Service Network admin first; once the company exists, its Tech App logins are created inside it (the owner does this from Turbo Boss\'s Accounts panel). A provider\'s payout terms live in their own provider agreement — coaches never state or summarize them.',
      },
      {
        id: 'offers',
        name: 'Offers & Accepting Jobs',
        blurb: 'Real matched jobs, and what accepting one commits a tech to.',
        explains: 'How offers arrive in the Tech App, accept/decline, and the three checks before accepting.',
        starters: ['How do offers arrive?', 'What does accepting a job commit me to?', 'Can a tech decline an offer?'],
        keywords: ['offer', 'accept', 'decline', 'assignment', 'tech app offers'],
        answer:
          'Offers land in the Tech App (GET /provider/assignments) only after a Service Setter has approved the dispatch — an offer is a real, matched job with the customer\'s photo, issue, and triage notes attached, never a lead sold to five techs. The tech accepts or declines in the app (POST …/accept, …/decline). Accepting commits the tech to the job: Module 12 teaches the three checks before accepting — the area and window, the appliance and issue, and their own readiness to run it. Declining is honest and allowed; silently sitting on an offer is what hurts the customer.',
      },
      {
        id: 'workspace',
        name: 'The Field Pro Workspace',
        blurb: 'One workspace per job: details, checklist, notes, quote facts, parts, report.',
        explains: 'The six workspace tabs and what is server-persisted versus read-only.',
        starters: ['What are the Field Pro workspace tabs?', 'Is the checklist saved?', 'What is in the job report?'],
        keywords: ['field pro', 'workspace', 'checklist', 'job report', 'quote facts', 'tabs'],
        answer:
          'Each assignment opens a Field Pro workspace (GET /provider/assignments/:id/workspace) headed by the real booking: customer, appliance, issue, and the call / text / navigate actions. It has six tabs — Details, Checklist (server-persisted, so it survives the app closing), Notes (the tech\'s real job notes, saved to the record), Quote (read-only facts from the approved estimate — the workspace never invents numbers), Parts (Appliance Plug, below), and Report (a downloadable HTML report of the job). Ask Speedy inside the workspace pre-fills a question but never auto-sends — the tech reviews and sends it themselves.',
      },
      {
        id: 'status-gps',
        name: 'Job Status & Live Location',
        blurb: 'Status updates are promises; GPS is shared only en route.',
        explains: 'How techs advance job status, the en-route location rule, and running late the right way.',
        starters: ['How does a tech update job status?', 'When is location shared?', 'What if a tech is running late?'],
        keywords: ['job status', 'gps', 'location', 'en route', 'running late', 'status update'],
        answer:
          'Techs advance the job from the Tech App (POST …/job-status): en route, arrived, diagnosis, completion — each update is a promise the customer can see, so it is made when the thing actually happens (Module 13). Live location is shared ONLY while the tech is en route: the provider controls the share toggle, and the customer\'s map pin exists only during that leg. Running late is handled honestly — update the status, let the customer know through the job thread, and never let the app show an ETA the tech did not set.',
      },
      {
        id: 'plug',
        name: 'Appliance Plug — Plate Read & Parts Finder',
        blurb: 'Snap the model plate, find the part category, order against the job.',
        explains: 'How plate-read works, why the parts finder is category-only, and how Plug orders bind to a booking.',
        starters: ['How does plate read work?', 'Why no part numbers in the finder?', 'How do Plug parts orders work?'],
        keywords: ['appliance plug', 'plate read', 'parts finder', 'model plate', 'parts order', 'category'],
        answer:
          'Appliance Plug lives inside the Field Pro workspace. Plate read (POST …/plate-read) reads the appliance\'s model plate from a photo so the job record carries the right model. The parts finder (POST …/parts-finder) works by CATEGORY only — by design it has no part-number or price fields: the exact part number and price are confirmed by Parts Supply OS at order time, never guessed in the field. A parts order placed from the workspace is bound to the booking (reference <bookingRef>-P<n>) and its status advances only on a real tap by the tech or the parts team.',
      },
      {
        id: 'ai-notes',
        name: 'AI Notes & Photo Diagnosis in the Field',
        blurb: 'AI drafts, the technician decides and signs.',
        explains: 'The AI note preview/sign-off flow and photo diagnosis as a head start, not a verdict.',
        starters: ['How do AI job notes work?', 'Does photo diagnosis decide the repair?', 'Who owns the safety call on site?'],
        keywords: ['ai note', 'photo diagnosis', 'sign off', 'field diagnosis', 'technician notes'],
        answer:
          'AI notes are drafted from the job and the tech\'s input, previewed (POST …/ai-note/preview), edited, and only then saved under the technician\'s name (POST …/ai-note) — the signature is the tech\'s, so the note says what the tech stands behind (Module 14). Photo diagnosis works the same way: a head start that pre-loads likely causes and parts thinking, never a verdict — the on-site diagnostic confirms the cause. The safety line belongs to the human technician in the field; no AI certifies a repair safe, ever.',
      },
    ],
  },
  {
    id: 'crm',
    name: 'Customers & CRM',
    basis: 'Top Speed CRM + routes/crm.js + routes/chats.js + the customer apps (Connect / Connect Pro)',
    consoles: [
      { name: 'Top Speed CRM', path: '/crm' },
      { name: 'Chat Insights', path: '/chats' },
      { name: 'Appliance Connect', path: '/app' },
    ],
    blurb: 'One customer record behind every door: the 360 view, conversations, Speedy briefs and drafts, accounts, and the Garage registry.',
    specialist: {
      name: 'Cora',
      title: 'CRM & Customers Specialist',
      scope: 'Customer records, conversations and the inbox, Speedy briefs and drafts, customer accounts and doors, My Garage, and Chat Insights.',
      explains:
        'How the single customer record is built from every door, how conversations land on it, how Speedy assists the team inside the CRM without ever sending on its own, and how customer accounts differ from records.',
      starters: [
        'What is on a customer\'s 360 record?',
        'How do emails become CRM conversations?',
        'What is the difference between a customer record and an account?',
      ],
    },
    keywords: ['crm', 'customer', 'record', '360', 'conversation', 'inbox', 'account', 'garage', 'chat insights'],
    kbIds: ['gloss-appliance-connect', 'gloss-appliance-connect-pro', 'gloss-my-garage', 'gloss-service-setters'],
    categories: [
      {
        id: 'records',
        name: 'Customer Records & the 360',
        blurb: 'One record per customer, fed by every door.',
        explains: 'What the CRM home and customer 360 show, and how records are created.',
        starters: ['What does the customer 360 show?', 'How is a customer record created?', 'Can I add a note to a record?'],
        keywords: ['customer record', '360', 'crm home', 'customer notes', 'record created'],
        answer:
          'The CRM (GET /crm/home, /crm/customers/:id) holds ONE record per customer, built from everything that customer has done at any door — bookings, conversations, diagnoses, referrals. A record is created automatically when a guest books; it is the team\'s working file, not the customer\'s account. Staff add notes to the record (POST /crm/customers/:id/notes) so the next person who talks to the customer starts informed. Because it is one record, a customer never has to repeat themselves between the .net site, the apps, and the phone.',
      },
      {
        id: 'conversations',
        name: 'Conversations & the Inbox',
        blurb: 'Email and messages become conversations on the customer\'s record.',
        explains: 'How service@ mail flows into the CRM, the Book OS Inbox queue, and the human-sends rule for replies.',
        starters: ['How does email reach the CRM?', 'Where do setters read customer messages?', 'Who sends replies?'],
        keywords: ['conversation', 'inbox', 'email', 'service@', 'reply', 'book os inbox'],
        answer:
          'Customer email is designed to become a conversation on the customer\'s CRM record: service@ mail flows into the Service OS, each message threads onto the customer\'s record, and Service Setters work the queue from the Inbox in Book OS. Replies go out as service@ through Resend. The rule that never bends: a HUMAN always clicks send — Speedy and the CRM can draft, but no reply leaves without a person sending it. Gmail itself keeps working untouched alongside this.',
      },
      {
        id: 'speedy-assist',
        name: 'Speedy Briefs, Drafts & Matching',
        blurb: 'AI prepares; the human reviews, decides, and sends.',
        explains: 'The CRM\'s Speedy brief, Speedy draft, and booking match helpers — and their limits.',
        starters: ['What is a Speedy brief?', 'How do Speedy drafts work?', 'What is speedy-match?'],
        keywords: ['speedy brief', 'speedy draft', 'speedy-match', 'crm ai', 'draft reply'],
        answer:
          'Inside a customer record, Speedy assist offers three helpers: the Speedy brief (GET /crm/customers/:id/speedy-brief — a short summary of where things stand with this customer), the Speedy draft (POST /crm/customers/:id/speedy-draft — a drafted reply a human reviews, edits, and sends themselves), and booking match (GET /crm/bookings/:id/speedy-match — provider-match assistance for a booking). All three are assistive only: briefs inform, drafts wait for a human send, and matching still ends in a setter\'s decision. Module 19 teaches the workflow and the speed-to-lead habit.',
      },
      {
        id: 'accounts-doors',
        name: 'Customer Accounts & the Front Doors',
        blurb: 'Records are automatic; accounts are chosen — and each door has its lane.',
        explains: 'Signup account types, the Connect / Connect Pro / Appliance Pro lanes, and the legal signing gate.',
        starters: ['How does a customer create an account?', 'Which app is for property managers?', 'What must a new account sign?'],
        keywords: ['account', 'sign up', 'account type', 'connect pro', 'front door', 'legal terms', 'signing gate'],
        answer:
          'Anyone creates a free account at /signup and picks their type — Homeowner, Business, or Property Manager — and the type routes them to the right app: homeowners and property managers use Appliance Connect Pro, businesses use Appliance Pro (commercial only), and customers also have Appliance Connect for their registry, history, and booking. Portal lanes are enforced: a commercial account must pass a business login, and new Connect Pro customers create their account on the web portal first — the app is sign-in-only for existing accounts. Before account access, every account reviews and signs the legal terms (the Terms & Conditions and the Appliance Connect Software Terms of Use at /legal); a version change means signing the new version before continuing.',
      },
      {
        id: 'garage',
        name: 'My Garage — the Appliance Registry',
        blurb: 'The customer\'s appliances, history, and maintenance in one place.',
        explains: 'What My Garage holds and how it feeds bookings and maintenance scheduling.',
        starters: ['What is My Garage?', 'How does the registry help a booking?', 'How are maintenance checkups scheduled?'],
        keywords: ['garage', 'appliance registry', 'my appliances', 'maintenance', 'registry'],
        answer:
          'My Garage is the customer\'s appliance registry inside Appliance Connect: their appliances on record, with service history attached to each. It makes the next booking faster — the team already knows the appliance — and maintenance plans schedule seasonal checkups from the registry so nothing lapses. Garage data sits behind the customer\'s sign-in; signed-out visitors get a sign-in prompt, never a sample registry.',
      },
      {
        id: 'chat-insights',
        name: 'Chat Insights',
        blurb: 'Every Speedy conversation is data the team learns from.',
        explains: 'Chat capture, sessions and sources, unanswered questions, and the weekly insights habit.',
        starters: ['What is Chat Insights?', 'How do we find unanswered questions?', 'Are chats recorded?'],
        keywords: ['chat insights', 'chat capture', 'sessions', 'unanswered', 'conversation data'],
        answer:
          'Every Speedy conversation — website chat, Speedy Class, the apps — is captured with its session and source surface (GET /chats/sessions, /chats/insights) so the team can see what customers actually ask. Chat Insights surfaces the patterns: the questions Speedy could not ground an answer for are the team\'s reading list, because each one is either a knowledge gap to close or a page to fix. When a chat turns into a booking, the session is marked converted. Module 10 teaches the weekly insights habit: read the unanswered questions, close one gap, repeat.',
      },
    ],
  },
  {
    id: 'finance',
    name: 'Finance',
    basis: 'Finance OS + routes/finance.js (status, sync, overview) + routes/payments.js (Stripe)',
    consoles: [{ name: 'Finance OS', path: '/finance' }],
    blurb: 'The money layer: QuickBooks as the book of record, the mirrored P&L and receivables, card payments, and the money gates.',
    specialist: {
      name: 'Fiona',
      title: 'Finance Strategist',
      scope: 'Finance OS overview, QuickBooks sync, invoices and card payments, payouts, refunds, and money gates.',
      explains:
        'How money moves through the platform: what Finance OS mirrors from QuickBooks, how the sync earns trust, how the $99 diagnostic and card payments work, and which money actions are human-only.',
      starters: [
        'What does Finance OS show?',
        'Is QuickBooks or the Service OS the book of record?',
        'Who can issue a refund?',
      ],
    },
    keywords: ['finance', 'quickbooks', 'invoice', 'payment', 'payout', 'refund', 'p&l', 'sync', 'money'],
    kbIds: ['site-pricing-diagnostic', 'site-pricing-labor', 'site-terms', 'site-warranty'],
    categories: [
      {
        id: 'overview',
        name: 'Finance Overview — P&L, Receivables, Payables',
        blurb: 'The mirrored money picture, honest about its source.',
        explains: 'What the Finance OS overview contains and what "not connected" honestly means.',
        starters: ['What is in the finance overview?', 'What does QuickBooks not_connected mean?', 'Where do invoices show?'],
        keywords: ['finance overview', 'profit and loss', 'receivables', 'payables', 'invoices', 'not connected'],
        answer:
          'Finance OS (GET /finance/overview) mirrors the money picture from QuickBooks: profit & loss, accounts receivable, accounts payable, and invoices, so managers can read the business without opening the accounting file. The mirror is only as real as its connection: when QuickBooks is not connected, Finance OS and Turbo Boss say exactly that — "not connected" — and show no invented totals. Connecting and the first sync are owner moves (see the QuickBooks Sync category).',
      },
      {
        id: 'quickbooks',
        name: 'QuickBooks Sync',
        blurb: 'QuickBooks is the book of record; the Service OS mirrors it.',
        explains: 'The direction of truth, how a sync runs, and who may run the first one.',
        starters: ['Which system is the book of record?', 'How does the sync work?', 'Who runs the first sync?'],
        keywords: ['quickbooks', 'sync', 'book of record', 'finance status', 'mirror'],
        answer:
          'QuickBooks stays the book of record — the Service OS never replaces it; Finance OS mirrors its reports for the staff (Module 5). The connection state is visible at GET /finance/status, and a sync (POST /finance/sync) refreshes the mirror. The first sync is an owner-gated move (the owner\'s QuickBooks token), because it binds the company\'s real accounting file to the platform. After that, the habit is simple: if a number in Finance OS ever disagrees with QuickBooks, QuickBooks wins and the sync is re-run.',
      },
      {
        id: 'payments',
        name: 'Invoices & Card Payments',
        blurb: 'The $99 at booking, payment on completion, Stripe for cards.',
        explains: 'How customer payments are collected, the standing payment terms, and Stripe\'s honest configured state.',
        starters: ['How is the $99 diagnostic collected?', 'When is payment due?', 'How do card payments work?'],
        keywords: ['payment', 'stripe', 'card', 'diagnostic fee', 'payment due', 'invoice payment'],
        answer:
          'The standing terms: the $99 residential diagnostic is collected at booking and credited toward the approved repair; repair labor is a flat $210 and installation a flat $150, parts and materials separate; no work happens without an approved written quote; and payment is due on completion unless agreed in writing. Card payments run through Stripe — the payment status endpoint reports honestly whether Stripe is configured, and nobody on the team claims a card payment worked that did not. Commercial accounts do not pay per visit; they are custom-quoted onto the consolidated monthly invoice.',
      },
      {
        id: 'payouts-gates',
        name: 'Payouts, Refunds & Money Gates',
        blurb: 'The money actions that stay human — by design.',
        explains: 'Provider payout terms, the refund rule, referral credits versus cash, and owner-only money configuration.',
        starters: ['How are providers paid?', 'Who decides a refund?', 'Are referral credits cash?'],
        keywords: ['payout', 'refund', 'money gate', 'referral credit cash', 'owner only', 'providers paid', 'how are providers paid', 'payout terms', 'provider pay', 'get paid'],
        answer:
          'Three money gates never move: (1) Provider payout terms live in each provider\'s own agreement — they are never stated, summarized, or negotiated by AI or from memory. (2) Refunds are decided by a human (or a configured approval) — Speedy can only record a refund REQUEST for the team; no AI issues, approves, or promises a refund. (3) Referral credits are service credits toward future work — not cash, never paid out. Money configuration itself (Stripe live keys, banking) is owner-only, and Finance OS shows the configured state honestly rather than pretending a rail is live.',
      },
    ],
  },
  {
    id: 'marketing',
    name: 'Marketing & Publishing / Flywheel',
    basis: 'Marketing OS (routes/marketingOs.js + taxonomy) + Ad Studio (routes/adStudio.js) + Flywheel (routes/flywheel.js) + Media OS',
    consoles: [
      { name: 'Marketing OS', path: '/marketing-os' },
      { name: 'Ad Studio', path: '/ad-studio' },
      { name: 'Advertiser Console', path: '/advertiser' },
      { name: 'Publish Center', path: '/publish-center' },
    ],
    blurb: 'The growth engine: the Marketing OS taxonomy and Page Studio, SEO, Ad Studio, Flywheel advertiser accounts, listings, and reviews.',
    specialist: {
      name: 'Milo',
      title: 'Marketing OS & Flywheel Strategist',
      scope: 'The Marketing OS taxonomy and publishing, SEO and Google, Ad Studio campaigns, Flywheel advertiser accounts, listings, and reviews.',
      explains:
        'How the platform publishes and promotes itself honestly: the taxonomy behind the landing pages, the draft-to-publish discipline, how Ad Studio and Flywheel advertising run campaigns with the owner\'s approval, and the real-reviews-only rule.',
      starters: [
        'How does Marketing OS publishing work?',
        'What is the Flywheel advertiser system?',
        'Can we publish a page for any city?',
      ],
    },
    keywords: ['marketing', 'seo', 'taxonomy', 'landing page', 'ad studio', 'flywheel', 'advertiser', 'campaign', 'listings', 'reviews'],
    kbIds: ['gloss-top-speed-group', 'site-offers-overview', 'site-coverage'],
    categories: [
      {
        id: 'taxonomy',
        name: 'Marketing OS Taxonomy',
        blurb: '15 cities, 14 brands, 11 services, 7 symptoms — one canonical vocabulary.',
        explains: 'The four taxonomy kinds, the expansion-city rule, and how pages are composed from them.',
        starters: ['What is the Marketing OS taxonomy?', 'Which cities can pages target?', 'Why is cooktop not its own service?'],
        keywords: ['taxonomy', 'cities', 'brands', 'services', 'symptoms', 'expansion city', 'canonical'],
        answer:
          'Every marketing page is composed from one canonical taxonomy (GET /marketing-os/taxonomy): 15 cities, 14 brands, 11 services, and 7 symptoms. The cities split honestly — the 12 Broward service cities are service-covered, while Hollywood, Deerfield Beach, and Coconut Creek are EXPANSION records only: they exist for planning, and no page may publish for them. The services are the platform\'s canonical lines (the 9 residential/commercial services plus Commercial Appliance Repair; Cooktop is scoped inside Oven/Range rather than standing alone). Symptoms are the customer\'s words — not cooling, not draining, not heating, leaking, error codes, unusual noises, no ice. Taxonomy edits are admin work in Marketing OS; the taxonomy is the single vocabulary every page, ad, and Speedy answer shares.',
      },
      {
        id: 'publishing',
        name: 'Page Studio & Publishing',
        blurb: 'Draft → review → publish → verify — and the platform republishes itself.',
        explains: 'The Page Studio flow, publish status discipline, the publish feed, and auto-publish on Service OS changes.',
        starters: ['How does a page get published?', 'What is the publish feed?', 'What happens when a service changes in the Service OS?'],
        keywords: ['page studio', 'publish', 'published', 'get published', 'page published', 'draft', 'review', 'publish feed', 'indexnow', 'landing pages'],
        answer:
          'Pages are built in the Page Studio (Marketing OS) and move draft → review → publish → verify: nothing reaches the public without human review, and a direct draft-to-published jump is refused. The published library stands at 131 landing pages across 65 tri-county cities — say it exactly that way ("131 landing pages", "65 cities", never "131 cities"). Publishing is wired into the platform: when business data changes in the Service OS (services, cities, pages, offers), a publish event fires to the publish feed, IndexNow, and webhooks so surfaces and search engines stay current — business data only; customer records are never published. The Publish Center and GET /marketing-os/publish-events show the flow.',
      },
      {
        id: 'seo-google',
        name: 'SEO & the Google Empire',
        blurb: 'Search Console + GA4 in one dashboard, accounts in one registry.',
        explains: 'The SEO dashboard, the Google Accounts Registry, and the paused-until-launch posture for Google Ads.',
        starters: ['What does the SEO dashboard show?', 'Where are Google accounts registered?', 'Are the Google Ads campaigns running?'],
        keywords: ['seo', 'google', 'search console', 'ga4', 'google ads', 'accounts registry', 'dashboard'],
        answer:
          'The SEO dashboard (Marketing OS → SEO) reads real Search Console and GA4 data for the platform\'s properties — it shows what Google actually reports, nothing estimated. Every Google account the business uses is registered in the Google Accounts Registry (Module 6) and added the safe way, under the owner\'s control. Google Ads posture is launch-gated by the owner: campaigns are built and kept PAUSED at $0 until the owner funds and launches them per campaign — an ad specialist never launches spend on their own call (Module 24).',
      },
      {
        id: 'ad-studio',
        name: 'Ad Studio Campaigns',
        blurb: 'The in-house ad system: create, submit, owner approves, then it runs.',
        explains: 'The Ad Studio campaign lifecycle and where approved campaigns display.',
        starters: ['How does an Ad Studio campaign go live?', 'Who approves campaigns?', 'Where do approved ads show?'],
        keywords: ['ad studio', 'campaign', 'approve', 'submit', 'in-house ads', 'banner'],
        answer:
          'Ad Studio is the in-house campaign desk (routes/adStudio.js): a campaign is created, submitted, and only the OWNER approves it (POST /ad-studio/campaigns/:id/approve) — approval is an owner-tier action, and pending campaigns surface in Turbo Boss\'s Needs-a-Decision queue so nothing waits invisibly. Approved, ACTIVE campaigns are what the Flywheel mini banner displays across the platforms, and Ad Studio\'s results view counts what a running campaign actually produced. Campaigns can be paused, resumed, or ended from the same desk. Claims discipline applies to every ad: only approved claims ever run (Module 23).',
      },
      {
        id: 'flywheel-advertisers',
        name: 'Flywheel Advertiser Accounts',
        blurb: 'Businesses advertise their related products and services on the platforms.',
        explains: 'Advertiser accounts, self-serve campaign management in the Advertiser Console, and the owner-approval gate before anything displays.',
        starters: ['How does a business advertise with us?', 'What can an advertiser manage themselves?', 'Can an advertiser turn their own ad on?'],
        keywords: ['flywheel', 'advertiser', 'advertiser account', 'advertiser console', 'business ads', 'mini banner', 'advertise', 'advertising', 'advertise with us', 'business advertise', 'run ads'],
        answer:
          'Flywheel Advertising opens the platforms to businesses: a business creates an advertiser account and manages its own campaigns in the Advertiser Console — its products and services, copy, link, and category — and submits them for approval. New business accounts start under Speedy Verify like every business account, and NO advertiser can switch their own ad on: the owner approves each campaign in Ad Studio first. Once a campaign is ACTIVE, the Flywheel mini banner shows it across the customer-facing platforms, preferring ads related to what the page is about. Advertiser accounts are self-serve marketing roles (ADVERTISER, MARKETING_MANAGER, DEVELOPER): they reach their own console and campaigns only — never staff operations, bookings, or anyone else\'s account.',
      },
      {
        id: 'listings-reviews',
        name: 'Local OS, Listings & Reviews',
        blurb: 'One business identity everywhere — and real reviews only.',
        explains: 'The listings display name rule, Local OS, and the reviews engine\'s honesty rule.',
        starters: ['What name goes on listings?', 'How do reviews work?', 'Can we use a rating in our ads?'],
        keywords: ['listings', 'local os', 'reviews', 'google business profile', 'display name', 'ratings'],
        answer:
          'Local OS keeps ONE business identity on every listing: the display name is "Top Speed Appliance Network" (legal name Top Speed Appliance LLC) — and a verification already in progress under that name is never changed mid-flight. The reviews engine asks at the happiest moment — after a completed job — and works only with REAL reviews: no invented ratings, counts, or testimonials anywhere, ever. A fabricated "4.8 from 2,500 reviews" claim was swept from every surface in the 2026-11-14 audit for exactly this reason; if a number is not verified, it does not get published, in a listing, an ad, or an answer.',
      },
    ],
  },
  {
    id: 'referrals',
    name: 'Referrals',
    basis: 'ApplianceReferral + routes/referrals.js (me, invite, leaderboard, admin queue/funnel, journeys, credits, settings)',
    consoles: [
      { name: 'Refer & Earn', path: '/refer' },
      { name: 'Turbo Boss — Referrals', path: '/turbo-boss' },
    ],
    blurb: 'The referral program: automatic codes, the journey, human-approved credits, and the leaderboard.',
    specialist: {
      name: 'Rhea',
      title: 'Referrals & Growth Strategist',
      scope: 'Referral program terms, codes and links, invites, approvals and credits, the leaderboard, and the partner track.',
      explains:
        'How ApplianceReferral works end to end — the published economics, how codes and invites flow, why a Service Setter approves every credit, and how businesses and property managers take part on the same terms.',
      starters: [
        'How much does a referrer earn?',
        'How does a referral journey work?',
        'Who approves a referral credit?',
      ],
    },
    keywords: ['referral', 'refer', 'credit', 'ts-ref', 'invite', 'leaderboard', 'milestone'],
    kbIds: ['gloss-refer-earn', 'site-offers-overview'],
    categories: [
      {
        id: 'terms',
        name: 'Program Terms & Economics',
        blurb: 'The owner-approved numbers, stated exactly.',
        explains: 'The credit tiers, milestones, expiry, and the difference from the friend\'s welcome offer.',
        starters: ['What are the referral rewards?', 'Do credits expire?', 'Is the referrer\'s $25 the same as the friend\'s $25 off?'],
        keywords: ['referral terms', 'economics', 'tiers', 'milestone', 'expiry', 'credit amount'],
        answer:
          'The approved program terms (owner-approved 2026-11-12): the referrer earns a $25 service credit per completed referral, $35 each from the 5th through the 9th, and $50 each from the 10th on — plus one-time milestone bonuses of $100 at 10 and $250 at 25 lifetime completed referrals. Credits expire 12 months after issuance. Keep the two $25s distinct: the REFERRED FRIEND gets $25 OFF a first eligible repair (the published New Customer Welcome); the REFERRER earns a $25 service CREDIT per completed referral. The per-referrer monthly cap is deliberately unset — it stays unset until the owner picks a number, so never state one.',
      },
      {
        id: 'codes-journey',
        name: 'Codes, Links & the Journey',
        blurb: 'TS-REF codes, personal links, and the seven journey stages.',
        explains: 'How a customer gets a code, how the link works, and what each journey stage means.',
        starters: ['How does a customer get a referral code?', 'What are the journey stages?', 'How does the referral link work?'],
        keywords: ['referral code', 'ts-ref', 'referral link', 'journey', 'stages', 'funnel'],
        answer:
          'When a job completes, the customer automatically receives their personal referral code (TS-REF-XXXX) and link — https://topspeedserviceos.com/refer?c=<code> — visible on their Refer & Earn screen in Appliance Connect. The journey runs: invited → clicked → booked → completed → pending approval → credit issued → redeemed. A code captured on any front door (including topspeedappliance.net) attaches to the booking the same way, and every stage shows in the same dashboard. The admin funnel (GET /referrals/admin/funnel) counts the program stage by stage.',
      },
      {
        id: 'invites',
        name: 'Invites & Consent',
        blurb: 'An invite is sent only after a read-back and an explicit yes.',
        explains: 'How Speedy sends invites under the consent rule, self-referral rejection, and one reward per household.',
        starters: ['How does Speedy send a referral invite?', 'Can a customer refer themselves?', 'What stops duplicate rewards?'],
        keywords: ['invite', 'consent', 'self-referral', 'household', 'send invite'],
        answer:
          'Speedy can send a referral invite for a customer (POST /referrals/invite under the hood), but consent is enforced IN CODE, not just in the prompt: Speedy must collect the friend\'s name and a phone or email, read back exactly what will be sent and where, ask "Should I send it?", and only send after an explicit yes. Fraud basics are structural: a customer cannot refer themselves (an invite or booking carrying the referrer\'s own phone or email is rejected), and there is one reward per referred household — extra bookings from the same household still count as referrals but never open a second reward.',
      },
      {
        id: 'approvals',
        name: 'Approvals, Credits & Redemption',
        blurb: 'A Service Setter approves every credit before it exists.',
        explains: 'The admin approval queue, journey approve/reject, credit redemption, and automatic expiry.',
        starters: ['Who approves referral credits?', 'How is a credit redeemed?', 'What happens when a credit expires?'],
        keywords: ['approve', 'credit approval', 'redeem', 'admin queue', 'journey approve', 'expiry'],
        answer:
          'No credit issues itself: when a referred job is completed and paid, the journey waits at pending approval until a Service Setter approves it in the admin queue (GET /referrals/admin/queue; POST …/journeys/:id/approve or …/reject) — pending approvals also surface in Turbo Boss\'s decision queue. Issued credits apply to future service only; staff redeem them against a later job (POST /referrals/admin/credits/:id/redeem). Expiry is automatic: the customer is reminded before a credit lapses, and at 12 months it moves to expired on its own — the dashboard always shows the true state.',
      },
      {
        id: 'leaderboard',
        name: 'Leaderboard & the Partner Track',
        blurb: 'Public celebration, private details — and one rate for everyone.',
        explains: 'What the leaderboard shows, and how businesses and property managers refer on the same terms.',
        starters: ['What does the leaderboard show?', 'Do businesses get a different referral rate?', 'Where does a property manager see their referrals?'],
        keywords: ['leaderboard', 'partner track', 'business referrals', 'property manager referrals'],
        answer:
          'Top referrers are celebrated on the /refer leaderboard (GET /referrals/leaderboard) — first name and last initial only, ranked by completed referrals, counts only: never amounts or anyone\'s private details. The partner track runs on the SAME approved terms as everyone else — same amounts, same Service Setter approval, no separate partner pay rate, and nobody may invent one. A business sees its code and stats in Appliance Pro; a property manager sees theirs in Appliance Connect Pro.',
      },
    ],
  },
  {
    id: 'parts',
    name: 'Parts Supply',
    basis: 'Parts Supply OS + routes/parts.js (parts, suppliers, purchase-orders, usage, low-stock, summary)',
    consoles: [{ name: 'Parts Supply OS', path: '/parts' }],
    blurb: 'The parts warehouse: catalog and stock, suppliers, purchase orders, per-job usage, and low-stock signals.',
    specialist: {
      name: 'Pablo',
      title: 'Parts Supply Specialist',
      scope: 'The parts catalog and stock, suppliers and vendor partners, purchase orders, job parts usage, and low-stock reordering.',
      explains:
        'How parts move from supplier to shelf to job: how the catalog and stock are kept, how purchase orders are received, how every part used lands on the job record, and where exact part numbers and prices are confirmed.',
      starters: [
        'How does Parts Supply OS work?',
        'Where are exact part numbers and prices confirmed?',
        'How are parts recorded on a job?',
      ],
    },
    keywords: ['parts', 'catalog', 'stock', 'supplier', 'vendor', 'purchase order', 'low stock'],
    kbIds: ['gloss-parts-supply-os'],
    categories: [
      {
        id: 'catalog',
        name: 'Catalog & Stock',
        blurb: 'What is on the shelf, and how the count stays true.',
        explains: 'The parts catalog, stock adjustments, and the parts summary.',
        starters: ['How is the parts catalog organized?', 'How is stock adjusted?', 'What does the parts summary show?'],
        keywords: ['catalog', 'stock', 'inventory', 'adjust stock', 'parts summary'],
        answer:
          'Parts Supply OS holds the parts catalog (GET/POST /parts/parts): each part record carries its stock position, and stock changes go through the adjust-stock action (PATCH …/adjust-stock) so the count is a record, not a memory. The parts summary (GET /parts/summary) rolls the department up — catalog, stock value signals, and open orders — and feeds the Oversight parts tile and Turbo Boss\'s Parts scorecard. If the catalog and the shelf ever disagree, the shelf count is fixed on the record the same day; the record is what dispatch and ordering trust.',
      },
      {
        id: 'suppliers',
        name: 'Suppliers & Vendor Partners',
        blurb: 'Who the platform buys from — including its partner distributor.',
        explains: 'Supplier records and the Appliance Plus Parts Supply partner-distributor relationship.',
        starters: ['Who are our parts suppliers?', 'What is Appliance Plus Parts Supply?', 'How is a supplier added?'],
        keywords: ['supplier', 'vendor', 'distributor', 'appliance plus parts supply', 'partner'],
        answer:
          'Suppliers are records in Parts Supply OS (GET/POST /parts/suppliers) — the vendors the platform orders from. Appliance Plus Parts Supply is registered in the system as a PARTNER DISTRIBUTOR vendor: a partner in the network, deliberately distinct from Appliance Plus Air, LLC, which is a separate company and not part of Top Speed. A real ordering integration needs the vendor\'s commercial details on file; until then, ordering runs through the team with the vendor, and coaches never invent contact details, account numbers, or terms for any supplier.',
      },
      {
        id: 'purchase-orders',
        name: 'Purchase Orders',
        blurb: 'Order, receive, stock — in that order, on the record.',
        explains: 'How purchase orders are created and received into stock.',
        starters: ['How does a purchase order work?', 'How is a delivery received?', 'Who can create a PO?'],
        keywords: ['purchase order', 'po', 'receive', 'ordering', 'delivery'],
        answer:
          'A purchase order is created against a supplier (POST /parts/purchase-orders), and when the delivery arrives it is received against that PO (POST …/:id/receive), which is what moves the parts into stock. Ordering and receiving are staff operations in Parts Supply OS — the record of what was ordered, from whom, and what actually arrived is what Finance reconciles against, so a delivery that never gets received is a stock error waiting to happen.',
      },
      {
        id: 'usage',
        name: 'Job Parts Usage & Plug Orders',
        blurb: 'Every part used lands on the job that used it.',
        explains: 'Per-job parts usage records, and how Appliance Plug orders from the field are fulfilled.',
        starters: ['How are parts recorded on a job?', 'What happens to a Plug order?', 'Why record every part?'],
        keywords: ['usage', 'job parts', 'plug order', 'parts used', 'per-job'],
        answer:
          'Every part used on a job is recorded against that job (GET/POST /parts/usage) — Module 15 makes it a closing habit: the job record, the invoice, and the 90-day warranty all depend on knowing exactly which parts went in. Orders placed from the field through Appliance Plug arrive bound to their booking; Parts Supply OS is where the exact part number and price get confirmed at order time (the field finder is category-only by design), and the order status advances as the parts team and tech act on it.',
      },
      {
        id: 'low-stock',
        name: 'Low Stock & Reordering',
        blurb: 'The shelf warns before it empties.',
        explains: 'The low-stock signal and how it feeds reordering and the Oversight tile.',
        starters: ['How do we know a part is running low?', 'What happens on a low-stock flag?', 'Where does low stock show up?'],
        keywords: ['low stock', 'reorder', 'stock alert', 'running low'],
        answer:
          'Parts Supply OS computes the low-stock list (GET /parts/low-stock) from the catalog\'s stock positions, so the team reorders before a shelf empties instead of discovering it at a customer\'s home. Low stock is part of the parts summary that Oversight and Turbo Boss read — a manager sees the signal on the department tile without opening the warehouse console. Reordering itself is the purchase-order flow: PO to the supplier, receive on delivery, stock updated on the record.',
      },
    ],
  },
  {
    id: 'messages',
    name: 'Messages & Alerts',
    basis: 'routes/notifications.js (outbox, summary, health, settings) + services/notifications.js + Chat Insights',
    consoles: [
      { name: 'Notifications', path: '/notifications' },
      { name: 'Chat Insights', path: '/chats' },
    ],
    blurb: 'One outbox for every customer and staff message — with statuses that tell the truth about delivery.',
    specialist: {
      name: 'Nadia',
      title: 'Messages & Alerts Specialist',
      scope: 'The notification outbox, the alert matrix, channels and fallbacks, and notification settings.',
      explains:
        'How every alert and customer message flows through one outbox, which events notify whom, what each channel can honestly promise today, and how to check channel health.',
      starters: [
        'How do notifications work?',
        'Which events send alerts?',
        'Why would a text show as queued but not sent?',
      ],
    },
    keywords: ['notification', 'alert', 'outbox', 'sms', 'email', 'message', 'channel', 'twilio', 'resend'],
    kbIds: ['site-booking-how'],
    categories: [
      {
        id: 'outbox',
        name: 'The Outbox & Truthful Statuses',
        blurb: 'One queue for every message — and a status that means what it says.',
        explains: 'How notifications are queued centrally and why queued is never reported as sent.',
        starters: ['What is the notification outbox?', 'What do notification statuses mean?', 'Where can I see recent notifications?'],
        keywords: ['outbox', 'queue', 'notification status', 'queued', 'sent', 'summary'],
        answer:
          'Every notification — customer confirmations, stage updates, staff alerts, receipts — is queued through ONE outbox (services/notifications.js) and listed for staff at GET /notifications with a summary at /notifications/summary. The standing rule is truthful statuses: an entry says queued when it is queued, and nobody — human or AI — tells a customer a text or email "was sent" on the strength of a queue entry. Every customer-facing email carries the ecosystem reach footer, and every customer SMS carries one action link, appended centrally in the outbox so no surface can forget it.',
      },
      {
        id: 'alert-matrix',
        name: 'The Alert Matrix',
        blurb: 'The right people hear about the right events, immediately.',
        explains: 'Which platform events alert staff and customers — bookings, forms, diagnoses, sign-ups, governance escalations.',
        starters: ['Which events trigger alerts?', 'Who is alerted when a booking lands?', 'How do safety escalations reach the team?'],
        keywords: ['alert matrix', 'triggers', 'booking alert', 'staff alert', 'escalation alert', 'events'],
        answer:
          'The alert matrix (Module 11) fires on the moments that matter: a new booking alerts the Service Setters and confirms to the customer; form submissions, photo diagnoses, and sign-ups alert the team the moment they land; job stage changes update the customer (assigned, en route, arrived, completed). Governance events ride the same rails — a Speedy safety escalation or a refund REQUEST lands in the Service Setters\' persisted outbox as an internal alert for a human to act on. If an expected alert did not fire, the outbox and the Notifications console are where the team checks first.',
      },
      {
        id: 'channels',
        name: 'Channels & Provider Fallbacks',
        blurb: 'Resend for email, Twilio for SMS — each with a named fallback.',
        explains: 'The channel providers, the fallback design (SendGrid / Vonage), and how channel health is checked.',
        starters: ['Which providers send our messages?', 'What is the SMS fallback?', 'How do I check channel health?'],
        keywords: ['channel', 'resend', 'twilio', 'sendgrid', 'vonage', 'fallback', 'health', 'sms trial'],
        answer:
          'Email sends through Resend (with SendGrid as the named fallback) and SMS through Twilio (with Vonage as the named fallback) — fallbacks activate by configuration, never by improvisation (Module 11). Channel health is visible at GET /notifications/health. Honesty rule for SMS: when the SMS channel cannot deliver, the platform says so — receipts and updates offered by text state plainly when texting is unavailable or not guaranteed, and email is offered as the reliable path. Nobody promises a customer a text the channel cannot send.',
      },
      {
        id: 'settings',
        name: 'Notification Settings',
        blurb: 'Staff-side control over what notifies, where.',
        explains: 'Where notification settings live and who they are for.',
        starters: ['Where are notification settings?', 'Can customers change notification preferences?', 'Who manages alert settings?'],
        keywords: ['notification settings', 'preferences', 'alert settings', 'staff settings'],
        answer:
          'Notification settings (GET/PUT /notifications/settings) are a STAFF surface — they govern the team\'s alert behavior. There is no customer notification-preferences backend: customer-facing surfaces say so honestly and route preference requests to the team rather than showing toggles that do nothing. If a customer asks to change how they are contacted, a Service Setter handles it on their record — that is the real path today.',
      },
    ],
  },
  {
    id: 'system',
    name: 'System & Security',
    basis: 'Access rules + Speedy Verify (routes/speedyVerify.js) + Speedy governance (services/speedyPolicy.js) + Oversight/Turbo Boss + /health',
    consoles: [
      { name: 'Oversight', path: '/oversight' },
      { name: 'Turbo Boss', path: '/turbo-boss' },
      { name: 'ApplianceMan', path: '/applianceman' },
    ],
    blurb: 'Who may do what: the three account tiers, Speedy Verify access codes, Speedy\'s five hard limits, platform health, and the legal gate.',
    specialist: {
      name: 'Vera',
      title: 'Security & Speedy Verify Specialist',
      scope: 'Access tiers and roles, Speedy Verify codes, Speedy governance, platform health and events, and the legal signing gate.',
      explains:
        'The platform\'s authority structure: the Master/manager/setter tiers, how Speedy Verify codes gate accounts, the five things AI may never do, and how Oversight and Turbo Boss watch the whole system.',
      starters: [
        'What are the three account tiers?',
        'How does Speedy Verify work?',
        'What are Speedy\'s five hard limits?',
      ],
    },
    keywords: ['security', 'access', 'roles', 'speedy verify', 'governance', 'health', 'oversight', 'legal', 'master', 'tiers'],
    kbIds: ['gloss-speedy', 'gloss-domain-doors'],
    categories: [
      {
        id: 'tiers',
        name: 'Access, Roles & the Three Tiers',
        blurb: 'Master, Managers, Service Setters — three distinct tiers, one direction of authority.',
        explains: 'The tier model, the staff role set, grant-locking of the master tier, and Rule Zero.',
        starters: ['What are the three tiers?', 'Who can create a manager account?', 'What is Rule Zero?'],
        keywords: ['tiers', 'master', 'manager', 'service setter', 'roles', 'staff roles', 'rule zero', 'grant'],
        answer:
          'Accounts sit in three distinct tiers: the MASTER (the owner alone, COMPANY_OWNER — a single holder, grant-locked: only the master can grant the master tier, managers can never grant it, and there is no self-service escalation), MANAGERS (COMPANY_ADMIN), and SERVICE SETTERS (DISPATCHER). PLATFORM_ADMIN exists as a technical superuser beside the owner tier. Rule Zero sits above all of it: the owner is the supreme authority on every platform — no AI, automation, or Pepper may override him, lock him out, or make a change that outranks his, and the API enforces owner-account immutability in code. Day-to-day consoles gate on the staff role set (DISPATCHER, COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN); owner-only doors — account creation, code issuing, referral settings, campaign approval — check the tier, not just staff membership.',
      },
      {
        id: 'verify',
        name: 'Speedy Verify — Access Codes',
        blurb: 'A code in addition to a password, issued only under the Master\'s authority.',
        explains: 'How codes are issued, verified, revoked, and recovered — and which accounts start unverified.',
        starters: ['How does Speedy Verify work?', 'Which accounts need a code?', 'What happens after too many wrong codes?'],
        keywords: ['speedy verify', 'access code', 'verify required', 'issue code', 'revoke', 'lockout', 'recovery'],
        answer:
          'Speedy Verify is the access-code system: an 8-digit code, issued only under the Master\'s authority, stored as a scrypt hash and shown exactly once at issue, that verifies an account IN ADDITION to its password — no valid code, no access. Activation is per account (verifyRequired): existing accounts were grandfathered, while NEW staff and new business/property-manager accounts start unverified — sign-in is denied until the Master issues their code from the Speedy Verify panel in ApplianceMan, where the waiting accounts queue up. Only the Master (COMPANY_OWNER) can issue, revoke, or flip the requirement — managers get 403. Five wrong codes lock entry for 15 minutes; revoking a code bites at the account\'s next console load. The Master can never be locked out: recovery runs through the owner\'s own email with a single-use token. Customers are unchanged in Phase 1; provider accounts are flagged but their sign-in gate lands in a later phase.',
      },
      {
        id: 'governance',
        name: 'Speedy Governance — the Five Hard Limits',
        blurb: 'What AI may never do here, enforced in code three ways.',
        explains: 'The five limits and the three enforcement layers (pre-screen, prompt, tools).',
        starters: ['What are Speedy\'s five hard limits?', 'How is governance enforced?', 'Can Speedy approve anything?'],
        keywords: ['governance', 'hard limits', 'refunds ai', 'certify safety', 'credentials', 'compliance', 'pre-screen'],
        answer:
          'The five hard limits (owner-set, 2026-11-09): issuing refunds requires a human or configured approval; diagnosing safety-critical conditions goes to a human professional; certifying repair safety is NEVER AI; overriding technician credentials is NEVER AI; changing a compliance status is authorized-human only. Enforcement is in code, three layers deep: a deterministic pre-screen answers policy/safety messages before the model ever sees them (performing only the human-owned action — an approval request or an escalation into the Service Setters\' outbox); the same rules are written into Speedy\'s system prompt; and Speedy\'s tools can only CREATE human-owned requests — no tool lets it approve, certify, override, or change anything itself. The Academy\'s own specialists follow the same law: they explain and guide, and never execute operations.',
      },
      {
        id: 'health',
        name: 'Platform Health, Events & Oversight',
        blurb: 'One screen for the whole operation, and a health endpoint that tells the truth.',
        explains: 'The /health endpoint, the platform events feed, Oversight tiles, and the Turbo Boss decision queue.',
        starters: ['How do we know the platform is healthy?', 'What does Oversight show?', 'What is Turbo Boss for?'],
        keywords: ['health', 'healthy', 'platform healthy', 'system healthy', 'oversight', 'turbo boss', 'platform events', 'monitoring', 'system health'],
        answer:
          'GET /api/v1/health reports the API\'s real state: database connection, notification provider status, and Speedy\'s status — including whether the AI provider is configured and the knowledge-base size, so "Speedy is answering from the knowledge base" is a visible fact, never a hidden failure. Oversight (/oversight) monitors every department on live tiles with an activity feed from platform events. Turbo Boss (/turbo-boss) is the command side: a Needs-a-Decision queue (aging unassigned jobs, AREA_REVIEW, referral approvals, pending campaigns, Speedy Verify waits), department scorecards, the team board, and an honest money snapshot. Oversight monitors; Turbo Boss commands.',
      },
      {
        id: 'legal',
        name: 'Legal Terms & the Signing Gate',
        blurb: 'Two documents, signed before access, re-signed on change.',
        explains: 'The Terms & Conditions and Software Terms, how signing works, and what staff may say about them.',
        starters: ['What does a new account sign?', 'Where are the legal documents?', 'Can I interpret a clause for a customer?'],
        keywords: ['legal', 'terms', 'signing', 'sign', 'signs', 'new account sign', 'account sign', 'terms and conditions', 'software terms', 'gate'],
        answer:
          'Before account access, a customer reviews and signs two documents on the legal page (/legal): the Top Speed Service OS Terms & Conditions and the Appliance Connect Software Terms of Use (both version 1.0, effective November 12, 2026). Signing means checking the agreement box for each document and typing their full name; the acceptance is recorded with the account, and if a document\'s version changes, the new version is signed before continuing. Staff point people to /legal and summarize only what the documents state — nobody on the team gives legal advice or interprets a clause for someone\'s situation; questions about the documents go to the team by phone.',
      },
    ],
  },
  {
    id: 'training',
    name: 'Training Academy',
    basis: 'Top Speed Academy (/academy) + Media OS training records (routes/mediaOs.js) + Speedy Class',
    consoles: [
      { name: 'Academy', path: '/academy' },
      { name: 'Media OS', path: '/media' },
    ],
    blurb: 'The staff university itself: 29 modules in 8 role tracks, Speedy Class, and the specialists you are talking to now.',
    specialist: {
      name: 'Ada',
      title: 'Academy Specialist',
      scope: 'The Academy curriculum and tracks, Speedy Class, module videos and hosting, and learning paths by role.',
      explains:
        'How the Academy is organized, which track belongs to which role, how Speedy Class and the department specialists divide the teaching, and where module videos live.',
      starters: [
        'How is the Academy organized?',
        'Which track should a new Service Setter take?',
        'Where do I watch module videos?',
      ],
    },
    keywords: ['academy', 'training', 'module', 'track', 'speedy class', 'curriculum', 'learning'],
    kbIds: ['gloss-speedy'],
    categories: [
      {
        id: 'curriculum',
        name: 'Curriculum & Tracks',
        blurb: '29 modules, 8 tracks, one order: Foundation first.',
        explains: 'The eight tracks, their module ranges, and how modules live in Media OS.',
        starters: ['What are the 8 tracks?', 'How many modules are there?', 'Where does the curriculum live?'],
        keywords: ['curriculum', 'tracks', 'modules', 'foundation', 'media os', 'training library'],
        answer:
          'The Academy curriculum is 29 modules in 8 role tracks: Foundation (Modules 1–3, every role), Owner (4–7), Manager (8–11), Technician (12–15), Setter (16–19), Dispatcher (20–22), Ad Specialist (23–26), and Customer-Facing (27–29). The modules themselves are Media OS content records tagged "training-academy" — the Academy page reads the library live, so a module\'s status and video on its card are the Media OS truth, not a hard-coded list. Each module card states what it teaches; Ada and the department specialists can walk any module\'s content with you.',
      },
      {
        id: 'speedy-class',
        name: 'Speedy Class & the Specialists',
        blurb: 'One general instructor, plus a specialist for every department.',
        explains: 'How Speedy Class teaches from the curriculum, and how the Specialists & Strategists differ.',
        starters: ['What is Speedy Class?', 'How are the specialists different from Speedy Class?', 'Who teaches a module?'],
        keywords: ['speedy class', 'instructor', 'specialists', 'strategists', 'ai teacher'],
        answer:
          'Speedy Class, at the top of the Academy page, is the general AI instructor: Speedy teaching from the Academy curriculum and the platform knowledge base — ask it about any module, your track, or how the platform works. The AI Specialists & Strategists are the department layer beneath it: one specialist per department and scoped guidance per category, grounded in the same knowledge base, so a question about dispatch goes to the dispatch specialist with dispatch context. Both follow the same law — they explain and guide; operations are done by people in the consoles. And both keep teaching when the AI provider is down, answering from the knowledge base instead of failing.',
      },
      {
        id: 'videos',
        name: 'Module Videos & Hosting',
        blurb: 'Videos attach to module cards — no invented links, ever.',
        explains: 'Where module videos play, and the honest state of permanent video hosting.',
        starters: ['Where do I watch the videos?', 'Why does a module card show no video?', 'Can you send me a video link?'],
        keywords: ['video', 'hosting', 'watch', 'module video', 'cloudflare stream'],
        answer:
          'Module videos play on the Academy page itself, on each module\'s card. A card without a player is a module whose video is not attached yet — permanent video hosting for the library is being set up, and the moment a video attaches in Media OS, its card shows it. Nobody invents a video URL, a watch link, a module length, a quiz, or a completion rule: if it is not on the card, it does not exist yet, and the module\'s taught content is still fully available through Speedy Class and the specialists.',
      },
      {
        id: 'paths',
        name: 'Learning Paths by Role',
        blurb: 'Foundation for everyone, then your role\'s track.',
        explains: 'The recommended path per role, in module order.',
        starters: ['What should a manager learn first?', 'What is the technician path?', 'Does everyone take Foundation?'],
        keywords: ['learning path', 'role path', 'new hire', 'which track', 'order', 'learn first', 'manager learn', 'manager path', 'what should'],
        answer:
          'Everyone starts with Foundation — Modules 1–3 (the platform map, the job journey, working with Speedy AI) — because every later track assumes them. Then by role: the owner takes 4–7; managers 8–11; technicians and field providers 12–15; Service Setters 16–19; dispatchers 20–22; ad specialists 23–26; and everyone who talks to customers adds Customer-Facing 27–29 on top of their own track. When in doubt, ask Ada or your department specialist "what do I learn next?" and they will name the exact module number and title.',
      },
    ],
  },
];

/* ------------------------- resolution helpers ------------------------- */

/** All coach knowledge entries (KB entry shape) for guide + departments + categories. */
export function coachEntries() {
  const entries = [
    {
      id: 'coach-guide',
      topic: `${ECOSYSTEM_GUIDE.name} — ${ECOSYSTEM_GUIDE.title}`,
      keywords: ECOSYSTEM_GUIDE.keywords,
      answer: ECOSYSTEM_GUIDE.answer,
      deptId: 'guide',
      categoryId: null,
    },
  ];
  for (const dept of DEPARTMENTS) {
    entries.push({
      id: `coach-dept-${dept.id}`,
      topic: `${dept.name} — department overview`,
      keywords: [...dept.keywords, dept.name.toLowerCase()],
      answer:
        `${dept.blurb} ${dept.specialist.name}, the ${dept.specialist.title}, covers: ${dept.specialist.scope} ` +
        `Run it in: ${dept.consoles.map((c) => c.name).join(', ')}. ` +
        `Categories: ${dept.categories.map((c) => c.name).join('; ')}.`,
      deptId: dept.id,
      categoryId: null,
    });
    for (const cat of dept.categories) {
      entries.push({
        id: `coach-${dept.id}-${cat.id}`,
        topic: `${dept.name} — ${cat.name}`,
        keywords: cat.keywords,
        answer: cat.answer,
        deptId: dept.id,
        categoryId: cat.id,
      });
    }
  }
  return entries;
}

/** KB entry ids a department's retrieval scope draws on. */
export function departmentKbIds(dept) {
  const ids = new Set(dept.kbIds || []);
  return [...ids];
}

/**
 * Resolve a chat target: 'guide', a department id, or
 * '<departmentId>:<categoryId>'. Returns a normalized scope object or
 * null for an unknown target.
 */
export function resolveSpecialist(target) {
  const value = String(target || '').trim();
  if (value === 'guide') {
    return {
      target: 'guide',
      kind: 'guide',
      dept: null,
      category: null,
      name: ECOSYSTEM_GUIDE.name,
      title: ECOSYSTEM_GUIDE.title,
      scope: ECOSYSTEM_GUIDE.scope,
      explains: ECOSYSTEM_GUIDE.explains,
      starters: ECOSYSTEM_GUIDE.starters,
      kbIds: ECOSYSTEM_GUIDE.kbIds,
      keywords: ECOSYSTEM_GUIDE.keywords,
    };
  }
  const [deptId, categoryId] = value.split(':');
  const dept = DEPARTMENTS.find((d) => d.id === deptId);
  if (!dept) return null;
  if (categoryId) {
    const category = dept.categories.find((c) => c.id === categoryId);
    if (!category) return null;
    return {
      target: `${dept.id}:${category.id}`,
      kind: 'category',
      dept,
      category,
      name: dept.specialist.name,
      title: `${dept.specialist.title} — ${category.name} Strategist`,
      scope: `${dept.name} / ${category.name}: ${category.explains}`,
      explains: category.explains,
      starters: category.starters,
      kbIds: departmentKbIds(dept),
      keywords: category.keywords,
    };
  }
  return {
    target: dept.id,
    kind: 'department',
    dept,
    category: null,
    name: dept.specialist.name,
    title: dept.specialist.title,
    scope: dept.specialist.scope,
    explains: dept.specialist.explains,
    starters: dept.specialist.starters,
    kbIds: departmentKbIds(dept),
    keywords: dept.keywords,
  };
}

/** The public roster payload for the Academy UI. */
export function specialistsRoster() {
  return {
    guide: {
      id: ECOSYSTEM_GUIDE.id,
      name: ECOSYSTEM_GUIDE.name,
      title: ECOSYSTEM_GUIDE.title,
      scope: ECOSYSTEM_GUIDE.scope,
      explains: ECOSYSTEM_GUIDE.explains,
      starters: ECOSYSTEM_GUIDE.starters,
    },
    departments: DEPARTMENTS.map((dept) => ({
      id: dept.id,
      name: dept.name,
      blurb: dept.blurb,
      consoles: dept.consoles,
      specialist: dept.specialist,
      categories: dept.categories.map((cat) => ({
        id: cat.id,
        target: `${dept.id}:${cat.id}`,
        name: cat.name,
        blurb: cat.blurb,
        explains: cat.explains,
        starters: cat.starters,
      })),
    })),
  };
}
