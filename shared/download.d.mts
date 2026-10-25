export interface DownloadCandidate {
  id: string;
  label?: string;
  url: string;
}

export interface DownloadProgress {
  received: number;
  total: number;
  url: string;
  id: string;
}

export interface DownloadResult {
  ok: boolean;
  path: string;
  sha256: string;
  size: number;
  source: DownloadCandidate | null;
  /** True when `expectedSha` was supplied and matched the bytes on disk. */
  verified: boolean;
  errors: string[];
}

export function downloadWithFallback(
  url: string,
  destPath: string,
  options?: {
    candidates?: DownloadCandidate[];
    expectedSha?: string;
    timeoutMs?: number;
    onProgress?: (info: DownloadProgress) => void;
    fetchImpl?: typeof fetch;
  }
): Promise<DownloadResult>;

export function measureLatency(
  url: string,
  options?: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    headers?: Record<string, string>;
    /** Stop after the first chunk — safe for probing a huge installer. */
    firstByteOnly?: boolean;
  }
): Promise<number | null>;
