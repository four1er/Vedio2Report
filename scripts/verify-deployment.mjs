import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    requirements: { type: 'string' },
  },
})

async function resolveOrigin(target) {
  assert.ok(target, 'Pass a deployed https://... URL or a Wrangler deployment JSONL path.')
  if (target.startsWith('https://') || target.startsWith('http://')) {
    return target.replace(/\/$/, '')
  }
  const records = (await readFile(target, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  const deployed = records.findLast(row => row.type === 'deploy' && row.version === 1 && row.version_id)
  const url = deployed?.targets?.find(t => t.startsWith('https://'))
  assert.ok(url, 'Wrangler deployment output did not include a public Worker URL.')
  return url.replace(/\/$/, '')
}

const origin = await resolveOrigin(positionals[0])
const videoUrl = values.url || 'https://www.youtube.com/watch?v=xRh2sVcNXQ8'
const requirements = values.requirements || ''

console.log('Verifying Worker:', origin)
const healthRes = await fetch(`${origin}/api/health`)
assert.equal(healthRes.status, 200, '/api/health should return HTTP 200')
const health = await healthRes.json()
console.log('Health:', health)
assert.equal(health.ok, true)
assert.equal(health.hasGeminiKey, true, 'GEMINI_API_KEY must be configured on the Worker')

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
})

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const summaryRequests = []

  page.on('request', req => {
    if (/\/api\/articles\/[a-f0-9]{64}\/chapters\/ch-\d+\/summary$/.test(new URL(req.url()).pathname)) {
      summaryRequests.push({ method: req.method(), url: req.url(), postData: req.postData() ?? '' })
    }
  })

  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.fill('#video', videoUrl)
  if (requirements) await page.fill('#requirements', requirements)

  let streamFinished = false
  let samplesBeforeFinish = 0
  let maxCharsBeforeFinish = 0

  const streamDone = page.waitForResponse(
    res => new URL(res.url()).pathname === '/api/articles' && res.status() === 200,
    { timeout: 60_000 },
  )

  const startedAt = Date.now()
  await page.click('#submit')

  const poll = (async () => {
    let prev = 0
    while (!streamFinished) {
      const len = await page.evaluate(() => (document.querySelector('#body')?.textContent?.trim().length ?? 0))
      if (len > prev) {
        samplesBeforeFinish++
        maxCharsBeforeFinish = len
        prev = len
      }
      await page.waitForTimeout(250)
    }
  })()

  const articleRes = await streamDone
  await page.waitForFunction(
    () => (document.querySelector('#reader-status')?.textContent ?? '').includes('生成完成'),
    { timeout: 240_000 },
  )
  streamFinished = true
  await poll

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  const chapterCount = await page.locator('.chapter-head .summary-toggle').count()
  console.log({
    status: articleRes.status(),
    elapsedSec,
    samplesBeforeFinish,
    maxCharsBeforeFinish,
    chapterCount,
  })
  assert.ok(samplesBeforeFinish >= 2, 'Expected incremental streaming renders before completion')
  assert.ok(chapterCount >= 1, 'Expected at least one chapter with a [5W1H] button')

  // Verify chapter 5W1H requests empty body and renders all 6 structured rows
  const firstBtn = page.locator('.chapter-head .summary-toggle').first()
  const summaryPromise = page.waitForResponse(
    res => /\/api\/articles\/[a-f0-9]{64}\/chapters\/ch-1\/summary$/.test(new URL(res.url()).pathname),
    { timeout: 60_000 },
  )
  await firstBtn.click()
  const summaryRes = await summaryPromise
  assert.equal(summaryRes.status(), 200)
  const summaryJson = await summaryRes.json()

  for (const key of ['who', 'what', 'when', 'where', 'why', 'how']) {
    assert.equal(typeof summaryJson[key], 'string')
    assert.ok(summaryJson[key].trim().length > 0, `5W1H field ${key} must be non-empty`)
  }
  assert.equal(summaryRequests.length, 1)
  assert.equal(summaryRequests[0].postData, '', '5W1H request must not resubmit article body')

  await page.locator('.summary-box .summary-row').nth(5).waitFor({ state: 'visible', timeout: 10_000 })
  const renderedRows = await page.locator('.summary-box .summary-row').count()
  assert.equal(renderedRows, 6, '5W1H panel must render all 6 structured fields')
  console.log('Verified chapter 1 5W1H:', summaryJson)
} finally {
  await browser.close()
}
