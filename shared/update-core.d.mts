export interface Mirror {
  id: string;
  label: string;
  prefix: string;
}

export interface AssetInfo {
  name: string;
  size: number;
  sha256: string;
  url: string;
  kind: 'installer' | 'portable' | 'dmg' | 'zip' | 'html' | 'other';
  platform: 'win32' | 'darwin' | 'any';
  arch: 'x64' | 'arm64' | 'any';
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  notes: string;
  publishedAt: string;
  prerelease: boolean;
  assets: AssetInfo[];
}

export interface Manifest {
  generatedAt: string;
  releases: ReleaseInfo[];
}

export interface UrlCandidate {
  id: string;
  label: string;
  url: string;
  mirrored: boolean;
}

export const REPO: string;
export const REPO_URL: string;
export const OFFICIAL: {
  releasesApi: string;
  latestApi: string;
  manifestRaw: string;
  releaseDownload: string;
  releasePage: string;
};

export function parseVersion(value: string): { major: number; minor: number; patch: number; pre: string };
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function isNewer(candidate: string, current: string): boolean;
export function classifyAsset(name: string): Pick<AssetInfo, 'kind' | 'platform' | 'arch'>;
export function pickAssetFor(assets: { name: string }[], target: { platform: string; arch: string }): AssetInfo | null;
export function findPortableHtml(assets: AssetInfo[]): AssetInfo | null;
export function isGithubUrl(url: string): boolean;
export function applyMirror(url: string, mirror: Mirror): string;
export function urlCandidates(url: string, mirrors: Mirror[], preferredId?: string): UrlCandidate[];
export function normalizeManifest(payload: unknown): Manifest;
export function latestRelease(manifest: Manifest): ReleaseInfo | null;
export function versionFromAssetName(name: string): string;
export function groupLocalAssets(files: { name: string; size?: number; path?: string }[]): {
  version: string;
  size: number;
  assets: (AssetInfo & { path: string })[];
}[];
export function formatBytes(bytes: number): string;
export function expectedAssetName(options: { version: string; kind: string; arch?: string }): string;
