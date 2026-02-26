import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { settingsManager } from "./settings.js";

const execAsync = promisify(exec);

export interface DocumentSession {
  id: string;
  name: string;
  pages: PageInfo[];
  created: Date;
  modified: Date;
}

export interface PageInfo {
  id: string;
  filename: string;
  filepath: string;
  timestamp: Date;
  size: number;
  pageNumber: number;
}

export class DocumentSessionManager {
  private log: (msg: string) => void;
  private sessions: Map<string, DocumentSession> = new Map();

  constructor(logFunction: (msg: string) => void) {
    this.log = logFunction;
    this.loadSessions();
  }

  // Generate a unique ID
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  // Load sessions from the scan directory
  private loadSessions(): void {
    const settings = settingsManager.get();
    const scanDir = settings.scanOutputDir;
    
    if (!fs.existsSync(scanDir)) {
      return;
    }

    try {
      // Find all scan files and group them into a single session for now
      const validExtensions = ['.pdf', '.tiff', '.png', '.jpeg', '.jpg'];
      const scanFiles = fs.readdirSync(scanDir)
        .filter(file => file.startsWith('scan-') && validExtensions.some(ext => file.endsWith(ext)))
        .map(filename => {
          const filepath = path.join(scanDir, filename);
          const stats = fs.statSync(filepath);

          // If a zero-byte file is present (possibly from a failed scan), remove it and skip
          if (stats.size === 0) {
            try {
              fs.unlinkSync(filepath);
              this.log(`Removed zero-byte scan file during session load: ${filename}`);
            } catch (e) {
              this.log(`Warning: Could not remove zero-byte file ${filename}: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
            return null;
          }

          return {
            id: this.generateId(),
            filename,
            filepath,
            timestamp: stats.mtime,
            size: stats.size,
            pageNumber: 0
          };
        });

      // Filter out any null entries from removed zero-byte files
      const filteredScanFiles = scanFiles.filter(f => f !== null) as any[];

      // Sort the filtered list by timestamp
      filteredScanFiles.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      if (filteredScanFiles.length > 0) {
        // Assign page numbers
        filteredScanFiles.forEach((file, index) => {
          file.pageNumber = index + 1;
        });

        // Create or update the default session
        const defaultSession: DocumentSession = {
          id: 'default',
          name: 'Current Document',
          pages: filteredScanFiles,
          created: filteredScanFiles[0]?.timestamp || new Date(),
          modified: filteredScanFiles[filteredScanFiles.length - 1]?.timestamp || new Date()
        };

        this.sessions.set('default', defaultSession);
      }
    } catch (error) {
      this.log(`Error loading sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Get all sessions
  getSessions(): DocumentSession[] {
    this.loadSessions(); // Refresh from filesystem
    return Array.from(this.sessions.values());
  }

  // Get a specific session
  getSession(sessionId: string): DocumentSession | null {
    this.loadSessions(); // Refresh from filesystem
    return this.sessions.get(sessionId) || null;
  }

  // Create a new document session
  createSession(name?: string): DocumentSession {
    const session: DocumentSession = {
      id: this.generateId(),
      name: name || `Document ${new Date().toLocaleString()}`,
      pages: [],
      created: new Date(),
      modified: new Date()
    };

    this.sessions.set(session.id, session);
    return session;
  }

  // Add a page to a session
  addPageToSession(sessionId: string, pageFilepath: string): { success: boolean; error?: string } {
    try {
      let session = this.getSession(sessionId);
      
      if (!session) {
        // Create default session if it doesn't exist
        session = {
          id: sessionId,
          name: sessionId === 'default' ? 'Current Document' : `Document ${sessionId}`,
          pages: [],
          created: new Date(),
          modified: new Date()
        };
      }

      if (!fs.existsSync(pageFilepath)) {
        return { success: false, error: 'Page file not found' };
      }

      const stats = fs.statSync(pageFilepath);
      // If the file is zero bytes, remove it and return an error
      if (stats.size === 0) {
        try {
          fs.unlinkSync(pageFilepath);
          this.log(`Removed zero-byte scan file when adding to session: ${path.basename(pageFilepath)}`);
        } catch (e) {
          this.log(`Warning: Could not remove zero-byte file ${path.basename(pageFilepath)}: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
        return { success: false, error: 'Page file is empty' };
      }
      const pageInfo: PageInfo = {
        id: this.generateId(),
        filename: path.basename(pageFilepath),
        filepath: pageFilepath,
        timestamp: stats.mtime,
        size: stats.size,
        pageNumber: session.pages.length + 1
      };

      session.pages.push(pageInfo);
      session.modified = new Date();
      this.sessions.set(sessionId, session);

      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  // Remove a page from a session
  // pageIdOrPath can be either the page ID or the filepath
  removePageFromSession(sessionId: string, pageIdOrPath: string): { success: boolean; error?: string } {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Try to find by ID first, then by filepath
      let pageIndex = session.pages.findIndex(p => p.id === pageIdOrPath);
      if (pageIndex === -1) {
        pageIndex = session.pages.findIndex(p => p.filepath === pageIdOrPath);
      }
      
      if (pageIndex === -1) {
        return { success: false, error: 'Page not found' };
      }

      const page = session.pages[pageIndex];
      if (!page) {
        return { success: false, error: 'Page not found' };
      }
      
      // Delete the file
      if (fs.existsSync(page.filepath)) {
        fs.unlinkSync(page.filepath);
      }

      // Remove from session
      session.pages.splice(pageIndex, 1);
      
      // Renumber remaining pages
      session.pages.forEach((p, index) => {
        p.pageNumber = index + 1;
      });

      session.modified = new Date();
      this.sessions.set(sessionId, session);

      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  // Combine pages in a session into a single document (PDF via pdf-lib, TIFF via tiffcp)
  async combineSessionPages(sessionId: string): Promise<string> {
    const session = this.getSession(sessionId);
    if (!session || session.pages.length === 0) {
      throw new Error('No pages to combine');
    }

    const settings = settingsManager.get();
    const format = settings.outputFormat || 'pdf';

    this.log(`Combining ${session.pages.length} pages from "${session.name}" (format: ${format})...`);

    if (format === 'tiff') {
      return this.combineTiffPages(session, settings.scanOutputDir, sessionId);
    } else if (format === 'pdf') {
      return this.combinePdfPages(session, settings.scanOutputDir, sessionId);
    } else {
      throw new Error(`Combining is not supported for ${format.toUpperCase()} format`);
    }
  }

  private async combinePdfPages(session: DocumentSession, outputDir: string, sessionId: string): Promise<string> {
    try {
      const combinedPdf = await PDFDocument.create();

      for (const page of session.pages) {
        if (!fs.existsSync(page.filepath)) {
          this.log(`Warning: Skipping missing file ${page.filename}`);
          continue;
        }

        const pdfBytes = fs.readFileSync(page.filepath);
        const sourcePdf = await PDFDocument.load(pdfBytes);
        const pages = await combinedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());

        pages.forEach((page) => combinedPdf.addPage(page));
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputPath = path.join(outputDir, `combined-${sessionId}-${timestamp}.pdf`);

      const pdfBytes = await combinedPdf.save();
      fs.writeFileSync(outputPath, pdfBytes);

      this.log(`Successfully combined ${session.pages.length} pages using pdf-lib`);
      return outputPath;
    } catch (error) {
      this.log(`Error combining PDF pages: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new Error(`Failed to combine PDF pages: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async combineTiffPages(session: DocumentSession, outputDir: string, sessionId: string): Promise<string> {
    try {
      const inputFiles = session.pages
          .filter(page => {
            if (!fs.existsSync(page.filepath)) {
              this.log(`Warning: Skipping missing file ${page.filename}`);
              return false;
            }
            return true;
          })
          .map(page => `"${page.filepath}"`);

      if (inputFiles.length === 0) {
        throw new Error('No valid TIFF files to combine');
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const prefix = inputFiles.length > 1 ? `combined-${sessionId}` : sessionId;
      const outputPath = path.join(outputDir, `${prefix}-${timestamp}.pdf`);

      const cmd = `img2pdf ${inputFiles.join(' ')} -o "${outputPath}"`;
      await execAsync(cmd, { timeout: 60 * 1000 });

      this.log(`Successfully combined ${inputFiles.length} pages into PDF using img2pdf`);
      return outputPath;
    } catch (error) {
      this.log(`Error combining TIFF pages into PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new Error(`Failed to combine TIFF pages into PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Clear a session (delete all pages)
  clearSession(sessionId: string): { success: boolean; error?: string; deletedCount: number } {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found', deletedCount: 0 };
      }

      let deletedCount = 0;
      for (const page of session.pages) {
        try {
          if (fs.existsSync(page.filepath)) {
            fs.unlinkSync(page.filepath);
            deletedCount++;
          }
        } catch (error) {
          this.log(`Warning: Could not delete ${page.filename}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Clear the session
      session.pages = [];
      session.modified = new Date();
      this.sessions.set(sessionId, session);

      this.log(`Cleared ${deletedCount} pages from session "${session.name}"`);
      return { success: true, deletedCount };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error',
        deletedCount: 0 
      };
    }
  }

  // Clear all sessions
  clearAllSessions(): { success: boolean; error?: string; deletedCount: number } {
    let totalDeleted = 0;
    const sessionIds = Array.from(this.sessions.keys());

    for (const sessionId of sessionIds) {
      const result = this.clearSession(sessionId);
      if (result.success) {
        totalDeleted += result.deletedCount;
      }
    }

    this.sessions.clear();
    return { success: true, deletedCount: totalDeleted };
  }

  // Reorder pages in a session
  reorderPages(sessionId: string, pageIds: string[]): { success: boolean; error?: string } {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Validate that all page IDs exist
      const reorderedPages: PageInfo[] = [];
      for (const pageId of pageIds) {
        const page = session.pages.find(p => p.id === pageId);
        if (!page) {
          return { success: false, error: `Page ${pageId} not found` };
        }
        reorderedPages.push(page);
      }

      // Update page numbers and save
      reorderedPages.forEach((page, index) => {
        page.pageNumber = index + 1;
      });

      session.pages = reorderedPages;
      session.modified = new Date();
      this.sessions.set(sessionId, session);

      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  // Format file size helper
  formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
}