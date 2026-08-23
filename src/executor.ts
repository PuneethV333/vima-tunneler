import axios from "axios";

export interface JobRequest {
  jobId: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
}

export interface JobResponse {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export const REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

export class NonLocalTargetError extends Error {}
export class BodyTooLargeError extends Error {}

function maxBodyBytes(): number {
  const raw = Number(process.env.VIMA_MAX_BODY_BYTES);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_MAX_BODY_BYTES;
}

function isLocalTarget(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return LOCAL_HOSTNAMES.has(host);
}

export async function executeRequest(job: JobRequest): Promise<JobResponse> {
  if (!isLocalTarget(job.url)) {
    throw new NonLocalTargetError(
      `refusing to proxy non-local target: ${job.url}`
    );
  }

  const response = await axios.request<import("node:stream").Readable>({
    method: job.method,
    url: job.url,
    headers: job.headers,
    data: job.bodyBase64 ? Buffer.from(job.bodyBase64, "base64") : undefined,
    responseType: "stream",
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    validateStatus: () => true,
  });

  const limit = maxBodyBytes();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.data) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) {
      response.data.destroy();
      throw new BodyTooLargeError(
        `response body exceeded ${limit} bytes from ${job.url}`
      );
    }
    chunks.push(buf);
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      headers[key.toLowerCase()] = value.join(", ");
    }
  }

  return {
    status: response.status,
    headers,
    bodyBase64: Buffer.concat(chunks).toString("base64"),
  };
}
