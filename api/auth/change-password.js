import { createPreviewSelfPasswordHandler } from '../../server/supabaseAccounts.js'

export default createPreviewSelfPasswordHandler(process.env)
