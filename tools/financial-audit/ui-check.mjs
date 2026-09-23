import assert from 'node:assert/strict'
import { chromium } from '/Users/thewa/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'

// Requires serve-preview.mjs. No production session or data; every non-loopback request is blocked.
const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    for (const view of ['order', 'piutang']) {
      for (const outcome of ['uncertain', 'throw', 'success']) {
        const page = await browser.newPage({ viewport })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('dialog', dialog => dialog.dismiss())
        await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
        await page.goto(`http://127.0.0.1:5192/tools/financial-audit/preview.html?view=${view}&outcome=${outcome}`)
        if (view === 'order') {
          await page.getByRole('button', { name: 'Buka Rincian' }).click()
          if (viewport.width > 480) await page.getByTitle('Lainnya', { exact: true }).click()
          await page.getByRole('button', { name: 'Bayar', exact: true }).click()
        } else {
          await page.getByRole('button', { name: /Admin Uji/ }).click()
          await page.getByRole('button', { name: /Bayar Gabungan/ }).first().click()
        }
        const input = page.locator('input[inputmode="numeric"]').last()
        await input.fill('30000')
        await page.getByRole('button', { name: /QRIS/ }).click()
        await page.getByRole('button', { name: 'Konfirmasi', exact: true }).click()
        await page.waitForFunction(() => window.paymentProbe.calls === 1)
        if (outcome === 'success') {
          await page.getByRole('button', { name: 'Konfirmasi', exact: true }).waitFor({ state: 'hidden' })
        } else {
          await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('Konfirmasi') && button.disabled))
          assert.equal(await input.inputValue(), '30.000', 'Keep amount after uncertain result')
          assert.ok((await page.locator('body').innerText()).match(/belum terkonfirmasi|periksa|rekonsiliasi/i))
          await page.screenshot({ path: `/private/tmp/skupy-financial-${view}-${outcome}-${viewport.width}.png`, fullPage: true })
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
          assert.equal(overflow, false, 'No horizontal page overflow')
          await page.getByRole('button', { name: 'Batal', exact: true }).click()
          if (view === 'order') {
            if (viewport.width > 480) await page.getByTitle('Lainnya', { exact: true }).click()
            await page.getByRole('button', { name: 'Bayar', exact: true }).click()
          } else await page.getByRole('button', { name: /Bayar Gabungan/ }).first().click()
          assert.equal(await page.getByRole('button', { name: 'Konfirmasi', exact: true }).isEnabled(), false, 'Closing and reopening cannot bypass uncertainty guard')
          assert.equal(await input.inputValue(), '30.000')
        }
        assert.equal(await page.evaluate(() => window.paymentProbe.calls), 1)
        const inputs = await page.evaluate(() => window.paymentProbe.inputs[0])
        assert.equal(view === 'order' ? inputs[2] : inputs[0].paymentMethod, 'qris', 'Selected tender reaches callback')
        assert.deepEqual(errors, [], 'No uncaught UI errors')
        console.log(`PASS ${view} ${outcome} ${viewport.width}x${viewport.height}`)
        await page.close()
      }
    }
    for (const source of ['debt_payments', 'expenses']) {
      const page = await browser.newPage({ viewport })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
      await page.goto(`http://127.0.0.1:5192/tools/financial-audit/preview.html?view=accounting&fail=${source}`)
      await page.getByText('Kas Masuk', { exact: true }).waitFor()
      await page.waitForFunction(() => (document.body.innerText.match(/Tidak tersedia/g) || []).length >= 3)
      await page.waitForFunction(() => document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).every(a => a.playState !== 'running'))
      if (source === 'expenses') {
        const profit = page.getByText('Laba Bersih Periode', { exact: true }).locator('../..')
        assert.match(await profit.innerText(), /Tidak tersedia/, 'Failed outflow cannot produce a numeric profit')
      }
      await page.getByText('Kas Masuk', { exact: true }).scrollIntoViewIfNeeded()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, [])
      await page.screenshot({ path: `/private/tmp/skupy-accounting-${source}-${viewport.width}.png` })
      console.log(`PASS accounting ${source} unavailable ${viewport.width}x${viewport.height}`)
      await page.close()
    }
  }
} finally { await browser.close() }
