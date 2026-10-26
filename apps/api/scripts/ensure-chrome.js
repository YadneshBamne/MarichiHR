// Runs after `tsc` in `npm run build`: makes sure Puppeteer's Chrome (for payslip PDFs) is in .cache/puppeteer inside
// the project. Puppeteer only downloads it in its own install step, which hosts with a package cache (Render) skip
// on later builds, leaving the running service without Chrome. Skipped where a system Chrome is used (Docker image)
// or downloads are switched off (CI).
const { execSync } = require('child_process')
const path = require('path')

if (process.env.PUPPETEER_SKIP_DOWNLOAD === 'true' || process.env.PUPPETEER_EXECUTABLE_PATH) {
  console.log('[ensure-chrome] skipped (system Chrome or downloads off)')
  process.exit(0)
}
try {
  // Installs the Chrome version this Puppeteer release expects; a no-op when it is already there
  execSync('npx --no-install puppeteer browsers install chrome', { stdio: 'inherit', cwd: path.join(__dirname, '..') })
} catch (e) {
  // Never fail the API build over the PDF browser: PDFs answer 503 with the reason instead
  console.warn('[ensure-chrome] could not install Chrome:', e.message)
}
