import express from "express";
import cors from "cors";
import puppeteer, { type Browser } from "puppeteer";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execAsync = promisify(exec);
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

// DOCX generation: HTML → PDF → DOCX via LibreOffice
app.post("/docx", express.json({ limit: "10mb" }), async (req, res) => {
  const startTime = Date.now();

  try {
    const { html } = req.body as { html?: string };

    if (!html || typeof html !== "string") {
      res.status(400).json({ error: "HTML content is required" });
      return;
    }

    const browser = await getBrowser();
    const page = await browser.newPage();

    // Convert HTML to PDF
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    await page.close();

    // Save PDF to temp file - use /tmp directly for LibreOffice compatibility
    const tmpDir = "/tmp";
    const timestamp = Date.now();
    const pdfPath = `${tmpDir}/resume-${timestamp}.pdf`;

    fs.writeFileSync(pdfPath, Buffer.from(pdfBuffer));
    console.log(`[DOCX] PDF saved to ${pdfPath}, size: ${pdfBuffer.length}`);

    // Convert PDF to DOC using LibreOffice with unoconv
    // Set HOME directory for LibreOffice config
    const homeDir = "/tmp/lo-home";
    fs.mkdirSync(homeDir, { recursive: true });

    // Use unoconv for better headless conversion
    const cmd = `HOME=${homeDir} unoconv -f doc -o /tmp/resume-${timestamp}.doc ${pdfPath}`;
    console.log(`[DOCX] Running command: ${cmd}`);

    let outputPath = "";
    try {
      await execAsync(cmd, { timeout: 60000, cwd: "/tmp" });

      // LibreOffice creates .doc file in the same directory as input
      const docFile = `${tmpDir}/resume-${timestamp}.doc`;
      console.log(`[DOCX] Checking for output at: ${docFile}, exists: ${fs.existsSync(docFile)}`);

      if (fs.existsSync(docFile)) {
        outputPath = docFile;
      } else {
        // LibreOffice might have created it elsewhere, try finding it
        const files = fs.readdirSync(tmpDir).filter(f => f.startsWith("resume-") && f.endsWith(".doc"));
        console.log(`[DOCX] Found .doc files in /tmp:`, files);
        if (files.length > 0) {
          outputPath = `${tmpDir}/${files[0]}`;
        } else {
          throw new Error(`LibreOffice conversion failed - no output file found`);
        }
      }
    } catch (loErr) {
      console.error("[DOCX] LibreOffice error:", loErr);
      // Clean up
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
      throw new Error(`LibreOffice conversion failed: ${loErr}`);
    }

    const docBuffer = fs.readFileSync(outputPath);

    // Cleanup temp files
    fs.unlinkSync(pdfPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const duration = Date.now() - startTime;
    console.log(`[DOCX] Generated in ${duration}ms, size: ${docBuffer.length}`);

    res.set({
      "Content-Type": "application/vnd.ms-word",
      "Content-Disposition": "attachment; filename=resume.doc",
      "Content-Length": docBuffer.length,
      "X-Generation-Time-Ms": duration.toString(),
    });

    res.send(docBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DOCX] Generation failed:", message);
    res.status(500).json({ error: "DOCX generation failed", details: message });
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
  console.log(`PDF/DOCX service running on port ${PORT}`);
});

export default app;