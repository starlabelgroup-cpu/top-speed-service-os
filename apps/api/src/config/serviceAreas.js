export const SERVICE_AREAS = [
  { city: 'Lauderhill', zips: ['33313', '33319', '33351'] },
  { city: 'Plantation', zips: ['33313', '33317', '33322', '33323', '33324', '33325', '33388'] },
  { city: 'Sunrise', zips: ['33313', '33322', '33323', '33326', '33351'] },
  { city: 'Tamarac', zips: ['33309', '33319', '33321', '33351', '33359'] },
  {
    city: 'Fort Lauderdale',
    zips: ['33301', '33302', '33303', '33304', '33305', '33306', '33307', '33308', '33309', '33311', '33312', '33313', '33314', '33315', '33316', '33317', '33319', '33334'],
  },
  { city: 'Lauderdale Lakes', zips: ['33309', '33311', '33313', '33319'] },
  { city: 'North Lauderdale', zips: ['33068', '33319'] },
  { city: 'Davie', zips: ['33312', '33314', '33317', '33324', '33325', '33326', '33328', '33329', '33330', '33331', '33332'] },
  { city: 'Coral Springs', zips: ['33065', '33067', '33071', '33073', '33075', '33076', '33077'] },
  { city: 'Pompano Beach', zips: ['33060', '33061', '33062', '33063', '33064', '33066', '33067', '33068', '33069', '33072', '33073', '33074'] },
  { city: 'Oakland Park', zips: ['33309', '33311', '33334'] },
  { city: 'Margate', zips: ['33063', '33068', '33073', '33093'] },
];

export const SERVICE_CITIES = SERVICE_AREAS.map(({ city }) => city);
export const SERVICE_ZIPS = new Set(SERVICE_AREAS.flatMap(({ zips }) => zips));

export function findServiceArea({ city, zip }) {
  return SERVICE_AREAS.find((area) => area.zips.includes(zip) && (!city || area.city === city));
}

export function areasForZip(zip) {
  return SERVICE_AREAS.filter((area) => area.zips.includes(zip)).map(({ city }) => city);
}
