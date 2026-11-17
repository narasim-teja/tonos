import type { CodeSystem } from "fhir/r4";
import { CODES, PROJECT_URL, SYSTEMS } from "./codes";

/**
 * The project-local codes as a FHIR CodeSystem, published at docs/fhir/ so validators and
 * receivers can resolve them. A test keeps the committed file in sync with src/codes.ts.
 */
export function localCodeSystem(): CodeSystem {
  const concepts = Object.values(CODES).filter(entry => entry.system === SYSTEMS.local);
  return {
    resourceType: "CodeSystem",
    id: "wearable-metrics",
    url: SYSTEMS.local,
    version: "0.1.0",
    name: "WearableMetrics",
    title: "Wearable metrics without a standard code",
    status: "draft",
    experimental: true,
    publisher: PROJECT_URL,
    description: "Codes for wearable measurements that LOINC and the HL7 PHR IG do not cover (heart rate variability as RMSSD), and for WHOOP's proprietary scores, which are vendor-derived and not clinical measurements.",
    caseSensitive: true,
    content: "complete",
    count: concepts.length,
    concept: concepts.map(entry => ({ code: entry.code, display: entry.display, ...(entry.note ? { definition: entry.note } : {}) })),
  };
}
