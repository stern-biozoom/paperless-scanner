import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface ScannerInfo {
  device: string;
  vendor: string;
  model: string;
  type: string;
  available: boolean;
}

export class ScannerManager {
  private log: (msg: string) => void;
  private cachedScanner: ScannerInfo | null = null;
  private lastSuccessfulScan: Date | null = null;

  constructor(logFunction: (msg: string) => void) {
    this.log = logFunction;
  }

  // Get the cached scanner (if available and recently used)
  getCachedScanner(): ScannerInfo | null {
    if (this.cachedScanner && this.lastSuccessfulScan) {
      // If we've successfully scanned in the last hour, trust the cached scanner
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (this.lastSuccessfulScan > hourAgo) {
        return this.cachedScanner;
      }
    }
    return null;
  }

  // Mark a successful scan with a specific scanner
  markSuccessfulScan(scanner: ScannerInfo): void {
    this.cachedScanner = scanner;
    this.lastSuccessfulScan = new Date();
    this.log(`Cached scanner: ${scanner.vendor} ${scanner.model} (${scanner.device})`);
  }

  // Detect available scanners
  async detectScanners(): Promise<{ scanners: ScannerInfo[]; error?: string }> {
    try {
      this.log("Detecting scanners...");
      
      // First try to list devices
      let stdout = '';
      let stderr = '';
      
      try {
        const result = await execAsync('scanimage -L', { timeout: 5000 });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        // If scanimage -L fails but we have a cached scanner, use it
        const cached = this.getCachedScanner();
        if (cached) {
          this.log(`scanimage -L failed, but using cached scanner: ${cached.vendor} ${cached.model}`);
          return { 
            scanners: [cached],
            error: undefined
          };
        }
        throw error;
      }
      
      // Check for "No scanners were identified" message
      if (stdout.includes('No scanners were identified') || stderr.includes('No scanners were identified')) {
        // Check if we have a cached scanner to fall back to
        const cached = this.getCachedScanner();
        if (cached) {
          this.log(`No scanners detected, but using cached scanner: ${cached.vendor} ${cached.model}`);
          return { 
            scanners: [cached],
            error: undefined
          };
        }
        
        return {
          scanners: [],
          error: "No scanners detected. Make sure your scanner is connected and powered on."
        };
      }
      
      if (!stdout || stdout.trim() === '') {
        // Check if we have a cached scanner to fall back to
        const cached = this.getCachedScanner();
        if (cached) {
          this.log(`No output from detection, but using cached scanner: ${cached.vendor} ${cached.model}`);
          return { 
            scanners: [cached],
            error: undefined
          };
        }
        
        return {
          scanners: [],
          error: "No output from scanner detection. Check if SANE is properly configured."
        };
      }

      // Parse scanimage -L output
      const scanners: ScannerInfo[] = [];
      const lines = stdout.split('\n').filter(line => line.trim());
      
      this.log(`Scanner detection output: ${lines.length} lines`);
      
      for (const line of lines) {
        // Look for lines with device information
        // Common formats:
        // device `epson2:libusb:001:004' is a Epson PerfectionV19 flatbed scanner
        // device `pixma:04A91757' is a CANON Canon PIXMA MG5200 multi-function peripheral
        if (line.toLowerCase().includes('device')) {
          this.log(`Parsing line: ${line}`);
          
          // Try to extract device name (between backticks)
          const deviceMatch = line.match(/device\s+`([^'`]+)'?\s+is\s+a?\s+(.+?)(?:\s+(?:flatbed|multi-function|document|sheet-fed))?(?:\s+(?:scanner|peripheral))?$/i);
          
          if (deviceMatch && deviceMatch[1]) {
            const device = deviceMatch[1].trim();
            const description = deviceMatch[2] ? deviceMatch[2].trim() : 'Unknown Scanner';
            
            // Try to extract vendor and model from description
            // Handle cases like "Epson PerfectionV19", "CANON Canon PIXMA MG5200", etc.
            const descParts = description.split(/\s+/);
            let vendor = 'Unknown';
            let model = 'Unknown';
            
            if (descParts.length >= 1 && descParts[0]) {
              vendor = descParts[0];
              
              // Handle duplicate vendor names like "CANON Canon"
              if (descParts.length >= 2 && descParts[1] && descParts[1].toLowerCase() === descParts[0].toLowerCase()) {
                model = descParts.slice(2).join(' ') || descParts[0];
              } else {
                model = descParts.slice(1).join(' ') || descParts[0];
              }
            }
            
            // Determine scanner type from description
            let type = 'unknown';
            const lowerDesc = description.toLowerCase();
            if (lowerDesc.includes('flatbed')) type = 'flatbed';
            else if (lowerDesc.includes('sheet') || lowerDesc.includes('feeder')) type = 'sheet-fed';
            else if (lowerDesc.includes('multi-function')) type = 'multi-function';
            
            scanners.push({
              device,
              vendor,
              model,
              type,
              available: true
            });
            
            this.log(`Parsed scanner: ${vendor} ${model} (${device})`);
          } else {
            this.log(`Could not parse scanner line: ${line}`);
          }
        }
      }

      if (scanners.length === 0 && lines.length > 0) {
        // We got output but couldn't parse any scanners
        this.log(`Raw output for debugging:\n${stdout}`);
        return {
          scanners: [],
          error: `Could not parse scanner information. Raw output: ${lines.join(' | ')}`
        };
      }

      if (scanners.length === 0) {
        // Check if we have a cached scanner to fall back to
        const cached = this.getCachedScanner();
        if (cached) {
          this.log(`No scanners parsed, but using cached scanner: ${cached.vendor} ${cached.model}`);
          return { 
            scanners: [cached],
            error: undefined
          };
        }
        
        return {
          scanners: [],
          error: "No scanners detected. Make sure your scanner is connected and powered on."
        };
      }

      // Cache the first scanner found
      if (scanners[0]) {
        this.cachedScanner = scanners[0];
      }

      this.log(`Found ${scanners.length} scanner(s): ${scanners.map(s => s.vendor + ' ' + s.model).join(', ')}`);
      return { scanners };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      
      if (errorMsg.includes('scanimage: command not found') || errorMsg.includes('not found')) {
        return {
          scanners: [],
          error: "SANE tools not installed. Install with: brew install sane-backends (macOS)"
        };
      }
      
      if (errorMsg.includes('no SANE devices found')) {
        return {
          scanners: [],
          error: "No SANE devices found. Check scanner connection, power, and permissions."
        };
      }

      this.log(`Scanner detection failed: ${errorMsg}`);
      return {
        scanners: [],
        error: `Scanner detection failed: ${errorMsg}`
      };
    }
  }

  // Test scanner connection
  async testScanner(deviceId?: string): Promise<{ success: boolean; error?: string; details?: any }> {
    try {
      this.log("Testing scanner connection...");
      
      // If no device specified, try to detect and use first available
      let testDevice = deviceId;
      if (!testDevice) {
        const detection = await this.detectScanners();
        if (detection.scanners.length === 0) {
          return {
            success: false,
            error: detection.error || "No scanners available for testing"
          };
        }
        const firstScanner = detection.scanners[0];
        if (!firstScanner) {
          return {
            success: false,
            error: "No scanners available for testing"
          };
        }
        testDevice = firstScanner.device;
      }

      // Test with a simple scan query (no actual scanning)
      const cmd = `scanimage --device-name="${testDevice}" --help`;
      const { stdout, stderr } = await execAsync(cmd);
      
      if (stderr && stderr.includes('invalid')) {
        return {
          success: false,
          error: `Scanner test failed: Invalid device ${testDevice}`
        };
      }

      this.log(`Scanner test successful for device: ${testDevice}`);
      return {
        success: true,
        details: {
          device: testDevice,
          helpOutput: stdout
        }
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Scanner test failed: ${errorMsg}`);
      return {
        success: false,
        error: `Scanner test failed: ${errorMsg}`
      };
    }
  }

  // Get scanner diagnostics
  async getDiagnostics(): Promise<{ diagnostics: any; suggestions: string[] }> {
    const diagnostics: any = {};
    const suggestions: string[] = [];

    try {
      // Check if scanimage is available
      try {
        const { stdout } = await execAsync('which scanimage');
        diagnostics.scanimage_path = stdout.trim();
      } catch {
        diagnostics.scanimage_available = false;
        suggestions.push("Install SANE tools: sudo apt-get install sane-utils (Linux) or brew install sane-backends (macOS)");
      }

      // Check SANE version
      try {
        const { stdout } = await execAsync('scanimage --version');
        diagnostics.sane_version = stdout.trim();
      } catch (error) {
        diagnostics.sane_version_error = error instanceof Error ? error.message : 'Unknown error';
      }

      // Check for permission issues (Linux)
      if (process.platform === 'linux') {
        try {
          const { stdout } = await execAsync('groups');
          const groups = stdout.trim().split(' ');
          diagnostics.user_groups = groups;
          
          if (!groups.includes('scanner') && !groups.includes('lp')) {
            suggestions.push("Add user to scanner group: sudo usermod -a -G scanner $USER");
            suggestions.push("Then log out and log back in for changes to take effect");
          }
        } catch (error) {
          diagnostics.groups_error = error instanceof Error ? error.message : 'Unknown error';
        }
      }

      // Check USB devices (if available)
      try {
        const { stdout } = await execAsync('lsusb 2>/dev/null || system_profiler SPUSBDataType 2>/dev/null || echo "USB info not available"');
        diagnostics.usb_info = stdout;
      } catch {
        diagnostics.usb_info = "Could not retrieve USB device information";
      }

      // General suggestions
      suggestions.push("Ensure scanner is powered on and connected via USB");
      suggestions.push("Try unplugging and reconnecting the scanner");
      suggestions.push("Check if scanner works with other software");
      
      if (process.platform === 'darwin') {
        suggestions.push("On macOS, you might need to install additional drivers from the scanner manufacturer");
      }

    } catch (error) {
      diagnostics.diagnostics_error = error instanceof Error ? error.message : 'Unknown error';
    }

    return { diagnostics, suggestions };
  }

  // Attempt to fix common scanner issues
  async attemptFix(): Promise<{ success: boolean; message: string; details?: any }> {
    try {
      this.log("Attempting to fix scanner issues...");

      // Try to restart SANE daemon (Linux)
      if (process.platform === 'linux') {
        try {
          await execAsync('sudo systemctl restart saned 2>/dev/null || true');
          this.log("Restarted SANE daemon");
        } catch {
          // Ignore if service doesn't exist
        }
      }

      // Try to reload USB modules (requires sudo on Linux)
      if (process.platform === 'linux') {
        try {
          await execAsync('sudo modprobe -r usblp && sudo modprobe usblp 2>/dev/null || true');
          this.log("Reloaded USB printer modules");
        } catch {
          // Ignore if no sudo access
        }
      }

      // Wait a moment for devices to re-enumerate
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Test scanner detection again
      const detection = await this.detectScanners();
      
      if (detection.scanners.length > 0) {
        return {
          success: true,
          message: `Successfully detected ${detection.scanners.length} scanner(s) after fix attempt`,
          details: detection.scanners
        };
      } else {
        return {
          success: false,
          message: "Fix attempt completed, but no scanners detected. Manual intervention may be required.",
          details: detection.error
        };
      }

    } catch (error) {
      return {
        success: false,
        message: `Fix attempt failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  // Get recommended scan settings for a device
  async getScanSettings(deviceId: string): Promise<{ settings: any; error?: string }> {
    try {
      const cmd = `scanimage --device-name="${deviceId}" --help`;
      const { stdout } = await execAsync(cmd);

      const settings: any = {
        device: deviceId,
        resolutions: [],
        modes: [],
        formats: ['pdf', 'pnm', 'tiff', 'png', 'jpeg'],
        sources: [],
        pageSize: []
      };

      // --source ADF Front|ADF Back|ADF Duplex [ADF Front]
      // Sources may contain spaces, capture everything up to the default value bracket
      const sourceMatch = stdout.match(/--source\s+([\w\s|]+?)\s*\[/);
      if (sourceMatch?.[1]) {
        settings.sources = sourceMatch[1].split('|').map((s: string) => s.trim());
      }

      // --mode Lineart|Halftone|Gray|Color [Lineart]
      const modeMatch = stdout.match(/--mode\s+([\w|]+)\s*\[/);
      if (modeMatch?.[1]) {
        settings.modes = modeMatch[1].split('|').map((s: string) => s.trim());
      }

      // --resolution 50..600dpi (in steps of 1) [600]
      // Either a range (min..max) or a pipe-separated list (50|75|100|...)
      const resRangeMatch = stdout.match(/--resolution\s+(\d+)\.\.(\d+)dpi/);
      const resListMatch = stdout.match(/--resolution\s+(\d+(?:\|\d+)+)/);
      if (resRangeMatch?.[1] && resRangeMatch?.[2]) {
        const min = parseInt(resRangeMatch[1]);
        const max = parseInt(resRangeMatch[2]);
        // Filter common DPI values to those within the supported range
        settings.resolutions = [50, 75, 100, 150, 200, 300, 400, 600]
            .filter(r => r >= min && r <= max);
        settings.resolutionRange = { min, max };
      } else if (resListMatch?.[1]) {
        settings.resolutions = resListMatch[1].split('|').map(Number);
      }

      return { settings };

    } catch (error) {
      return {
        settings: {},
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

}