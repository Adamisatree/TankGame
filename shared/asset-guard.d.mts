/**
 * Types for `shared/asset-guard.mjs` (v1.6.3).
 *
 * The guard is plain ESM with JSDoc only; the test suite imports it directly, so
 * it needs declarations like the other `shared/*.mjs` modules have.
 */

/** A manifest asset name we are willing to write: a plain file name, else ''. */
export function safeAssetName(name: unknown): string;

/**
 * True when `url` is the official release-asset URL for `repo`, or a known
 * mirror prefix in front of exactly that URL.
 */
export function assetUrlAllowed(
  url: string,
  options: { hosts: Set<string> | string[]; repo: string }
): boolean;
