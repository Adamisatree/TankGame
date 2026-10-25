import type { Manifest } from './update-core.mjs';

export interface ManifestCandidate {
  id: string;
  label?: string;
  url: string;
}

export interface ManifestRaceResult {
  manifest: Manifest | null;
  source: ManifestCandidate | null;
  errors: string[];
  answered: string[];
}

export function raceManifestFetch(
  candidates: ManifestCandidate[],
  options?: {
    fetchImpl?: typeof fetch;
    graceMs?: number;
    timeoutMs?: number;
    normalize?: (payload: unknown) => Manifest;
  }
): Promise<ManifestRaceResult>;
