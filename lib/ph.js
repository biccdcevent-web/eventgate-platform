'use strict';
// Philippine locations for the address field: regions, provinces, cities/municipalities and barangays
// from the PSA's PSGC (2025-2Q), with ZIP codes from the PHLPost directory. Rebuild with tools/build-ph-address-data.py.
const LOCATIONS = require('./ph/ph-locations.json');
const BARANGAYS = require('./ph/ph-barangays.json');

const regions = new Map();
const cityById = new Map();
for (const r of LOCATIONS.regions) {
  const provinces = new Map();
  for (const p of r.p) {
    const cities = new Map();
    for (const c of p.c) { cities.set(c.n, c); cityById.set(c.id, { ...c, province: p.n, region: r.n }); }
    provinces.set(p.n, cities);
  }
  regions.set(r.n, provinces);
}

const locationsJson = JSON.stringify(LOCATIONS);
const barangaysOf = (cityId) => BARANGAYS[cityId] || null;

// Checks that the chosen places belong together. Returns an error message, or '' when fine.
function verify(parts) {
  const provinces = regions.get(parts.region);
  if (!provinces) return 'Choose a region.';
  const cities = provinces.get(parts.province);
  if (!cities) return 'Choose a province.';
  const city = cities.get(parts.city);
  if (!city) return 'Choose a city or municipality.';
  const brgys = BARANGAYS[city.id] || [];
  if (!brgys.includes(parts.barangay)) return 'Choose a barangay.';
  if (city.z.length && !city.z.some(([z]) => z === parts.zip)) return 'Choose the postal code for this city or municipality.';
  return '';
}

module.exports = { locationsJson, barangaysOf, verify, source: LOCATIONS.source };
