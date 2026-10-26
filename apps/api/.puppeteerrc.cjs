// Same Chrome location as the repository root's .puppeteerrc.cjs, for when the API starts from apps/api
const { join } = require('path')

module.exports = { cacheDirectory: join(__dirname, '..', '..', '.cache', 'puppeteer') }
