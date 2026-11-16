/**
 * PLATFORM GLOSSARY pack — curated, customer-safe explanations of
 * every Top Speed door, app, and program, so Speedy can answer
 * "what is X?" for anything on the platform in two to four sentences.
 * Facts here mirror the live platform (portal separation is strict:
 * Appliance Pro is commercial only; Appliance Connect Pro is
 * homeowners + property managers; the Tech App is providers only).
 * Entry shape: { id, topic, keywords, answer, link? }.
 */

const SITE = 'https://topspeedserviceos.com';

export const GLOSSARY_PACK = [
  {
    id: 'gloss-appliance-connect',
    topic: 'Appliance Connect — the customer app',
    keywords: ['appliance connect', 'customer app', 'the app', 'your app', 'connect app'],
    answer:
      `Appliance Connect is the free customer app: your bookings save to your account, you register your appliances, see your service history, track jobs live, and manage referrals — all on the one Service OS record, so a job booked anywhere shows up here. It is the homeowner/residential door.`,
    link: `${SITE}/app`,
  },
  {
    id: 'gloss-appliance-connect-pro',
    topic: 'Appliance Connect Pro — homeowners & property managers',
    keywords: ['appliance connect pro', 'connect pro', 'connect pro app', 'property manager app', 'homeowner app'],
    answer:
      `Appliance Connect Pro is the app for homeowners and property managers: appliance registry, service history, and Speedy booking under your account. Property managers also send bulk service requests for many units at once, watch every work order's live stage, get a photo report after each job, and receive one consolidated monthly invoice itemized by unit. It is not the commercial door — businesses use Appliance Pro.`,
    link: `${SITE}/connect-pro-app`,
  },
  {
    id: 'gloss-appliance-pro',
    topic: 'Appliance Pro — commercial accounts only',
    keywords: ['appliance pro', 'appliance pro app', 'commercial app', 'commercial accounts', 'business app', 'what is appliance pro'],
    answer:
      `Appliance Pro is the commercial door — for businesses only (restaurants, hotels, laundromats, healthcare, offices, facilities), never residential customers. Every unit gets an equipment-registry record with a TS-EQ asset tag (brand, model, serial, service history), work orders run on a priority dispatch track, and everything rolls into one consolidated monthly invoice. Commercial work is priced by custom quote per facility — the residential $99 diagnostic never applies there.`,
    link: `${SITE}/appliance-pro`,
  },
  {
    id: 'gloss-speedy-pro',
    topic: 'Speedy Pro — the pro suite for technicians and providers',
    keywords: ['speedy pro', 'speedy pro suite', 'pro suite', 'what is speedy pro', 'tech suite'],
    answer:
      `Speedy Pro is the professional suite for Top Speed technicians and network providers — the working side of the platform, not a customer app. It has two modules: Field Pro, the work-order workspace, and Appliance Plug, the model-plate and parts tool. Providers sign in through the Tech App; customers never need Speedy Pro — their doors are Appliance Connect and Appliance Connect Pro.`,
    link: `${SITE}/speedy-pro`,
  },
  {
    id: 'gloss-field-pro',
    topic: 'Field Pro — the technician work-order workspace',
    keywords: ['field pro', 'speedy ai field pro', 'work order workspace', 'technician workspace'],
    answer:
      `Field Pro is the technician's work-order workspace inside Speedy Pro (in the Tech App). Each assignment opens with the real booking — customer, appliance, issue, address, appointment window — plus call/text/navigate actions, a five-step service checklist saved to the job, tech notes, the job's quote facts, a parts tab powered by Appliance Plug, and a downloadable service report generated from the real job.`,
    link: `${SITE}/speedy-pro`,
  },
  {
    id: 'gloss-appliance-plug',
    topic: 'Appliance Plug — snap the plate, find the parts',
    keywords: ['appliance plug', 'plug app', 'model plate', 'snap the plate', 'parts finder', 'snap and order'],
    answer:
      `Appliance Plug is the technicians' parts tool inside Speedy Pro: snap a photo of the appliance's model plate and Speedy reads the brand, model, and serial; the technician confirms the read, then the Parts Finder returns the part categories that fit the job, with fitment and verify-first notes. Selected parts go into an order draft tied to the work order and routed through Parts Supply OS — the exact OEM part number and price are always confirmed by Parts Supply OS at order time, never guessed.`,
    link: `${SITE}/appliance-plug-app`,
  },
  {
    id: 'gloss-pepper-lists-it',
    topic: 'Pepper Lists It — snap it, sell it',
    keywords: ['pepper lists it', 'pepper lists', 'sell my stuff', 'sell items', 'marketplace selling', 'list it'],
    answer:
      `Pepper Lists It is the selling tool: snap a photo of something you want to sell and Pepper drafts the Marketplace listing — title, category, condition, description, and a price matched to your usual items (a price is never invented for an unknown item). Nothing posts without the owner's confirmation; confirmed listings go to Facebook Marketplace, with more platforms queued behind it.`,
    link: 'https://pepperlists.com',
  },
  {
    id: 'gloss-refer-earn',
    topic: 'Refer & Earn — the referral program',
    keywords: [
      'refer and earn', 'refer & earn', 'refer a friend', 'referral program', 'referral',
      'referral credits', 'referral code', 'earn credit', 'invite a friend',
    ],
    answer:
      `Refer & Earn is the referral program: when your job completes you automatically get a personal referral code and link. A friend who books through it gets $25 off their first eligible repair (the New Customer Welcome). When the friend's job is completed and paid, you earn service credit — $25 per completed referral for the first four, $35 each from the 5th through the 9th, $50 each from the 10th on, plus one-time milestone bonuses of $100 at 10 and $250 at 25 lifetime completed referrals. A Service Setter approves each credit before it is issued, and credits expire 12 months after issuance. Your code, link, and each referral's stage live on the Refer & Earn screen in the app.`,
    link: `${SITE}/refer`,
  },
  {
    id: 'gloss-service-setters',
    topic: 'Service Setters & Book OS — the human dispatch team',
    keywords: ['service setters', 'book os', 'dispatch team', 'who confirms', 'human review', 'dispatch'],
    answer:
      `Service Setters are Top Speed's human dispatch team. The platform proposes a provider match for every booking, but a Service Setter reviews and approves every booking and every dispatch before a technician rolls — nobody is dispatched by AI alone. Book OS is the staff console the Setters work from; it is team-only, but the human review it represents is part of every customer's job.`,
  },
  {
    id: 'gloss-track-my-tech',
    topic: 'Track My Tech — live job tracking',
    keywords: ['track my tech', 'tracking', 'track my job', 'live tracking', 'where is my technician'],
    answer:
      `Track My Tech is how you follow a booked job through its 8 stages — from request received to repair completed. Open it at topspeedserviceos.com/track, signed in or as a guest with your booking reference and the phone number on the booking. The technician's live location appears only while they are en route, and any ETA shown is the technician's own estimate.`,
    link: `${SITE}/track`,
  },
  {
    id: 'gloss-my-garage',
    topic: 'My Garage — your appliance registry',
    keywords: ['my garage', 'garage', 'appliance registry', 'register my appliance', 'my appliances'],
    answer:
      `My Garage is your appliance registry inside the customer app: save each appliance's brand and model once, and it stays on your record with its service history. That makes repeat bookings faster (Speedy already knows the appliance) and lets maintenance reminders and seasonal checkups be scheduled from the registry so nothing lapses.`,
    link: `${SITE}/garage`,
  },
  {
    id: 'gloss-smart-booking',
    topic: 'Smart Booking — the web booking form',
    keywords: ['smart booking', 'booking form', 'web form', 'book online', 'online booking'],
    answer:
      `Smart Booking is the web booking form at topspeedserviceos.com/book — the form twin of booking with Speedy in chat. It shows you the full price panel (the $99 diagnostic terms, flat labor, warranty) before you confirm, lets you attach a photo of the problem for a Speedy read, and lands in the same Service Setters queue as every other booking, with the same reference and tracking.`,
    link: `${SITE}/book`,
  },
  {
    id: 'gloss-photo-diagnosis',
    topic: 'Photo diagnosis — Speedy reads a photo of the problem',
    keywords: ['photo diagnosis', 'diagnose by photo', 'send a photo', 'photo read', 'picture of the problem'],
    answer:
      `Photo diagnosis lets you send Speedy a photo of the problem — in chat or during Smart Booking — and get a preliminary read: what appliance it is, what is visible, the most likely causes, and what a technician would check on site. It is a head start, never a final diagnosis: the photo itself is not stored, no price is ever quoted from a photo, and the technician confirms the actual cause in person at the diagnostic visit.`,
    link: `${SITE}/speedy`,
  },
  {
    id: 'gloss-parts-supply-os',
    topic: 'Parts Supply OS — where job parts come from',
    keywords: ['parts supply', 'parts supply os', 'parts department', 'order parts', 'parts ordering', 'appliance plus parts supply'],
    answer:
      `Parts Supply OS is the platform's parts system: the parts used on a job are recorded against it, and orders route to suppliers — including the partner distributor Appliance Plus Parts Supply — with the exact OEM part number and price confirmed at order time. Customers never have to chase parts themselves; technicians work it through Appliance Plug, and the part and its cost land on your written quote before you approve anything.`,
  },
  {
    id: 'gloss-memberships',
    topic: 'Memberships & maintenance plans',
    keywords: ['memberships', 'membership', 'maintenance plan', 'maintenance agreement', 'priority membership', 'service plan'],
    answer:
      `Top Speed offers maintenance agreements for homes and facilities — seasonal checkups scheduled from your appliance registry — and a Priority Membership with eligible priority scheduling, subject to capacity. Every plan's price and terms are confirmed with the team for your account before anything is charged; nothing about a membership is charged from a chat.`,
    link: `${SITE}/memberships`,
  },
  {
    id: 'gloss-domain-doors',
    topic: 'The Top Speed websites — many doors, one platform',
    keywords: [
      'websites', 'domains', 'which website', 'fixmyappliancefl', 'fix my appliance fl',
      'topspeedappliance.net', 'applianceconnectpro.com', 'cleanoutvents.com', 'pepperlists.com',
      'appliancepro.app', 'appliancereferral.com', 'topspeedservice.app',
    ],
    answer:
      `Top Speed has several front doors, all running on the one Service OS with the same record: topspeedappliance.net is the customer flagship; topspeedapplianceservice.com is the provider-network home and a service-request door; fixmyappliancefl.com is the Florida repair door; topspeedservice.app opens the customer app; applianceconnectpro.com opens Connect Pro; cleanoutvents.com is the vent partner's door; pepperlists.com is Pepper Lists It; appliancepro.app and appliancepro.net open Appliance Pro; appliancereferral.com opens Refer & Earn. A job booked through any of them is the same job everywhere.`,
  },
  {
    id: 'gloss-speedy',
    topic: 'Speedy — the AI assistant (who you are talking to)',
    keywords: ['speedy', 'who are you', 'what are you', 'ai assistant', 'are you a robot', 'are you ai'],
    answer:
      `Speedy is Top Speed's AI assistant — the front door of the platform. Speedy answers questions, helps you book, reads photos of appliance problems (a preliminary read), and connects you to the team. Speedy has hard limits by design: it never approves a refund, never certifies that a repair is safe, never overrides technician credentials, and never changes a compliance status — those belong to humans, and Speedy will say so and hand off when they come up.`,
    link: `${SITE}/speedy`,
  },
  {
    id: 'gloss-top-speed-group',
    topic: 'Top Speed Group — the enterprise brand',
    keywords: ['top speed group', 'group', 'parent company', 'divisions', 'enterprise'],
    answer:
      `Top Speed Group is the enterprise brand of Top Speed Appliance LLC — the umbrella over its divisions (Top Speed Services, Top Speed Digital, Service Setters, Top Speed Local, Appliance Plus Parts Supply as a partner network, Top Speed Network, Top Speed Logistics, and Top Speed Academy), all running on the one Service OS. Some divisions are still in development; services are provided by Top Speed Appliance LLC and vetted network partners.`,
    link: `${SITE}/group`,
  },
];
