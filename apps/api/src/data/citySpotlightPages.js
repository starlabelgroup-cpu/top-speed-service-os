/**
 * City Spotlight — the VERIFIED published landing pages (2026-11-23).
 *
 * Baked at build time from the platform's own published-pages record
 * (GET /api/v1/marketing-os/pages — the Marketing OS store of record)
 * with every canonical URL live-probed against production: only pages
 * that returned HTTP 200 are listed here. The platform's coverage
 * copy claims 131 published pages (data/expansionCities.js
 * pagesBefore); the live store holds 124 PUBLISHED landing pages —
 * 65 CITY + 59 SERVICE — and all 124 resolve. The 7-page difference
 * is claim arithmetic with no URLs behind it (see
 * city-posts-strategy-2026-11-23.md). This list is the generator's
 * whole world: a post exists only for a page listed here, and its
 * link is that page's own canonical URL (Rule 1).
 *
 * Canonical URLs live on topspeedappliance.net — the Marketing OS
 * face's own SITE_BASE (routes/marketingOs.js). The same paths on
 * topspeedserviceos.com return 404; the flagship does not serve
 * these pages.
 *
 * Regenerate by re-reading the published-pages endpoint and
 * re-probing; never hand-add a page that does not resolve.
 */
export const CITY_SPOTLIGHT_PAGES = [
  {
    "kind": "CITY",
    "slug": "service-areas/aventura",
    "city": "Aventura",
    "citySlug": "aventura",
    "url": "https://topspeedappliance.net/service-areas/aventura/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/bal-harbour",
    "city": "Bal Harbour",
    "citySlug": "bal-harbour",
    "url": "https://topspeedappliance.net/service-areas/bal-harbour/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/belle-glade",
    "city": "Belle Glade",
    "citySlug": "belle-glade",
    "url": "https://topspeedappliance.net/service-areas/belle-glade/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/boca-raton",
    "city": "Boca Raton",
    "citySlug": "boca-raton",
    "url": "https://topspeedappliance.net/service-areas/boca-raton/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/boynton-beach",
    "city": "Boynton Beach",
    "citySlug": "boynton-beach",
    "url": "https://topspeedappliance.net/service-areas/boynton-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/coconut-creek",
    "city": "Coconut Creek",
    "citySlug": "coconut-creek",
    "url": "https://topspeedappliance.net/service-areas/coconut-creek/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/cooper-city",
    "city": "Cooper City",
    "citySlug": "cooper-city",
    "url": "https://topspeedappliance.net/service-areas/cooper-city/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/coral-gables",
    "city": "Coral Gables",
    "citySlug": "coral-gables",
    "url": "https://topspeedappliance.net/service-areas/coral-gables/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/coral-springs",
    "city": "Coral Springs",
    "citySlug": "coral-springs",
    "url": "https://topspeedappliance.net/service-areas/coral-springs/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/cutler-bay",
    "city": "Cutler Bay",
    "citySlug": "cutler-bay",
    "url": "https://topspeedappliance.net/service-areas/cutler-bay/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/dania-beach",
    "city": "Dania Beach",
    "citySlug": "dania-beach",
    "url": "https://topspeedappliance.net/service-areas/dania-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/davie",
    "city": "Davie",
    "citySlug": "davie",
    "url": "https://topspeedappliance.net/service-areas/davie/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/deerfield-beach",
    "city": "Deerfield Beach",
    "citySlug": "deerfield-beach",
    "url": "https://topspeedappliance.net/service-areas/deerfield-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/delray-beach",
    "city": "Delray Beach",
    "citySlug": "delray-beach",
    "url": "https://topspeedappliance.net/service-areas/delray-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/doral",
    "city": "Doral",
    "citySlug": "doral",
    "url": "https://topspeedappliance.net/service-areas/doral/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/florida-city",
    "city": "Florida City",
    "citySlug": "florida-city",
    "url": "https://topspeedappliance.net/service-areas/florida-city/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/fort-lauderdale",
    "city": "Fort Lauderdale",
    "citySlug": "fort-lauderdale",
    "url": "https://topspeedappliance.net/service-areas/fort-lauderdale/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/greenacres",
    "city": "Greenacres",
    "citySlug": "greenacres",
    "url": "https://topspeedappliance.net/service-areas/greenacres/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/hallandale-beach",
    "city": "Hallandale Beach",
    "citySlug": "hallandale-beach",
    "url": "https://topspeedappliance.net/service-areas/hallandale-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/hialeah",
    "city": "Hialeah",
    "citySlug": "hialeah",
    "url": "https://topspeedappliance.net/service-areas/hialeah/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/hialeah-gardens",
    "city": "Hialeah Gardens",
    "citySlug": "hialeah-gardens",
    "url": "https://topspeedappliance.net/service-areas/hialeah-gardens/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/hillsboro-beach",
    "city": "Hillsboro Beach",
    "citySlug": "hillsboro-beach",
    "url": "https://topspeedappliance.net/service-areas/hillsboro-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/hollywood",
    "city": "Hollywood",
    "citySlug": "hollywood",
    "url": "https://topspeedappliance.net/service-areas/hollywood/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/homestead",
    "city": "Homestead",
    "citySlug": "homestead",
    "url": "https://topspeedappliance.net/service-areas/homestead/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/jupiter",
    "city": "Jupiter",
    "citySlug": "jupiter",
    "url": "https://topspeedappliance.net/service-areas/jupiter/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/key-biscayne",
    "city": "Key Biscayne",
    "citySlug": "key-biscayne",
    "url": "https://topspeedappliance.net/service-areas/key-biscayne/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/lake-park",
    "city": "Lake Park",
    "citySlug": "lake-park",
    "url": "https://topspeedappliance.net/service-areas/lake-park/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/lake-worth-beach",
    "city": "Lake Worth Beach",
    "citySlug": "lake-worth-beach",
    "url": "https://topspeedappliance.net/service-areas/lake-worth-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/lauderdale-by-the-sea",
    "city": "Lauderdale-by-the-Sea",
    "citySlug": "lauderdale-by-the-sea",
    "url": "https://topspeedappliance.net/service-areas/lauderdale-by-the-sea/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/lauderdale-lakes",
    "city": "Lauderdale Lakes",
    "citySlug": "lauderdale-lakes",
    "url": "https://topspeedappliance.net/service-areas/lauderdale-lakes/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/lauderhill",
    "city": "Lauderhill",
    "citySlug": "lauderhill",
    "url": "https://topspeedappliance.net/service-areas/lauderhill/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/lazy-lake",
    "city": "Lazy Lake",
    "citySlug": "lazy-lake",
    "url": "https://topspeedappliance.net/service-areas/lazy-lake/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/lighthouse-point",
    "city": "Lighthouse Point",
    "citySlug": "lighthouse-point",
    "url": "https://topspeedappliance.net/service-areas/lighthouse-point/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/margate",
    "city": "Margate",
    "citySlug": "margate",
    "url": "https://topspeedappliance.net/service-areas/margate/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/miami",
    "city": "Miami",
    "citySlug": "miami",
    "url": "https://topspeedappliance.net/service-areas/miami/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/miami-beach",
    "city": "Miami Beach",
    "citySlug": "miami-beach",
    "url": "https://topspeedappliance.net/service-areas/miami-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/miami-gardens",
    "city": "Miami Gardens",
    "citySlug": "miami-gardens",
    "url": "https://topspeedappliance.net/service-areas/miami-gardens/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/miramar",
    "city": "Miramar",
    "citySlug": "miramar",
    "url": "https://topspeedappliance.net/service-areas/miramar/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/north-lauderdale",
    "city": "North Lauderdale",
    "citySlug": "north-lauderdale",
    "url": "https://topspeedappliance.net/service-areas/north-lauderdale/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/north-miami",
    "city": "North Miami",
    "citySlug": "north-miami",
    "url": "https://topspeedappliance.net/service-areas/north-miami/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/north-miami-beach",
    "city": "North Miami Beach",
    "citySlug": "north-miami-beach",
    "url": "https://topspeedappliance.net/service-areas/north-miami-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/north-palm-beach",
    "city": "North Palm Beach",
    "citySlug": "north-palm-beach",
    "url": "https://topspeedappliance.net/service-areas/north-palm-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/oakland-park",
    "city": "Oakland Park",
    "citySlug": "oakland-park",
    "url": "https://topspeedappliance.net/service-areas/oakland-park/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/palm-beach",
    "city": "Palm Beach",
    "citySlug": "palm-beach",
    "url": "https://topspeedappliance.net/service-areas/palm-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/palm-beach-gardens",
    "city": "Palm Beach Gardens",
    "citySlug": "palm-beach-gardens",
    "url": "https://topspeedappliance.net/service-areas/palm-beach-gardens/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/palm-springs",
    "city": "Palm Springs",
    "citySlug": "palm-springs",
    "url": "https://topspeedappliance.net/service-areas/palm-springs/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/parkland",
    "city": "Parkland",
    "citySlug": "parkland",
    "url": "https://topspeedappliance.net/service-areas/parkland/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/pembroke-park",
    "city": "Pembroke Park",
    "citySlug": "pembroke-park",
    "url": "https://topspeedappliance.net/service-areas/pembroke-park/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/pembroke-pines",
    "city": "Pembroke Pines",
    "citySlug": "pembroke-pines",
    "url": "https://topspeedappliance.net/service-areas/pembroke-pines/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/plantation",
    "city": "Plantation",
    "citySlug": "plantation",
    "url": "https://topspeedappliance.net/service-areas/plantation/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/pompano-beach",
    "city": "Pompano Beach",
    "citySlug": "pompano-beach",
    "url": "https://topspeedappliance.net/service-areas/pompano-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/riviera-beach",
    "city": "Riviera Beach",
    "citySlug": "riviera-beach",
    "url": "https://topspeedappliance.net/service-areas/riviera-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/royal-palm-beach",
    "city": "Royal Palm Beach",
    "citySlug": "royal-palm-beach",
    "url": "https://topspeedappliance.net/service-areas/royal-palm-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/sea-ranch-lakes",
    "city": "Sea Ranch Lakes",
    "citySlug": "sea-ranch-lakes",
    "url": "https://topspeedappliance.net/service-areas/sea-ranch-lakes/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/southwest-ranches",
    "city": "Southwest Ranches",
    "citySlug": "southwest-ranches",
    "url": "https://topspeedappliance.net/service-areas/southwest-ranches/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/sunny-isles-beach",
    "city": "Sunny Isles Beach",
    "citySlug": "sunny-isles-beach",
    "url": "https://topspeedappliance.net/service-areas/sunny-isles-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/sunrise",
    "city": "Sunrise",
    "citySlug": "sunrise",
    "url": "https://topspeedappliance.net/service-areas/sunrise/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/surfside",
    "city": "Surfside",
    "citySlug": "surfside",
    "url": "https://topspeedappliance.net/service-areas/surfside/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/sweetwater",
    "city": "Sweetwater",
    "citySlug": "sweetwater",
    "url": "https://topspeedappliance.net/service-areas/sweetwater/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/tamarac",
    "city": "Tamarac",
    "citySlug": "tamarac",
    "url": "https://topspeedappliance.net/service-areas/tamarac/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/wellington",
    "city": "Wellington",
    "citySlug": "wellington",
    "url": "https://topspeedappliance.net/service-areas/wellington/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/west-palm-beach",
    "city": "West Palm Beach",
    "citySlug": "west-palm-beach",
    "url": "https://topspeedappliance.net/service-areas/west-palm-beach/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/west-park",
    "city": "West Park",
    "citySlug": "west-park",
    "url": "https://topspeedappliance.net/service-areas/west-park/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/weston",
    "city": "Weston",
    "citySlug": "weston",
    "url": "https://topspeedappliance.net/service-areas/weston/"
  },
  {
    "kind": "CITY",
    "slug": "service-areas/wilton-manors",
    "city": "Wilton Manors",
    "citySlug": "wilton-manors",
    "url": "https://topspeedappliance.net/service-areas/wilton-manors/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/appliance-installation",
    "service": "Installation",
    "serviceSlug": "appliance-installation",
    "commercial": false,
    "installation": true,
    "url": "https://topspeedappliance.net/services/appliance-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-appliance-installation",
    "service": "Commercial Appliance Installation",
    "serviceSlug": "commercial-appliance-installation",
    "commercial": true,
    "installation": true,
    "url": "https://topspeedappliance.net/services/commercial-appliance-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-appliance-repair",
    "service": "Commercial Appliance Repair",
    "serviceSlug": "commercial-appliance-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-appliance-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-cooking-equipment-installation",
    "service": "Commercial Cooking Equipment Installation",
    "serviceSlug": "commercial-cooking-equipment-installation",
    "commercial": true,
    "installation": true,
    "url": "https://topspeedappliance.net/services/commercial-cooking-equipment-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-cooking-equipment-repair",
    "service": "Commercial Cooking Equipment",
    "serviceSlug": "commercial-cooking-equipment-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-cooking-equipment-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-dishwashing-installation",
    "service": "Commercial Dishwashing Installation",
    "serviceSlug": "commercial-dishwashing-installation",
    "commercial": true,
    "installation": true,
    "url": "https://topspeedappliance.net/services/commercial-dishwashing-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-dishwashing-repair",
    "service": "Commercial Dishwashing",
    "serviceSlug": "commercial-dishwashing-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-dishwashing-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-laundry-installation",
    "service": "Commercial Laundry Installation",
    "serviceSlug": "commercial-laundry-installation",
    "commercial": true,
    "installation": true,
    "url": "https://topspeedappliance.net/services/commercial-laundry-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-laundry-repair",
    "service": "Commercial Laundry",
    "serviceSlug": "commercial-laundry-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-laundry-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-refrigeration-installation",
    "service": "Commercial Refrigeration Installation",
    "serviceSlug": "commercial-refrigeration-installation",
    "commercial": true,
    "installation": true,
    "url": "https://topspeedappliance.net/services/commercial-refrigeration-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-refrigeration-repair",
    "service": "Commercial Refrigeration",
    "serviceSlug": "commercial-refrigeration-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-refrigeration-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-trash-and-beverage-equipment-installation",
    "service": "Commercial Trash & Beverage Equipment Installation",
    "serviceSlug": "commercial-trash-and-beverage-equipment-installation",
    "commercial": true,
    "installation": true,
    "url": "https://topspeedappliance.net/services/commercial-trash-and-beverage-equipment-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/commercial-trash-beverage-equipment-repair",
    "service": "Commercial Trash & Beverage Equipment",
    "serviceSlug": "commercial-trash-beverage-equipment-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-trash-beverage-equipment-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/cooktop-installation",
    "service": "Cooktop Installation",
    "serviceSlug": "cooktop-installation",
    "commercial": false,
    "installation": true,
    "url": "https://topspeedappliance.net/services/cooktop-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/dishwasher-installation",
    "service": "Dishwasher Installation",
    "serviceSlug": "dishwasher-installation",
    "commercial": false,
    "installation": true,
    "url": "https://topspeedappliance.net/services/dishwasher-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/dishwasher-repair",
    "service": "Dishwasher",
    "serviceSlug": "dishwasher-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/dishwasher-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/dryer-installation",
    "service": "Dryer Installation",
    "serviceSlug": "dryer-installation",
    "commercial": false,
    "installation": true,
    "url": "https://topspeedappliance.net/services/dryer-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/dryer-repair",
    "service": "Dryer",
    "serviceSlug": "dryer-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/dryer-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/freezer-ice-maker-installation",
    "service": "Freezer & Ice Maker Installation",
    "serviceSlug": "freezer-ice-maker-installation",
    "commercial": false,
    "installation": true,
    "url": "https://topspeedappliance.net/services/freezer-ice-maker-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/freezer-ice-maker-repair",
    "service": "Freezer/Ice Maker",
    "serviceSlug": "freezer-ice-maker-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/freezer-ice-maker-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/garbage-disposal-installation",
    "service": "Garbage Disposal Installation",
    "serviceSlug": "garbage-disposal-installation",
    "commercial": false,
    "installation": true,
    "url": "https://topspeedappliance.net/services/garbage-disposal-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/garbage-disposal-repair",
    "service": "Garbage Disposal",
    "serviceSlug": "garbage-disposal-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/garbage-disposal-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/microwave-installation",
    "service": "Microwave Installation",
    "serviceSlug": "microwave-installation",
    "commercial": false,
    "installation": true,
    "url": "https://topspeedappliance.net/services/microwave-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/microwave-repair",
    "service": "Microwave",
    "serviceSlug": "microwave-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/microwave-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/oven-range-installation",
    "service": "Oven & Range Installation",
    "serviceSlug": "oven-range-installation",
    "commercial": false,
    "installation": true,
    "url": "https://topspeedappliance.net/services/oven-range-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/oven-range-repair",
    "service": "Oven/Range",
    "serviceSlug": "oven-range-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/oven-range-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/refrigerator-installation",
    "service": "Refrigerator Installation",
    "serviceSlug": "refrigerator-installation",
    "commercial": false,
    "installation": true,
    "url": "https://topspeedappliance.net/services/refrigerator-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/refrigerator-repair",
    "service": "Refrigerator",
    "serviceSlug": "refrigerator-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/refrigerator-repair/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/washer-installation",
    "service": "Washer Installation",
    "serviceSlug": "washer-installation",
    "commercial": false,
    "installation": true,
    "url": "https://topspeedappliance.net/services/washer-installation/"
  },
  {
    "kind": "SERVICE",
    "slug": "services/washer-repair",
    "service": "Washer",
    "serviceSlug": "washer-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/washer-repair/"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/commercial-cooking-equipment-repair/error-codes",
    "service": "Commercial Cooking Equipment",
    "serviceSlug": "commercial-cooking-equipment-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-cooking-equipment-repair/error-codes/",
    "symptomSlug": "error-codes",
    "symptom": "Error codes"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/commercial-cooking-equipment-repair/not-heating",
    "service": "Commercial Cooking Equipment",
    "serviceSlug": "commercial-cooking-equipment-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-cooking-equipment-repair/not-heating/",
    "symptomSlug": "not-heating",
    "symptom": "Not heating"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/commercial-dishwashing-repair/leaking",
    "service": "Commercial Dishwashing",
    "serviceSlug": "commercial-dishwashing-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-dishwashing-repair/leaking/",
    "symptomSlug": "leaking",
    "symptom": "Leaking"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/commercial-dishwashing-repair/not-draining",
    "service": "Commercial Dishwashing",
    "serviceSlug": "commercial-dishwashing-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-dishwashing-repair/not-draining/",
    "symptomSlug": "not-draining",
    "symptom": "Not draining"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/commercial-laundry-repair/not-draining",
    "service": "Commercial Laundry",
    "serviceSlug": "commercial-laundry-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-laundry-repair/not-draining/",
    "symptomSlug": "not-draining",
    "symptom": "Not draining"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/commercial-laundry-repair/not-heating",
    "service": "Commercial Laundry",
    "serviceSlug": "commercial-laundry-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-laundry-repair/not-heating/",
    "symptomSlug": "not-heating",
    "symptom": "Not heating"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/commercial-refrigeration-repair/leaking",
    "service": "Commercial Refrigeration",
    "serviceSlug": "commercial-refrigeration-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-refrigeration-repair/leaking/",
    "symptomSlug": "leaking",
    "symptom": "Leaking"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/commercial-refrigeration-repair/not-cooling",
    "service": "Commercial Refrigeration",
    "serviceSlug": "commercial-refrigeration-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-refrigeration-repair/not-cooling/",
    "symptomSlug": "not-cooling",
    "symptom": "Not cooling"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/commercial-trash-beverage-equipment-repair/leaking",
    "service": "Commercial Trash & Beverage Equipment",
    "serviceSlug": "commercial-trash-beverage-equipment-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-trash-beverage-equipment-repair/leaking/",
    "symptomSlug": "leaking",
    "symptom": "Leaking"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/commercial-trash-beverage-equipment-repair/not-cooling",
    "service": "Commercial Trash & Beverage Equipment",
    "serviceSlug": "commercial-trash-beverage-equipment-repair",
    "commercial": true,
    "installation": false,
    "url": "https://topspeedappliance.net/services/commercial-trash-beverage-equipment-repair/not-cooling/",
    "symptomSlug": "not-cooling",
    "symptom": "Not cooling"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/dishwasher-repair/error-codes",
    "service": "Dishwasher",
    "serviceSlug": "dishwasher-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/dishwasher-repair/error-codes/",
    "symptomSlug": "error-codes",
    "symptom": "Error codes"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/dishwasher-repair/leaking",
    "service": "Dishwasher",
    "serviceSlug": "dishwasher-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/dishwasher-repair/leaking/",
    "symptomSlug": "leaking",
    "symptom": "Leaking"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/dishwasher-repair/not-draining",
    "service": "Dishwasher",
    "serviceSlug": "dishwasher-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/dishwasher-repair/not-draining/",
    "symptomSlug": "not-draining",
    "symptom": "Not draining"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/dishwasher-repair/unusual-noises",
    "service": "Dishwasher",
    "serviceSlug": "dishwasher-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/dishwasher-repair/unusual-noises/",
    "symptomSlug": "unusual-noises",
    "symptom": "Unusual noises"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/dryer-repair/error-codes",
    "service": "Dryer",
    "serviceSlug": "dryer-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/dryer-repair/error-codes/",
    "symptomSlug": "error-codes",
    "symptom": "Error codes"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/dryer-repair/not-heating",
    "service": "Dryer",
    "serviceSlug": "dryer-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/dryer-repair/not-heating/",
    "symptomSlug": "not-heating",
    "symptom": "Not heating"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/freezer-ice-maker-repair/leaking",
    "service": "Freezer/Ice Maker",
    "serviceSlug": "freezer-ice-maker-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/freezer-ice-maker-repair/leaking/",
    "symptomSlug": "leaking",
    "symptom": "Leaking"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/freezer-ice-maker-repair/no-ice",
    "service": "Freezer/Ice Maker",
    "serviceSlug": "freezer-ice-maker-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/freezer-ice-maker-repair/no-ice/",
    "symptomSlug": "no-ice",
    "symptom": "No ice"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/freezer-ice-maker-repair/not-cooling",
    "service": "Freezer/Ice Maker",
    "serviceSlug": "freezer-ice-maker-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/freezer-ice-maker-repair/not-cooling/",
    "symptomSlug": "not-cooling",
    "symptom": "Not cooling"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/garbage-disposal-repair/leaking",
    "service": "Garbage Disposal",
    "serviceSlug": "garbage-disposal-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/garbage-disposal-repair/leaking/",
    "symptomSlug": "leaking",
    "symptom": "Leaking"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/garbage-disposal-repair/not-draining",
    "service": "Garbage Disposal",
    "serviceSlug": "garbage-disposal-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/garbage-disposal-repair/not-draining/",
    "symptomSlug": "not-draining",
    "symptom": "Not draining"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/garbage-disposal-repair/unusual-noises",
    "service": "Garbage Disposal",
    "serviceSlug": "garbage-disposal-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/garbage-disposal-repair/unusual-noises/",
    "symptomSlug": "unusual-noises",
    "symptom": "Unusual noises"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/microwave-repair/error-codes",
    "service": "Microwave",
    "serviceSlug": "microwave-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/microwave-repair/error-codes/",
    "symptomSlug": "error-codes",
    "symptom": "Error codes"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/microwave-repair/not-heating",
    "service": "Microwave",
    "serviceSlug": "microwave-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/microwave-repair/not-heating/",
    "symptomSlug": "not-heating",
    "symptom": "Not heating"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/microwave-repair/unusual-noises",
    "service": "Microwave",
    "serviceSlug": "microwave-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/microwave-repair/unusual-noises/",
    "symptomSlug": "unusual-noises",
    "symptom": "Unusual noises"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/oven-range-repair/error-codes",
    "service": "Oven/Range",
    "serviceSlug": "oven-range-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/oven-range-repair/error-codes/",
    "symptomSlug": "error-codes",
    "symptom": "Error codes"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/oven-range-repair/not-heating",
    "service": "Oven/Range",
    "serviceSlug": "oven-range-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/oven-range-repair/not-heating/",
    "symptomSlug": "not-heating",
    "symptom": "Not heating"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/refrigerator-repair/not-cooling",
    "service": "Refrigerator",
    "serviceSlug": "refrigerator-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/refrigerator-repair/not-cooling/",
    "symptomSlug": "not-cooling",
    "symptom": "Not cooling"
  },
  {
    "kind": "SYMPTOM",
    "slug": "services/washer-repair/not-draining",
    "service": "Washer",
    "serviceSlug": "washer-repair",
    "commercial": false,
    "installation": false,
    "url": "https://topspeedappliance.net/services/washer-repair/not-draining/",
    "symptomSlug": "not-draining",
    "symptom": "Not draining"
  }
];
