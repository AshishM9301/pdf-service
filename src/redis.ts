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
}

export interface PdfResult {
  id: string;
  status: "pending" | "done" | "error" | "size_exceeded";
  pdf?: string; // base64 encoded PDF
  error?: string;
  createdAt: string;
  completedAt?: string;
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
