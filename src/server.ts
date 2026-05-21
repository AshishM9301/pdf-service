import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { pushPdfJob, getPdfResult, getQueueInfo, getQueueLength, MAX_PDF_SIZE_BYTES, type PdfJob } from "./redis.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Submit PDF job
app.post("/pdf", async (req, res) => {
  try {
    const { html, options, jobId, webhook } = req.body as {
      html: string;
      options?: PdfJob["options"];
      jobId?: string;
      webhook?: PdfJob["webhook"];
    };

    if (!html || typeof html !== "string") {
      res.status(400).json({ error: "HTML content is required" });
      return;
    }

    // Estimate HTML size as proxy for PDF size
    const estimatedSize = Buffer.byteLength(html, "utf-8");
    if (estimatedSize > MAX_PDF_SIZE_BYTES) {
      res.status(413).json({
        error: "PDF_SIZE_EXCEEDED",
        message: `HTML content exceeds 5MB limit. Please reduce the resume size or upgrade your plan.`,
        details: {
          maxSizeBytes: MAX_PDF_SIZE_BYTES,
          providedSizeBytes: estimatedSize,
        },
      });
      return;
    }

    // Use provided jobId (from Next.js API) or generate our own
    const id = jobId ?? uuidv4();

    const job: PdfJob = {
      id,
      html,
      options: options ?? {},
      createdAt: new Date().toISOString(),
      ...(webhook ? { webhook } : {}),
    };

    await pushPdfJob(job);

    res.status(202).json({
      jobId: job.id,
      status: "pending",
      message: "PDF generation queued. Poll GET /pdf/:jobId for status.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to queue PDF job:", message);
    res.status(500).json({ error: "Failed to queue PDF job", details: message });
  }
});

// Get PDF result (polling)
app.get("/pdf/status", async (_req, res) => {
  try {
    const queueLength = await getQueueLength();
    res.json({
      mode: "async",
      queueLength,
      workerUp: true,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get status" });
  }
});

// Get PDF result (polling)
app.get("/pdf/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId || typeof jobId !== "string") {
      res.status(400).json({ error: "Valid jobId is required" });
      return;
    }

    const result = await getPdfResult(jobId);

    if (!result) {
      res.status(404).json({ error: "Job not found or expired" });
      return;
    }

    if (result.status === "pending") {
      const queueInfo = await getQueueInfo(jobId);
      res.status(202).json({
        jobId,
        status: "pending",
        queuePosition: queueInfo?.position ?? null,
        queueTotal: queueInfo?.total ?? null,
        message: "PDF is still generating...",
      });
      return;
    }

    if (result.status === "error") {
      res.status(500).json({
        jobId,
        status: "error",
        error: "PDF generation failed",
        details: result.error,
      });
      return;
    }

    if (result.status === "size_exceeded") {
      res.status(413).json({
        jobId,
        status: "size_exceeded",
        error: "PDF_SIZE_EXCEEDED",
        message: result.error,
      });
      return;
    }

    if (result.status === "done") {
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": "attachment; filename=resume.pdf",
        "Content-Length": Buffer.from(result.pdf!, "base64").length,
      });
      res.send(Buffer.from(result.pdf!, "base64"));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to get PDF result:", message);
    res.status(500).json({ error: "Failed to get PDF result", details: message });
  }
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Server shutting down...");
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`PDF API server running on port ${PORT}`);
});

export default app;