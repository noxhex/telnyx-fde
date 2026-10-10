/**
 * The five Duinvezel service areas (docs/ARCHITECTURE.md). Postcode keys are
 * exactly four digits, which is why they can go straight into
 * `kvKeys.areaStatus`. T08 reads the status of all five at call setup; T09
 * validates `check_area_status` input against them and takes the area name
 * from here, so every function speaks of the areas in one voice.
 */

export interface Area {
  postcode: string;
  name: string;
}

/** Declaration order is read order: the five status reads at call setup go out in this sequence. */
export const AREAS: readonly Area[] = Object.freeze(
  [
    { postcode: "8620", name: "Nieuwpoort" },
    { postcode: "8630", name: "Veurne" },
    { postcode: "8660", name: "De Panne" },
    { postcode: "8670", name: "Koksijde" },
    { postcode: "8600", name: "Diksmuide" },
  ].map((area) => Object.freeze(area)),
);

const BY_POSTCODE: ReadonlyMap<string, string> = new Map(
  AREAS.map((area) => [area.postcode, area.name]),
);

/** The area name for a four-digit postcode, or null when Duinvezel has no fibre there. */
export function areaNameForPostcode(postcode: string): string | null {
  return BY_POSTCODE.get(postcode) ?? null;
}
