# PDF Service

HTML to PDF microservice using Puppeteer. Can be deployed to Render, Railway, or any Docker-compatible platform.

## Quick Start

```bash
npm install
npm run dev
```

## Endpoints

- `GET /health` - Health check
- `POST /pdf` - Generate PDF from HTML

### Request Body

```json
{
  "html": "<!DOCTYPE html><html>...</html>",
  "options": {
    "format": "A4",
    "printBackground": true,
    "margin": { "top": 0, "right": 0, "bottom": 0, "left": 0 }
  }
}
```

### Response

Returns PDF binary with headers:
- `Content-Type: application/pdf`
- `Content-Disposition: attachment; filename=resume.pdf`
- `X-Generation-Time-Ms: <duration>`

## Render Deployment

1. Create a new Web Service on Render
2. Connect your GitHub repo (or push directly)
3. Set the following:

   | Setting | Value |
   |---------|-------|
   | **Build Command** | `npm install && npm run build` |
   | **Start Command** | `node dist/index.js` |
   | **Environment** | `Node` |
   | **Port** | `3000` |

4. Add environment variable: `NODE_ENV=production`

Or use `render.yaml` for automatic deployment:

```yaml
services:
  - type: web
    name: pdf-service
    env: node
    buildCommand: npm install && npm run build
    startCommand: node dist/index.js
    envVars:
      - key: NODE_ENV
        value: production
```

After deployment, copy the URL (e.g., `https://pdf-service.onrender.com`) to your main app's `.env`:

```
NEXT_PUBLIC_PDF_SERVICE_URL=https://pdf-service.onrender.com
```