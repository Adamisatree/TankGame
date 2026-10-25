import type { AssetInfo, Manifest, Mirror, ReleaseInfo } from '../../shared/update-core.mjs';

export interface UpdateInfo {
  version: string;
  platform: string;
  arch: string;
  isPackaged?: boolean;
  autoCheck: boolean;
  mirrorId: string;
  skippedVersion: string;
  lastCheckAt: number;
  mirrors: Mirror[];
  rawMirrors: Mirror[];
  repo: string;
}

export interface ProbeEntry {
  id: string;
  label: string;
  ms: number | null;
}

export interface CheckResult {
  ok: boolean;
  errors?: string[];
  current?: string;
  manifest?: Manifest;
  source?: { id: string; label: string; url: string } | null;
  latest?: ReleaseInfo | null;
  upToDate?: boolean;
  assets?: AssetInfo[];
}

export interface LocalVersion {
  version: string;
  size: number;
  assets: (AssetInfo & { path: string })[];
}

export interface DownloadResult {
  ok: boolean;
  errors?: string[];
  cached?: boolean;
  path?: string;
  sha256?: string;
  source?: { id: string; label: string };
  error?: string;
}

export interface InstallResult {
  ok: boolean;
  launched?: boolean;
  file?: string;
  mode?: 'silent-install' | 'portable' | 'manual';
  error?: string;
}

export interface ProgressPayload {
  assetName: string;
  received: number;
  total: number;
  ratio: number;
}

export interface UpdateBridge {
  info: () => Promise<UpdateInfo>;
  check: (options?: { mirrorId?: string }) => Promise<CheckResult>;
  probeMirrors: () => Promise<{ ranked: ProbeEntry[] }>;
  download: (payload: {
    version: string;
    assetName: string;
    url?: string;
    sha256?: string;
    size?: number;
  }) => Promise<DownloadResult>;
  install: () => Promise<InstallResult>;
  localVersions: () => Promise<{ dir: string; versions: LocalVersion[] }>;
  installFile: (payload: { path: string }) => Promise<InstallResult>;
  reveal: (filePath?: string) => Promise<boolean>;
  saveSettings: (patch: Record<string, unknown>) => Promise<UpdateInfo>;
  openRelease: (version?: string) => Promise<boolean>;
  onProgress: (handler: (payload: ProgressPayload) => void) => () => void;
  onProbe: (handler: (entry: ProbeEntry) => void) => () => void;
  onAvailable: (handler: (payload: { version: string; notes: string }) => void) => () => void;
}

declare global {
  interface Window {
    tankGame?: {
      isDesktop?: boolean;
      scanLan?: () => Promise<{ name: string; host: string; port: number }[]>;
      update?: UpdateBridge;
    };
  }
}

export {};
