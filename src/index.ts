import express from "express";
import cors from "cors";
import puppeteer, { type Browser } from "puppeteer";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  BorderStyle,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  convertInchesToTwip,
} from "docx";
import { JSDOM } from "jsdom";

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

// Parse HTML to DOCX sections
function parseHtmlToDocx(html: string): Document {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  
  const children: Paragraph[] = [];
  
  // Helper to create a TextRun with basic formatting
  const parseInlineStyles = (element: Element): TextRun[] => {
    const runs: TextRun[] = [];
    const text = element.textContent || "";
    
    if (text.trim()) {
      runs.push(new TextRun({
        text,
        font: "Arial",
        size: 24, // 12pt
      }));
    }
    
    return runs;
  };

  // Process each element
  const processElement = (element: Element): Paragraph | null => {
    const tagName = element.tagName?.toLowerCase();
    
    switch (tagName) {
      case "h1":
        return new Paragraph({
          children: [new TextRun({ text: element.textContent || "", bold: true, size: 48 })],
          heading: HeadingLevel.HEADING_1,
        });
      case "h2":
        return new Paragraph({
          children: [new TextRun({ text: element.textContent || "", bold: true, size: 36 })],
          heading: HeadingLevel.HEADING_2,
        });
      case "h3":
        return new Paragraph({
          children: [new TextRun({ text: element.textContent || "", bold: true, size: 32 })],
          heading: HeadingLevel.HEADING_3,
        });
      case "p":
        return new Paragraph({
          children: parseInlineStyles(element),
        });
      case "div":
      case "span":
        return new Paragraph({
          children: parseInlineStyles(element),
        });
      case "ul":
      case "ol":
        return new Paragraph({
          children: [new TextRun({ text: element.textContent || "", font: "Arial", size: 24 })],
        });
      case "br":
        return new Paragraph({ children: [] });
      default:
        return null;
    }
  };

  // Process body content
  const body = document.body;
  if (body) {
    Array.from(body.children).forEach((child: Element) => {
      const paragraph = processElement(child);
      if (paragraph) {
        children.push(paragraph);
      }
    });
  }

  // If no content, add a placeholder
  if (children.length === 0) {
    children.push(new Paragraph({
      children: [new TextRun({ text: "Resume content could not be parsed", font: "Arial", size: 24 })],
    }));
  }

  return new Document({
    sections: [{
      properties: {},
      children,
    }],
  });
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

// DOCX generation endpoint
app.post("/docx", express.json({ limit: "10mb" }), async (req, res) => {
  const startTime = Date.now();

  try {
    const { html } = req.body as { html?: string };

    if (!html || typeof html !== "string") {
      res.status(400).json({ error: "HTML content is required" });
      return;
    }

    const doc = parseHtmlToDocx(html as string);
    const docxBuffer = await Packer.toBuffer(doc);

    const duration = Date.now() - startTime;
    console.log(`DOCX generated in ${duration}ms`);

    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": "attachment; filename=resume.docx",
      "Content-Length": docxBuffer.length,
      "X-Generation-Time-Ms": duration.toString(),
    });

    res.send(Buffer.from(docxBuffer));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("DOCX generation failed:", message);
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