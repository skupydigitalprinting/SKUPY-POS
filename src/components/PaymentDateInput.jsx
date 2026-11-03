import React, { useId } from 'react'
import { paymentDay, validPaymentDay } from '../utils/paymentDates'

export const getWIBDate = paymentDay

export function isValidPaymentDate(value, today = getWIBDate()) {
  return validPaymentDay(value) && value <= today
}

export default function PaymentDateInput({ value, onChange, disabled = false }) {
  const id = useId()
  return <div className="min-w-0">
    <label htmlFor={id} className="block text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
      Tanggal Pembayaran (WIB) <span style={{ color: 'var(--red)' }}>*</span>
    </label>
    <input id={id} name="paymentDate" type="date" required min="1900-01-01" max={getWIBDate()}
      value={value} onChange={event => onChange(event.target.value)} disabled={disabled}
      className="block w-full min-w-0 max-w-full rounded-lg px-3 py-2 text-sm"
      style={{ colorScheme: 'dark', background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
  </div>
}
