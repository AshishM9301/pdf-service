import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// --- Constants ---
export const PDF_QUEUE_KEY = "pdf:queue";
export const PDF_RESULT_PREFIX = "pdf:result:";
export const RESULT_TTL_SECONDS = 60 * 60; // 1 hour
export const MAX_PDF_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

// --- Types ---
export interface PdfJob {
  id: string;
  html: string;
  options?: {
    format?: "A4" | "Letter";
    printBackground?: boolean;
    margin?: {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
    };
  };
  createdAt: string;
  webhook?: {
    url: string;
    triggerOnStatus: string[];
  };
}

export interface WebhookPayload {
  jobId: string;
  status: "done" | "error" | "size_exceeded";
  pdf?: string;
  error?: string;
  details?: string;
}

export async function callWebhook(webhook: NonNullable<PdfJob["webhook"]>, payload: WebhookPayload): Promise<void> {
  try {
    await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pdf-service-secret": process.env.PDF_SERVICE_WEBHOOK_SECRET ?? "",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[Webhook] Failed to call ${webhook.url}:`, err instanceof Error ? err.message : err);
  }
}

export interface PdfResult {
  id: string;
  status: "pending" | "processing" | "done" | "error" | "size_exceeded";
  pdf?: string; // base64 encoded PDF
  error?: string;
  createdAt: string;
  completedAt?: string;
  claimedAt?: string; // when worker picked up this job
  [key: string]: unknown;
}

// --- Helpers ---
export async function pushPdfJob(job: PdfJob): Promise<void> {
  await redis.lpush(PDF_QUEUE_KEY, JSON.stringify(job));
}

export async function popPdfJob(): Promise<PdfJob | null> {
  // Use rpop — reliable queue pop (FIFO via lpush/rpop)
  const raw = await redis.rpop<string>(PDF_QUEUE_KEY);
  if (!raw) return null;
  // Upstash Redis auto-parses JSON strings on retrieval, so raw may already be an object
  if (typeof raw === "object") return raw as PdfJob;
  return JSON.parse(raw) as PdfJob;
}

export async function setPdfResult(id: string, result: PdfResult): Promise<void> {
  await redis.hset(`${PDF_RESULT_PREFIX}${id}`, {
    ...result,
    completedAt: new Date().toISOString(),
  });
  await redis.expire(`${PDF_RESULT_PREFIX}${id}`, RESULT_TTL_SECONDS);
}

export async function getPdfResult(id: string): Promise<PdfResult | null> {
  const result = await redis.hgetall<PdfResult>(`${PDF_RESULT_PREFIX}${id}`);
  if (!result || Object.keys(result).length === 0) return null;
  return result;
}

export async function setJobProcessing(id: string): Promise<void> {
  await redis.hset(`${PDF_RESULT_PREFIX}${id}`, {
    status: "processing",
    claimedAt: new Date().toISOString(),
  });
  await redis.expire(`${PDF_RESULT_PREFIX}${id}`, RESULT_TTL_SECONDS);
}

export async function getStaleProcessingJobs(): Promise<string[]> {
  const keys = await redis.keys(`${PDF_RESULT_PREFIX}*`);
  const staleIds: string[] = [];
  const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  for (const key of keys) {
    const result = await redis.hgetall<PdfResult>(key);
    if (
      result &&
      result.status === "processing" &&
      result.claimedAt
    ) {
      const claimedTime = new Date(result.claimedAt).getTime();
      if (Date.now() - claimedTime > STALE_THRESHOLD_MS) {
        // Extract job id from key
        const id = key.replace(PDF_RESULT_PREFIX, "");
        staleIds.push(id);
      }
    }
  }

  return staleIds;
}

export async function recoverJob(id: string): Promise<void> {
  await redis.hset(`${PDF_RESULT_PREFIX}${id}`, {
    status: "pending",
    claimedAt: null as unknown as string,
  });
}

export async function getQueueLength(): Promise<number> {
  const queue = await redis.lrange<string>(PDF_QUEUE_KEY, 0, -1);
  return queue?.length ?? 0;
}

export async function getQueueInfo(jobId: string): Promise<{ position: number; total: number } | null> {
  const queue = await redis.lrange<string>(PDF_QUEUE_KEY, 0, -1);
  if (!queue || queue.length === 0) return null;

  const idx = queue.findIndex((item) => {
    try {
      const parsed = typeof item === "string" ? JSON.parse(item) : item;
      return (parsed as PdfJob).id === jobId;
    } catch {
      return false;
    }
  });

  if (idx === -1) return null;
  return { position: idx + 1, total: queue.length };
}
