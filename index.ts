import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { settingsManager } from "./settings.js";
import { fileURLToPath } from "url";
import { PaperlessAPI } from "./paperless-api.js";
import { DocumentSessionManager } from "./document-session.js";
import { ScannerManager } from "./scanner-manager.js";
import type { ScannerInfo } from "./scanner-manager.js";

const execAsync = promisify(exec);

let logListeners: Set<(msg: string) => void> = new Set();

function log(msg: string) {
  console.log(msg);
  for (const listener of logListeners) {
    listener(msg);
  }
}

// Initialize Paperless API, Document Session Manager, and Scanner Manager
const paperlessAPI = new PaperlessAPI(log);
const documentManager = new DocumentSessionManager(log);
const scannerManager = new ScannerManager(log);

// === Scanning ===
async function scanPage(): Promise<string[]> {
  const settings = settingsManager.get();

  let scanner: ScannerInfo | undefined;
  let scannerDevice: string;

  // Check if a direct scanner device URL is configured
  if (settings.scannerDeviceUrl && settings.scannerDeviceUrl.trim() !== '') {
    // Use the configured scanner device URL directly
    scannerDevice = settings.scannerDeviceUrl.trim();
    log(`Using configured scanner device: ${scannerDevice}`);
  } else {
    // Auto-detect scanners
    const detection = await scannerManager.detectScanners();
    if (detection.scanners.length === 0) {
      const errorMsg = detection.error || "No scanners found";
      log(`Scanner detection failed: ${errorMsg}`);
      throw new Error(`Scanner not available: ${errorMsg}`);
    }

    // Use first available scanner
    scanner = detection.scanners[0];
    if (!scanner) {
      throw new Error("No scanner available");
    }
    scannerDevice = scanner.device;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = settings.outputFormat || "pdf";
  const isDuplex = settings.duplex === true;

  // Build scanimage command
  let cmd = `scanimage --device-name="${scannerDevice}" --format=${ext} --resolution=${settings.scanResolution}`;

  if (settings.source) {
    cmd += ` --source="${settings.source}"`;
  }

  if (settings.pageWidth && settings.pageWidth > 0) {
    cmd += ` --page-width=${settings.pageWidth}`;
  }

  if (settings.pageHeight && settings.pageHeight > 0) {
    cmd += ` --page-height=${settings.pageHeight}`;
  }

  if (settings.swskip && settings.swskip > 0) {
    cmd += ` --swskip=${settings.swskip}`;
  }

  if (isDuplex) {
    // Duplex mode: use --batch to scan all pages from ADF, each side as a separate file
    const batchPrefix = `scan-${timestamp}-p`;
    const batchPattern = `${settings.scanOutputDir}/${batchPrefix}%d.${ext}`;
    cmd += ` --batch="${batchPattern}"`;

    log(`Starting duplex batch scan with device: ${scannerDevice}...`);

    try {
      await execAsync(cmd, { timeout: 5 * 60 * 1000 }); // 5 min timeout for multi-page batch

      // Collect all batch output files by scanning for matching filenames
      const scannedFiles: string[] = [];
      const dirEntries = fs.readdirSync(settings.scanOutputDir);
      const matchingFiles = dirEntries
        .filter(f => f.startsWith(batchPrefix) && f.endsWith(`.${ext}`))
        .sort((a, b) => {
          // Sort numerically by page number extracted from filename
          const numA = parseInt(a.slice(batchPrefix.length, a.lastIndexOf('.')));
          const numB = parseInt(b.slice(batchPrefix.length, b.lastIndexOf('.')));
          return numA - numB;
        });

      for (const filename of matchingFiles) {
        const filePath = path.join(settings.scanOutputDir, filename);
        const stats = fs.statSync(filePath);
        if (stats.size > 0) {
          scannedFiles.push(filePath);
          log(`Batch page: ${filename}`);
        } else {
          fs.unlinkSync(filePath);
          log(`Discarded empty batch page: ${filename}`);
        }
      }

      if (scannedFiles.length === 0) {
        throw new Error("Duplex scan failed - no files were created");
      }

      if (scanner) {
        scannerManager.markSuccessfulScan(scanner);
      }

      log(`Duplex batch scan complete: ${scannedFiles.length} page(s) captured`);
      return scannedFiles;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // Clean up any partial batch files
      try {
        const dirEntries = fs.readdirSync(settings.scanOutputDir);
        for (const f of dirEntries) {
          if (f.startsWith(batchPrefix) && f.endsWith(`.${ext}`)) {
            fs.unlinkSync(path.join(settings.scanOutputDir, f));
          }
        }
      } catch (_) {}
      throw new Error(`Duplex scan failed: ${errorMsg}`);
    }
  }

  // Single-sided scan
  const finalFilePath = `${settings.scanOutputDir}/scan-${timestamp}.${ext}`;
  const tempFilePath = `${finalFilePath}.tmp`;

  cmd += ` > "${tempFilePath}"`;

  log(`Starting page scan with device: ${scannerDevice}...`);

  try {
    await execAsync(cmd);

    // Check if the temp file was created and has content, then rename to final path
    if (!fs.existsSync(tempFilePath)) {
      throw new Error("Scan failed - no file was created");
    }

    const stats = fs.statSync(tempFilePath);
    if (stats.size === 0) {
      // Delete the empty temp file
      fs.unlinkSync(tempFilePath);
      throw new Error("Scan failed - empty file created");
    }
    // Move temporary file to final path
    fs.renameSync(tempFilePath, finalFilePath);

    // Mark successful scan to cache the scanner
    if (scanner) {
      scannerManager.markSuccessfulScan(scanner);
    }

    log("Page scan complete: " + path.basename(finalFilePath));
    return [finalFilePath];
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
      // If a zero-byte temp file exists due to shell redirection, remove it to avoid littering the scan directory
    try {
      if (fs.existsSync(tempFilePath)) {
        const s = fs.statSync(tempFilePath);
        if (s.size === 0) {
          fs.unlinkSync(tempFilePath);
          log(`Removed zero-byte temp file created during failed scan: ${path.basename(tempFilePath)}`);
        }
      }
    } catch (cleanupErr) {
      log(`Warning: Failed to cleanup zero-byte file: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
    
    if (errorMsg.includes('no SANE devices found')) {
      log("No SANE devices found. Attempting to fix scanner issues...");
      const fixResult = await scannerManager.attemptFix();
      if (fixResult.success) {
        log("Scanner fix successful, retrying scan...");
        // Retry the scan once
        try {
          await execAsync(cmd);
          
          // Check if the temp file was created and has content, then rename to final path
          if (!fs.existsSync(tempFilePath)) {
            throw new Error("Scan failed - no file was created");
          }
          
          const stats = fs.statSync(tempFilePath);
          if (stats.size === 0) {
            fs.unlinkSync(tempFilePath);
            throw new Error("Scan failed - empty file created");
          }

          fs.renameSync(tempFilePath, finalFilePath);

          // Mark successful scan to cache the scanner
          if (scanner) {
            scannerManager.markSuccessfulScan(scanner);
          }
          
          log("Page scan complete after fix: " + path.basename(finalFilePath));
          return [finalFilePath];
        } catch (retryErr) {
          // Ensure any zero-byte temp file from the retry attempt is removed
          try {
            if (fs.existsSync(tempFilePath)) {
              const s2 = fs.statSync(tempFilePath);
              if (s2.size === 0) {
                fs.unlinkSync(tempFilePath);
                log(`Removed zero-byte temp file created during failed retry scan: ${path.basename(tempFilePath)}`);
              }
            }
          } catch (cleanupErr) {
            log(`Warning: Failed to cleanup zero-byte file after retry: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
          }

          log("Page scan failed even after fix attempt: " + retryErr);
          throw new Error(`Scan failed after fix attempt: ${retryErr}`);
        }
      } else {
        log(`Scanner fix failed: ${fixResult.message}`);
        throw new Error(`Scanner not available: ${fixResult.message}`);
      }
    } else {
      log("Page scan failed: " + errorMsg);

      // Also clean up any zero-byte temp file left by the failing scan command
      try {
        if (fs.existsSync(tempFilePath)) {
          const s3 = fs.statSync(tempFilePath);
          if (s3.size === 0) {
            fs.unlinkSync(tempFilePath);
            log(`Removed zero-byte temp file created during failed scan: ${path.basename(tempFilePath)}`);
          }
        }
      } catch (cleanupErr) {
        log(`Warning: Failed to cleanup zero-byte file: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      }

      throw new Error(`Scan failed: ${errorMsg}`);
    }
  }
}

// === Scan operations ===
async function startPageScan() {
  try {
    const filePaths = await scanPage();
    // Add the scanned page(s) to the default session
    for (const filePath of filePaths) {
      const result = documentManager.addPageToSession('default', filePath);
      if (result.success) {
        log(`Page added to session: ${path.basename(filePath)}`);
      } else {
        log(`Page scanned but failed to add to session: ${result.error}`);
      }
    }
    if (filePaths.length > 1) {
      log(`${filePaths.length} pages scanned (duplex). Use 'Combine & Upload' to merge and upload.`);
    } else {
      log("Page scanned and added to document session. Use 'Combine & Upload' to process all pages.");
    }
  } catch (err) {
    log("Page scan error: " + err);
  }
}

async function combineAndUpload(sessionId: string = 'default') {
  try {
    const session = documentManager.getSession(sessionId);
    if (!session || session.pages.length === 0) {
      throw new Error("No pages to upload");
    }

    // Can be multiple pages - combine always
    const combinedPath = await documentManager.combineSessionPages(sessionId);
    await paperlessAPI.uploadDocument(combinedPath);

    // Clean up combined file and clear session
    fs.unlinkSync(combinedPath);
    documentManager.clearSession(sessionId);

    log(`Combined ${session.pages.length} pages, uploaded, and cleaned up!`);
  } catch (err) {
    log("Combine and upload error: " + err);
  }
}

// === Helper function to load HTML templates ===
function loadTemplate(templateName: string): string {
  // Prefer templates from a stable system location inside the image, then fall back to the script directory and finally process.cwd().
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const stableTemplatePath = path.join("/usr/share/paperless-scanner/templates", `${templateName}.html`);
  const primaryTemplatePath = path.join(__dirname, "templates", `${templateName}.html`);
  const fallbackTemplatePath = path.join(process.cwd(), "templates", `${templateName}.html`);
  try {
    return fs.readFileSync(stableTemplatePath, "utf8");
  } catch (errStable) {
    try {
      return fs.readFileSync(primaryTemplatePath, "utf8");
    } catch (errPrimary) {
      try {
        return fs.readFileSync(fallbackTemplatePath, "utf8");
      } catch (errFallback) {
        console.error(`Failed to load template ${templateName}:`, errStable, errPrimary, errFallback);
        return `<html><body><h1>Error</h1><p>Template ${templateName} not found.</p></body></html>`;
      }
    }
  }
}

// === Bun HTTP server ===
import { serve } from "bun";

serve({
  port: 3000,
  idleTimeout: 255, // Increase timeout to 255 seconds for long-running scans
  fetch: async (req) => {
    const url = new URL(req.url);

    // Settings API endpoints
    if (url.pathname === "/api/settings") {
      if (req.method === "GET") {
        return new Response(JSON.stringify(settingsManager.get()), {
          headers: { "Content-Type": "application/json" },
        });
      }
      
      if (req.method === "POST") {
        try {
          const body = await req.json() as any;
          settingsManager.update(body);
          
          const validation = settingsManager.validate();
          if (!validation.valid) {
            return new Response(JSON.stringify({ 
              error: `Validation failed: ${validation.errors.join(', ')}` 
            }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return new Response(JSON.stringify({ 
            error: error instanceof Error ? error.message : 'Invalid JSON' 
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    // Reset settings endpoint
    if (req.method === "POST" && url.pathname === "/api/settings/reset") {
      try {
        settingsManager.reset();
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Failed to reset settings' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Test connection endpoint
    if (req.method === "POST" && url.pathname === "/test-connection") {
      try {
        const result = await paperlessAPI.testConnection();
        if (result.success) {
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" },
          });
        } else {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Connection test failed' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Test file upload endpoint
    if (req.method === "POST" && url.pathname === "/api/test-upload") {
      try {
        // Validate settings before attempting upload
        const validation = settingsManager.validate();
        if (!validation.valid) {
          return new Response(JSON.stringify({ 
            error: `Configuration error: ${validation.errors.join(', ')}` 
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const formData = await req.formData();
        const file = formData.get('document') as unknown as File;
        
        if (!file) {
          return new Response(JSON.stringify({ 
            error: 'No file provided' 
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Save the uploaded file to a temporary location
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const settings = settingsManager.get();
        const tempFilePath = `${settings.scanOutputDir}/upload-test-${timestamp}-${file.name}`;
        
        // Write the file buffer to disk
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(tempFilePath, buffer);

        log(`Test upload: Received file ${file.name} (${file.size} bytes)`);

        try {
          // Upload to Paperless-ngx
          await paperlessAPI.uploadDocument(tempFilePath);
          
          // Clean up the temporary file
          fs.unlinkSync(tempFilePath);
          
          return new Response(JSON.stringify({ 
            success: true,
            message: `File "${file.name}" uploaded successfully to Paperless-ngx`
          }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (uploadError) {
          // Clean up the temporary file even if upload fails
          try {
            fs.unlinkSync(tempFilePath);
          } catch (e) {
            // Ignore cleanup errors
          }
          
          throw uploadError;
        }
      } catch (error) {
        log(`Test upload error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Upload failed' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Trigger page scan
    if (req.method === "POST" && url.pathname === "/scan") {
      try {
        // Validate settings before starting scan
        const validation = settingsManager.validate();
        if (!validation.valid) {
          return new Response(JSON.stringify({ 
            error: `Configuration error: ${validation.errors.join(', ')}` 
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        
        startPageScan();
        return new Response(JSON.stringify({ status: "page scan started" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Failed to start scan' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Get document sessions
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      try {
        const sessions = documentManager.getSessions();
        return new Response(JSON.stringify({ sessions }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Failed to get sessions' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Get specific session
    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      try {
        const sessionId = url.pathname.split('/').pop();
        if (!sessionId) {
          return new Response(JSON.stringify({ error: 'Session ID required' }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const session = documentManager.getSession(sessionId);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Session not found' }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ session }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Failed to get session' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Combine and upload session
    if (req.method === "POST" && url.pathname === "/api/combine-upload") {
      try {
        const body = await req.json() as any;
        const sessionId = body.sessionId as string || 'default';
        
        combineAndUpload(sessionId);
        return new Response(JSON.stringify({ status: "combine and upload started" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Failed to combine and upload' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Upload selected pages individually
    if (req.method === "POST" && url.pathname === "/api/upload-selected") {
      try {
        const body = await req.json() as any;
        const sessionId = body.sessionId as string || 'default';
        const pageIds = body.pageIds as string[];

        if (!pageIds || pageIds.length === 0) {
          return new Response(JSON.stringify({ error: 'No page IDs specified' }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const session = documentManager.getSession(sessionId);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Session not found' }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Upload each selected page individually (async, don't await in request)
        (async () => {
          let uploadedCount = 0;
          for (const pageId of pageIds) {
            try {
              await paperlessAPI.uploadDocument(pageId);
              documentManager.removePageFromSession(sessionId, pageId);
              uploadedCount++;
              log(`Uploaded and removed: ${path.basename(pageId)}`);
            } catch (err) {
              log(`Failed to upload ${path.basename(pageId)}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          log(`Upload selected complete: ${uploadedCount}/${pageIds.length} page(s) uploaded`);
        })();

        return new Response(JSON.stringify({ status: "upload selected started" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: error instanceof Error ? error.message : 'Failed to upload selected pages'
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Clear session
    if (req.method === "POST" && url.pathname === "/api/clear-session") {
      try {
        const body = await req.json() as any;
        const sessionId = body.sessionId as string || 'default';
        
        const result = documentManager.clearSession(sessionId);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Failed to clear session' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Delete specific pages
    if (req.method === "POST" && url.pathname === "/api/delete-pages") {
      try {
        const body = await req.json() as any;
        const sessionId = body.sessionId as string || 'default';
        const pageIds = body.pageIds as string[];
        
        if (!pageIds || pageIds.length === 0) {
          return new Response(JSON.stringify({ 
            error: 'No page IDs specified' 
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        
        let deletedCount = 0;
        for (const pageId of pageIds) {
          const result = documentManager.removePageFromSession(sessionId, pageId);
          if (result.success) {
            deletedCount++;
          }
        }
        
        return new Response(JSON.stringify({ 
          success: true, 
          deletedCount 
        }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Failed to delete pages' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Add page to session (after scanning)
    if (req.method === "POST" && url.pathname === "/api/add-page-to-session") {
      try {
        const body = await req.json() as any;
        const sessionId = body.sessionId as string || 'default';
        const pageFilepath = body.pageFilepath as string;
        
        if (!pageFilepath) {
          return new Response(JSON.stringify({ 
            error: 'Page filepath required' 
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        
        const result = documentManager.addPageToSession(sessionId, pageFilepath);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Failed to add page to session' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Scanner diagnostics and management endpoints
    if (req.method === "GET" && url.pathname === "/api/scanners") {
      try {
        const detection = await scannerManager.detectScanners();
        return new Response(JSON.stringify(detection), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          scanners: [],
          error: error instanceof Error ? error.message : 'Scanner detection failed' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/test-scanner") {
      try {
        const body = await req.json() as any;
        const deviceId = body.deviceId as string | undefined;
        
        const result = await scannerManager.testScanner(deviceId);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false,
          error: error instanceof Error ? error.message : 'Scanner test failed' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/scanner-diagnostics") {
      try {
        const result = await scannerManager.getDiagnostics();
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          diagnostics: {},
          suggestions: [],
          error: error instanceof Error ? error.message : 'Diagnostics failed' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/fix-scanner") {
      try {
        const result = await scannerManager.attemptFix();
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false,
          message: error instanceof Error ? error.message : 'Fix attempt failed' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/scanner-options") {
      try {
        const deviceId = url.searchParams.get("deviceId");
        if (!deviceId) {
          return new Response(JSON.stringify({ error: "Missing deviceId parameter" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const result = await scannerManager.getScanSettings(deviceId);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Failed to fetch scanner options' 
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Event stream for logs
    if (req.method === "GET" && url.pathname === "/logs") {
      return new Response(
        new ReadableStream({
          start(controller) {
            const listener = (msg: string) => {
              controller.enqueue(`data: ${msg}\n\n`);
            };
            logListeners.add(listener);

            req.signal.addEventListener("abort", () => {
              logListeners.delete(listener);
            });
          },
        }),
        { 
          headers: { 
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          } 
        }
      );
    }

    // Settings page
    if (req.method === "GET" && url.pathname === "/settings") {
      return new Response(loadTemplate("settings"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Main scanner interface
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(loadTemplate("index"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log("Scanner bridge running at http://localhost:3000");
console.log("Main interface: http://localhost:3000");
console.log("Settings page: http://localhost:3000/settings");