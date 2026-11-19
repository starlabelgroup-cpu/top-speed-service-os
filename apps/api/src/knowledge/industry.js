/**
 * INDUSTRY pack — curated home-service & appliance knowledge:
 * what each service visit involves, symptom guides, safety entries,
 * maintenance, repair-vs-replace guidance, and brand notes.
 *
 * Discipline: general industry knowledge only, phrased as
 * "typically / commonly". Symptom guides are PRELIMINARY — they name
 * common causes and safe checks, and always land on the truth that a
 * technician's on-site diagnostic confirms the actual cause. Safety
 * entries lead with getting safe and never include DIY repair steps
 * for hazardous work. NO prices, NO ratings, NO invented statistics
 * anywhere in this pack. Entry shape: { id, topic, keywords, answer,
 * link?, safety? }.
 */

/* ------------------------- services explained ------------------------- */

const SERVICES_EXPLAINED = [
  {
    id: 'ind-svc-refrigerator',
    topic: 'Refrigerator repair — what the visit involves',
    keywords: ['refrigerator repair', 'fridge repair', 'refrigerator service', 'fix my refrigerator', 'refrigerator'],
    answer:
      `A refrigerator service visit starts with the diagnostic: the technician checks temperatures in both compartments, then tests the components the symptoms point to — condenser and evaporator fans, the defrost system, temperature controls and sensors, and the sealed system. You get the actual cause and a written estimate, and the repair itself (a fan, a defrost part, a control, or a bigger sealed-system job) only starts after you approve it.`,
  },
  {
    id: 'ind-svc-washer',
    topic: 'Washer repair — what the visit involves',
    keywords: ['washer repair', 'washing machine repair', 'washer service', 'fix my washer', 'washing machine'],
    answer:
      `On a washer visit the technician runs the machine through its cycles and tests what the symptom points to: the drain pump and filter, hoses, the lid or door lock, the belt and drive parts, suspension, and the control. Many washer problems are one replaceable part away from fixed; the diagnostic confirms which one before anything is ordered or quoted.`,
  },
  {
    id: 'ind-svc-dryer',
    topic: 'Dryer repair — what the visit involves',
    keywords: ['dryer repair', 'dryer service', 'fix my dryer', 'clothes dryer repair'],
    answer:
      `A dryer visit covers both the machine and its vent path, because the two are linked: the technician tests the heating circuit (element or igniter, thermal fuse, thermostats), the belt, rollers and motor, and checks airflow through the vent — a restricted vent is a common hidden cause of no-heat and long dry times. A blown thermal fuse is treated as a symptom to explain, never a part to just swap and leave.`,
  },
  {
    id: 'ind-svc-oven-range',
    topic: 'Oven & range repair — what the visit involves',
    keywords: ['oven repair', 'range repair', 'stove repair', 'oven service', 'fix my oven', 'cooktop repair'],
    answer:
      `An oven or range visit tests the heat source first — bake and broil elements on electric models, the igniter on gas models (a worn igniter is the most common gas-oven fault) — then the temperature sensor, controls, and door seal. The technician verifies actual oven temperature against the setting before quoting any part. Gas work is always technician work; a gas smell is a safety situation, not a troubleshooting step.`,
  },
  {
    id: 'ind-svc-dishwasher',
    topic: 'Dishwasher repair — what the visit involves',
    keywords: ['dishwasher repair', 'dishwasher service', 'fix my dishwasher'],
    answer:
      `A dishwasher visit inspects the water path end to end: inlet valve, float switch, pump and drain path, spray arms and filter, door gasket and seals. The technician separates cleaning problems (often filters, spray arms, or water temperature) from draining and leaking problems (pump, hoses, seals), confirms the cause, and quotes the repair in writing.`,
  },
  {
    id: 'ind-svc-freezer-ice-maker',
    topic: 'Freezer & ice maker repair — what the visit involves',
    keywords: ['freezer repair', 'ice maker repair', 'ice machine repair', 'freezer service', 'fix my ice maker'],
    answer:
      `Freezer and ice maker visits start with temperature: an ice maker generally needs the freezer at about 0°F to cycle. The technician then checks the water inlet valve, the filter and water pressure, the ice maker module, and — for a warm freezer — the same cooling and defrost components a refrigerator uses. The cause is confirmed by testing, not by swapping the most obvious part.`,
  },
  {
    id: 'ind-svc-microwave',
    topic: 'Microwave repair — what the visit involves',
    keywords: ['microwave repair', 'microwave service', 'fix my microwave'],
    answer:
      `Microwave diagnosis is technician-only territory: the internal high-voltage components can hold a dangerous charge even when the unit is unplugged, so the cabinet is never opened by anyone but a technician. A visit typically covers the door switches, controls, turntable and light circuits, and a heating test. If a microwave is arcing, sparking, or smelling of burning, stop using it and unplug it if that is safe to do.`,
  },
  {
    id: 'ind-svc-garbage-disposal',
    topic: 'Garbage disposal repair — what the visit involves',
    keywords: ['garbage disposal repair', 'disposal repair', 'disposal service', 'fix my disposal'],
    answer:
      `A disposal visit identifies whether the unit is jammed, electrically dead, leaking, or worn out. Many jams free up with the power off, the reset button, and the hex socket on the bottom of the unit; leaks are traced to the mounting flange, seals, or the housing itself. When the housing is cracked or the motor has failed, replacement is usually the honest answer, and the technician will say so at the diagnostic.`,
  },
  {
    id: 'ind-svc-installation',
    topic: 'Appliance installation — what a proper install involves',
    keywords: ['installation', 'install', 'appliance installation', 'install a new', 'hook up', 'setup appliance'],
    answer:
      `A proper installation is more than sliding the unit in: it includes leveling, correct water, electrical, and (for gas) fuel connections, and leak and function checks before the job is called done. A new dishwasher also needs the drain connection checked — including the knockout plug on a new garbage disposal, a classic cause of a first-week no-drain call. Top Speed's installation labor is a flat published rate; the visit confirms connections and clearances on site.`,
  },
];

/* --------------------------- symptom guides --------------------------- */
/* Preliminary by construction: common causes, SAFE checks only, and
 * the on-site diagnostic as the confirming step. */

const SYMPTOM_GUIDES = [
  {
    id: 'ind-sym-fridge-not-cooling',
    topic: 'Refrigerator not cooling — common causes and safe checks',
    keywords: ['fridge not cooling', 'refrigerator not cooling', 'not cooling', 'fridge warm', 'refrigerator warm', 'fridge not cold', 'freezer cold fridge warm'],
    answer:
      `A refrigerator that is not cooling commonly traces to one of a few things: dirty condenser coils, a failed condenser or evaporator fan, frost buildup from a defrost-system failure, a faulty temperature control, or — the serious end — compressor or sealed-system trouble. Safe checks you can do yourself: confirm the temperature settings (about 37–38°F for the fridge, 0°F for the freezer), make sure vents inside are not blocked by food, and check the door seals close fully. If the freezer is cold but the fresh-food side is warm, that usually points at airflow — a fan, a damper, or frost choking the evaporator. This is a preliminary read only: which cause is yours is confirmed by a technician's on-site diagnostic.`,
  },
  {
    id: 'ind-sym-washer-not-draining',
    topic: 'Washer not draining — common causes and safe checks',
    keywords: ['washer not draining', 'not draining', 'washer standing water', 'washing machine wont drain', 'water in washer', 'drain problem'],
    answer:
      `A washer that will not drain is commonly one of: a clogged pump filter or coin trap, a kinked or blocked drain hose, a failing drain pump, or a door-lock fault stopping the cycle. Safe checks: look for a kink in the drain hose behind the machine, and — if your model's manual shows an accessible pump filter — check it for coins and lint with the power off and a towel ready for the water that comes out. Do not force a cycle to repeat. A technician tests the pump and lock circuit at the diagnostic to confirm the actual cause.`,
  },
  {
    id: 'ind-sym-dryer-not-heating',
    topic: 'Dryer not heating — common causes and safe checks',
    keywords: ['dryer not heating', 'dryer no heat', 'not heating', 'dryer tumbles no heat', 'clothes not drying', 'dryer takes too long'],
    answer:
      `A dryer that tumbles but does not heat commonly involves a blown thermal fuse, a failed heating element (electric) or igniter (gas) — and very often a restricted vent behind it all, because poor airflow both slows drying and overheats the safety fuse. Safe checks: clean the lint trap, and check that the vent hose is not crushed and the outside vent flap opens when the dryer runs. Never bypass a thermal fuse or any safety device — that is exactly the part standing between a fault and a fire. The technician tests the heating circuit and the vent path at the diagnostic.`,
  },
  {
    id: 'ind-sym-oven-not-heating',
    topic: 'Oven not heating — common causes and safe checks',
    keywords: ['oven not heating', 'oven wont heat', 'no heat in oven', 'oven not getting hot', 'broiler not working', 'bake not working'],
    answer:
      `An oven that will not heat is commonly a failed bake or broil element on an electric model, or a worn igniter on a gas model — the igniter is the most common gas-oven fault there is. Temperature that runs hot or cold commonly involves the temperature sensor or calibration. Safe checks: on an electric oven you can look (power off) for visible blistering or a break in the element; on a gas oven, note whether the igniter glows but the burner never lights — that detail helps the technician. Do not attempt gas repairs yourself. The diagnostic confirms the part before anything is quoted.`,
  },
  {
    id: 'ind-sym-dishwasher-leaking',
    topic: 'Dishwasher leaking — common causes and safe checks',
    keywords: ['dishwasher leaking', 'dishwasher leak', 'leaking dishwasher', 'water under dishwasher', 'dishwasher dripping'],
    answer:
      `Dishwasher leaks commonly trace to the door gasket, the inlet valve, pump seals, a stuck float switch, or over-sudsing from the wrong detergent (hand soap in a dishwasher foams its way out the door). Safe checks: make sure only dishwasher detergent is used, check the door gasket for tears or trapped debris, and confirm the machine sits level. If water is actively pooling or reaching cabinets or flooring, turn off the water supply to the dishwasher and do not run it — water near electrical connections is a safety issue, not a wait-and-see. A technician pressure-tests the water path at the diagnostic to find the exact source.`,
  },
  {
    id: 'ind-sym-no-ice',
    topic: 'Ice maker making no ice — common causes and safe checks',
    keywords: ['no ice', 'ice maker not working', 'not making ice', 'ice maker stopped', 'no ice cubes'],
    answer:
      `An ice maker that stops commonly involves the water inlet valve, a clogged or overdue water filter, low water pressure, the ice maker module itself, or a freezer running too warm — ice makers generally need about 0°F to cycle. Safe checks: confirm the freezer is at 0°F, check whether the water filter is past its roughly 6-month life, make sure the ice maker's arm or switch is on, and confirm the water line valve is open. If the freezer itself is warm, the ice maker is a symptom, not the problem. The technician tests the valve and module at the diagnostic.`,
  },
  {
    id: 'ind-sym-noises',
    topic: 'Appliance making unusual noises — what noises usually mean',
    keywords: ['noise', 'noisy', 'unusual noises', 'buzzing', 'grinding', 'clicking noise', 'humming', 'rattling', 'squealing', 'banging', 'loud noise'],
    answer:
      `New noises are information: buzzing or humming often points at a fan motor or compressor working hard; grinding or squealing at bearings, rollers, or a belt; rhythmic thumping in a dryer at rollers or the belt; clicking in a washer at something caught in the pump; rattling at a loose panel or a fan blade touching frost. Safe checks: note WHEN the noise happens (start of cycle, while running, while filling or draining) and whether anything else changed — that pattern is the single most useful thing you can tell the technician. A noise that comes with a burning smell, sparking, or the appliance stopping is not a wait-and-see: stop using it. The diagnostic pinpoints the source on site.`,
  },
  {
    id: 'ind-sym-not-spinning',
    topic: 'Washer not spinning — common causes and safe checks',
    keywords: ['washer not spinning', 'not spinning', 'wont spin', 'washer not agitating', 'spin cycle', 'clothes soaking wet after wash'],
    answer:
      `A washer that will not spin or agitate commonly involves an unbalanced or oversized load (the machine protects itself), a lid or door switch that is not registering closed, a worn belt or drive parts, or a drain problem — most washers will not spin with water still in the tub. Safe checks: redistribute the load and try a drain-and-spin with a smaller load, and make sure the lid or door closes and latches cleanly. If it still will not spin, the technician tests the switch, belt, and drive at the diagnostic.`,
  },
];

/* ------------------------------ safety ------------------------------ */
/* Lead with getting safe. No DIY repair steps for hazardous work. */

const SAFETY_ENTRIES = [
  {
    id: 'ind-safety-gas',
    topic: 'SAFETY — gas smell or carbon monoxide concern',
    keywords: ['smell gas', 'gas smell', 'gas leak', 'smells like gas', 'rotten egg smell', 'carbon monoxide', 'co alarm', 'co detector'],
    safety: true,
    answer:
      `Stop — this is a safety situation, not a repair question. If you smell gas: do not touch electrical switches or appliances, leave the home now, and from outside call 911 or your gas utility. Do not try to find or fix the leak yourself, and do not re-enter until the utility or fire department says it is safe. The same goes for a carbon monoxide alarm: get everyone out and call 911. Once everyone is safe, call Top Speed at (844) 460-7038 — a human professional on our team takes it from there.`,
  },
  {
    id: 'ind-safety-electrical',
    topic: 'SAFETY — burning smell, sparking, or electric shock',
    keywords: ['burning smell', 'sparking', 'arcing', 'smell burning', 'electrical smell', 'shock', 'smoke', 'scorch', 'melted plug'],
    safety: true,
    answer:
      `Stop using the appliance right now. A burning smell, sparking, arcing, scorch marks, or any electric shock means the appliance comes out of service immediately: switch it off, and unplug it or switch off its breaker only if you can do that without touching anything damaged or wet. Do not open the appliance up and do not keep testing it. If there is smoke or flame, leave and call 911. Once you are safe, call Top Speed at (844) 460-7038 — this needs a human professional, and our team will take it from here.`,
  },
  {
    id: 'ind-safety-water',
    topic: 'SAFETY — flooding or water near electrical',
    keywords: ['flooding', 'flood', 'water pouring', 'water everywhere', 'burst hose', 'leak near electrical', 'water gushing', 'standing water'],
    safety: true,
    answer:
      `Treat active flooding as a safety situation first: water and electricity together are dangerous. If it is safe to do without standing in the water, turn off the water supply to the appliance and switch off its breaker; otherwise keep clear and call for help. Do not run the appliance, and do not touch plugs or switches with wet hands. Once the water is stopped and everyone is safe, call Top Speed at (844) 460-7038 and a human on our team will take it from there.`,
  },
  {
    id: 'ind-safety-refrigerant',
    topic: 'SAFETY — refrigerant concerns',
    keywords: ['refrigerant', 'refrigerant leak', 'freon', 'chemical smell from fridge', 'hissing fridge', 'coolant leak'],
    safety: true,
    answer:
      `Refrigerant work is licensed, human-professional work — full stop. If you suspect a refrigerant leak (a chemical smell, hissing, or oil around refrigerator lines), ventilate the room, do not try to open, recharge, or seal anything yourself, and keep the appliance off if it is behaving strangely. Call Top Speed at (844) 460-7038: a qualified technician handles sealed-system work in person, and no AI guidance substitutes for that.`,
  },
];

/* --------------------- guidance: upkeep & decisions --------------------- */

const GUIDANCE_ENTRIES = [
  {
    id: 'ind-maintenance-schedule',
    topic: 'Appliance maintenance schedule — what to do, and how often',
    keywords: [
      'maintenance', 'maintain', 'upkeep', 'how often', 'clean coils', 'condenser coils',
      'water filter', 'preventive', 'care tips', 'service schedule',
    ],
    answer:
      `The maintenance that prevents the most breakdowns: clean the refrigerator condenser coils and keep the dryer vent path clear about twice a year (a restricted dryer vent hurts performance and is a fire risk); replace the refrigerator water filter roughly every 6 months; clear the washer's pump filter and run a cleaning cycle periodically, and leave a front-loader's door ajar between loads to fight odor; clean the dishwasher filter regularly; check water supply hoses for bulges or cracks; and keep oven door seals clean so heat stays in. Top Speed's maintenance plans schedule seasonal checkups from your appliance registry so none of this lapses.`,
  },
  {
    id: 'ind-repair-or-replace',
    topic: 'Repair or replace? Lifespans and the rule of thumb',
    keywords: [
      'repair or replace', 'replace my', 'when should i replace', 'worth repairing',
      'how long do', 'lifespan', 'life expectancy', 'how old', 'buy a new one', 'new appliance worth it',
    ],
    answer:
      `The general industry rule of thumb: if a repair would cost more than about half the price of a comparable new appliance AND the unit is past roughly half its typical lifespan, replacement is often worth considering — with age, overall condition, parts availability, and energy efficiency all factoring in. Typical lifespans, as general ranges: refrigerator about 12–15 years, washer 10–14, dryer 10–13, oven/range 13–15, dishwasher 9–13, microwave about 9, garbage disposal 8–12. It is a way to think, never a decision made for you: the diagnostic gives you the real repair figure, and the comparison makes itself from there.`,
  },
  {
    id: 'ind-diagnostic-explained',
    topic: 'What a diagnostic visit is — how diagnosis works',
    keywords: [
      'diagnostic visit', 'what is a diagnostic', 'how does diagnosis work', 'what happens at the visit',
      'technician visit', 'what does the technician do', 'inspection',
    ],
    answer:
      `A diagnostic visit is how a repair gets an honest price: the technician inspects the appliance, tests the components the symptoms point to (motors, fans, sensors, controls, sealed systems), and identifies the actual failed part or cause — many symptoms share several possible causes, which is why phone guesses are unreliable. You then get the exact repair estimate in writing and approve it before any repair work starts. At Top Speed the residential diagnostic is $99, collected at booking and credited in full toward the approved repair.`,
  },
  {
    id: 'ind-energy-saving',
    topic: 'Energy & water saving basics for appliances',
    keywords: ['energy', 'save energy', 'electric bill', 'water saving', 'efficiency', 'power usage', 'energy star'],
    answer:
      `The basics that actually move an appliance's running cost: keep refrigerator coils clean and door seals tight, and hold about 37–38°F in the fridge and 0°F in the freezer (colder wastes energy without helping food); keep the dryer vent clear — a restricted vent makes the dryer run longer for the same load; run washers and dishwashers with full loads; and fix small leaks early, because a slow drip is water and money around the clock. These are general good practices, not a bill prediction — your usage and rates decide the numbers.`,
  },
];

/* ------------------------------ brands ------------------------------ */
/* Positioning-level and factual only. No reliability statistics, no
 * invented figures. Top Speed services all of them as an independent
 * repair service. */

const BRAND_FACTS = [
  ['Samsung', 'a Korean manufacturer with a large US presence across refrigeration, laundry, and cooking — French-door refrigerators and front-load laundry are its best-known lines.'],
  ['LG', 'a Korean manufacturer known for front-load laundry, refrigerators, and dishwashers, including linear-compressor refrigeration and steam laundry features.'],
  ['Whirlpool', 'one of the largest US appliance manufacturers, covering refrigeration, laundry, cooking, and dishwashers across several labels it owns.'],
  ['GE', 'GE Appliances, a long-standing US brand (part of Haier since 2016) spanning refrigeration, cooking, laundry, and dishwashers, including the Profile and Café lines.'],
  ['Frigidaire', 'a US brand owned by Electrolux, best known for refrigeration and cooking, including the Gallery and Professional lines.'],
  ['Maytag', 'a Whirlpool-owned brand positioned around durability and commercial-grade components in home laundry and refrigeration.'],
  ['KitchenAid', 'Whirlpool\'s premium-leaning label, best known for dishwashers, cooking appliances, and stand mixers.'],
  ['Bosch', 'a German manufacturer (BSH) best known in the US for very quiet dishwashers, plus built-in cooking and refrigeration.'],
  ['Electrolux', 'a Swedish manufacturer and the parent of Frigidaire, selling refrigeration, laundry, and cooking under its own name as well.'],
  ['Kenmore', 'the Sears house brand: Kenmore appliances were built by several different manufacturers over the years, so the model number — not the badge — decides parts and procedure.'],
  ['Sub-Zero', 'a premium US refrigeration specialist, known for built-in refrigerators and freezers with dual refrigeration and air purification.'],
  ['Wolf', 'the cooking arm of the Sub-Zero Group — premium ranges, ovens, and cooktops, including dual-fuel ranges.'],
  ['Viking', 'a premium US cooking brand known for professional-style ranges and ovens.'],
  ['Miele', 'a German premium manufacturer positioned around longevity, with dishwashers, laundry, and built-in cooking.'],
];

const BRAND_ENTRIES = BRAND_FACTS.map(([name, fact]) => ({
  id: `ind-brand-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  topic: `${name} appliances — brand note`,
  keywords: [name.toLowerCase(), `${name.toLowerCase()} repair`, `${name.toLowerCase()} service`, `${name.toLowerCase()} appliance`],
  answer:
    `${name} is ${fact} Top Speed services ${name} appliances as an independent repair service — we are not the manufacturer. The technician confirms the exact part for your model at the diagnostic, since configuration varies a lot inside any brand's line.`,
}));

export const INDUSTRY_PACK = [
  ...SERVICES_EXPLAINED,
  ...SYMPTOM_GUIDES,
  ...SAFETY_ENTRIES,
  ...GUIDANCE_ENTRIES,
  ...BRAND_ENTRIES,
];
