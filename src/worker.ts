import "dotenv/config";
import puppeteer, { type Browser } from "puppeteer";
import { popPdfJob, setPdfResult, setJobProcessing, getStaleProcessingJobs, recoverJob, MAX_PDF_SIZE_BYTES, type PdfJob, callWebhook } from "./redis.js";

// --- Semaphore ---
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waitQueue.push(resolve));
  }

  release(): void {
    this.permits++;
    const next = this.waitQueue.shift();
    if (next) {
      this.permits--;
      next();
    }
  }
}

// Max 1 PDF at a time to stay within memory limits
const pdfSemaphore = new Semaphore(1);

// --- Browser management ---
let browserInstance: Browser | null = null;
let pdfGeneratedCount = 0;
const MAX_PDFS_BEFORE_RESTART = 50;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--disable-translate",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
      ],
      headless: true,
    });
  }
  return browserInstance;
}

async function restartBrowser(): Promise<Browser> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
  pdfGeneratedCount = 0;
  return getBrowser();
}

// --- PDF Generator ---
async function generatePdf(job: PdfJob): Promise<{ pdf: string } | { error: string; sizeExceeded?: boolean }> {
  let page = null;

  await pdfSemaphore.acquire();

  try {
    if (pdfGeneratedCount >= MAX_PDFS_BEFORE_RESTART) {
      console.log("Recycling browser...");
      await restartBrowser();
    }
    pdfGeneratedCount++;

    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setContent(job.html, { waitUntil: "networkidle2" });

    const pdfBuffer = await page.pdf({
      format: job.options?.format ?? "A4",
      printBackground: job.options?.printBackground ?? true,
      margin: {
        top: job.options?.margin?.top ?? 0,
        right: job.options?.margin?.right ?? 0,
        bottom: job.options?.margin?.bottom ?? 0,
        left: job.options?.margin?.left ?? 0,
      },
    });

    // Size check before encoding and storing
    if (pdfBuffer.length > MAX_PDF_SIZE_BYTES) {
      return {
        error: `Generated PDF exceeds 5MB limit (${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB). Please reduce resume content or upgrade your plan.`,
        sizeExceeded: true,
      };
    }

    return { pdf: Buffer.from(pdfBuffer).toString("base64") };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { error: message };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    pdfSemaphore.release();
  }
}

// --- Worker loop ---
let pollTimer: NodeJS.Timeout | null = null;
const POLL_INTERVAL_MS = 500;

async function run(): Promise<void> {
  console.log("PDF worker started. Recovering stale jobs...");

  // Recover orphaned jobs from previous crashed workers
  const staleJobIds = await getStaleProcessingJobs();
  for (const jobId of staleJobIds) {
    await recoverJob(jobId);
    console.log(`Recovered orphaned job: ${jobId}`);
  }
  if (staleJobIds.length > 0) {
    console.log(`Recovered ${staleJobIds.length} stale job(s)`);
  }

  console.log("PDF worker started. Waiting for jobs...");

  const loop = async (): Promise<void> => {
    try {
      const job = await popPdfJob();
      if (!job) {
        // No job available — wait before next poll
        pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
        return;
      }

      console.log(`Processing job ${job.id}...`);
      const startTime = Date.now();

      // Mark job as processing BEFORE starting work (enables crash recovery)
      await setJobProcessing(job.id);

      const result = await generatePdf(job);
      const duration = Date.now() - startTime;

      if ("pdf" in result) {
        await setPdfResult(job.id, {
          id: job.id,
          status: "done",
          pdf: result.pdf,
          createdAt: job.createdAt,
          completedAt: new Date().toISOString(),
        });
        console.log(`Job ${job.id} done in ${duration}ms`);
        // Call webhook if configured
        if (job.webhook) {
          await callWebhook(job.webhook, {
            jobId: job.id,
            status: "done",
            pdf: result.pdf,
          });
        }
      } else if (result.sizeExceeded) {
        await setPdfResult(job.id, {
          id: job.id,
          status: "size_exceeded",
          error: result.error,
          createdAt: job.createdAt,
          completedAt: new Date().toISOString(),
        });
        console.log(`Job ${job.id} size exceeded in ${duration}ms`);
        if (job.webhook) {
          await callWebhook(job.webhook, {
            jobId: job.id,
            status: "size_exceeded",
            error: result.error,
            details: result.error,
          });
        }
      } else {
        await setPdfResult(job.id, {
          id: job.id,
          status: "error",
          error: result.error,
          createdAt: job.createdAt,
          completedAt: new Date().toISOString(),
        });
        console.error(`Job ${job.id} failed:`, result.error);
        if (job.webhook) {
          await callWebhook(job.webhook, {
            jobId: job.id,
            status: "error",
            error: result.error,
          });
        }
      }
    } catch (err) {
      console.error("Worker loop error:", err instanceof Error ? err.message : err);
    }

    // Always schedule next poll, even after error
    pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
  };

  loop();
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Worker shutting down...");
  if (pollTimer) clearTimeout(pollTimer);
  if (browserInstance) {
    await browserInstance.close();
  }
  process.exit(0);
});

run();