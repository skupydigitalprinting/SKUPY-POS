import { createPreviewLoginHandler } from '../../server/supabaseUsername.js'

export default async function handler(req, res) {
  return createPreviewLoginHandler(process.env)(req, res)
}
