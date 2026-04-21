import express from "express";
import cors from "cors";
import puppeteer, { type Browser } from "puppeteer";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Singleton browser instance
let browserInstance: Browser | null = null;

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
      ],
      headless: true,
    });
  }
  return browserInstance;
}

// Request body type
interface GeneratePdfRequest {
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
}

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// PDF generation endpoint
app.post("/pdf", express.json({ limit: "10mb" }), async (req, res) => {
  const startTime = Date.now();

  try {
    const { html, options } = req.body as GeneratePdfRequest;

    if (!html || typeof html !== "string") {
      res.status(400).json({ error: "HTML content is required" });
      return;
    }

    const browser = await getBrowser();
    const page = await browser.newPage();

    // Set content and wait for fonts/images to load
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: options?.format ?? "A4",
      printBackground: options?.printBackground ?? true,
      margin: {
        top: options?.margin?.top ?? 0,
        right: options?.margin?.right ?? 0,
        bottom: options?.margin?.bottom ?? 0,
        left: options?.margin?.left ?? 0,
      },
    });

    await page.close();

    const duration = Date.now() - startTime;
    console.log(`PDF generated in ${duration}ms`);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=resume.pdf",
      "Content-Length": pdfBuffer.length,
      "X-Generation-Time-Ms": duration.toString(),
    });

    res.send(Buffer.from(pdfBuffer));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("PDF generation failed:", message);
    res.status(500).json({ error: "PDF generation failed", details: message });
  }
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  if (browserInstance) {
    await browserInstance.close();
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`PDF service running on port ${PORT}`);
});

export default app;