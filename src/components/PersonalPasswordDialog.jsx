import React, { useState } from 'react'
import Modal from './Modal'
import SelfPasswordChange from './SelfPasswordChange'
import { authSession } from '../lib/authRuntime'
import { supabase } from '../lib/supabase'
import { captureAccountSession } from '../lib/accountSession'

export default function PersonalPasswordDialog({ currentUser, onClose }) {
  const [session] = useState(() => captureAccountSession(authSession, supabase.auth))
  return <Modal open onClose={onClose} title="Akun Saya" size="sm">
    <SelfPasswordChange currentUser={currentUser} {...session} />
  </Modal>
}
