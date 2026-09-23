import { createPreviewRecoveryHandler } from '../../server/supabaseRecovery.js'

export default async function handler(req, res) {
  return createPreviewRecoveryHandler(process.env)(req, res)
}
