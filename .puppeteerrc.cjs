// Keep Puppeteer's Chrome inside the project. Hosts like Render only keep the project folder between the build and
// the running service, so the default cache in the home folder is gone at runtime ("Could not find Chrome").
const { join } = require('path')

module.exports = { cacheDirectory: join(__dirname, '.cache', 'puppeteer') }
