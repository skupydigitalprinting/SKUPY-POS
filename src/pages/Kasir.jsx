import React, { useState, useMemo } from 'react'
import {
  Search, ShoppingCart, Plus, Minus, Trash2, Tag, Receipt, Printer,
  CheckCircle2, X, Package, User, Calendar,
} from 'lucide-react'
import { CATEGORIES, PAYMENT_METHODS } from '../data/dummyData'
import { formatRupiah, toDateInputValue } from '../utils/helpers'
import { Button, ProductImage, EmptyState } from '../components/ui'
import Invoice from '../components/Invoice'

export default function Kasir({ products, customers = [], addTransaction, storeInfo, busy }) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [cart, setCart] = useState([])
  const [discount, setDiscount] = useState(0)
  const [discountType, setDiscountType] = useState('nominal')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [customerName, setCustomerName] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [dp, setDp] = useState('')
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 14)
    return toDateInputValue(d)
  })
  const [successTrx, setSuccessTrx] = useState(null)
  const [showInvoice, setShowInvoice] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
  const [checkingOut, setCheckingOut] = useState(false)
  const [checkoutError, setCheckoutError] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')

  const filtered = useMemo(() => {
    return products.filter((p) => {
      const matchCat = category === 'all' || p.category === category
      const matchSearch = p.name.toLowerCase().includes(search.toLowerCase())
      return matchCat && matchSearch
    })
  }, [products, search, category])

  const addToCart = (product) => {
    if (product.stock === 0) return
    setCart((prev) => {
      const existing = prev.find((i) => i.productId === product.id)
      if (existing) {
        if (existing.qty >= product.stock) return prev
        return prev.map((i) =>
          i.productId === product.id ? { ...i, qty: i.qty + 1 } : i
        )
      }
      return [
        ...prev,
        {
          productId: product.id,
          name: product.name,
          price: product.price,
          qty: 1,
          image: product.image,
          stock: product.stock,
        },
      ]
    })
  }

  const updateQty = (productId, delta) => {
    setCart((prev) =>
      prev
        .map((i) => {
          if (i.productId !== productId) return i
          const next = i.qty + delta
          if (next > i.stock) return i
          return { ...i, qty: next }
        })
        .filter((i) => i.qty > 0)
    )
  }

  const removeItem = (productId) =>
    setCart((prev) => prev.filter((i) => i.productId !== productId))

  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0)
  const discountAmount =
    discountType === 'persen'
      ? Math.round((subtotal * Number(discount || 0)) / 100)
      : Math.min(subtotal, Number(discount) || 0)
  const afterDiscount = Math.max(0, subtotal - discountAmount)
  const taxAmount = 0
  const total = afterDiscount
  const dpAmount = Number(dp) || 0
  const remaining = Math.max(0, total - dpAmount)

  const handleCheckout = async () => {
    if (cart.length === 0 || checkingOut) return
    if (paymentMethod === 'hutang' && !customerId) {
      setCheckoutError('Customer wajib dipilih untuk pembayaran Hutang/Tempo')
      return
    }
    setCheckingOut(true)
    setCheckoutError('')
    try {
      const isHutang = paymentMethod === 'hutang'
      const paidAmt = isHutang
        ? (dpAmount > 0 ? Math.min(total, dpAmount) : 0)
        : Math.min(total, dpAmount > 0 ? dpAmount : total)
      const remainingAmt = isHutang ? Math.max(0, total - paidAmt) : (dpAmount > 0 ? remaining : 0)

      const picked = customerId ? customers.find(c => c.id === customerId) : null
      const trx = {
        customer: customerName.trim() || 'Umum',
        customerId: customerId || null,
        customerPhone: picked?.whatsapp || picked?.phone || '',
        customerAddress: picked?.address || '',
        items: cart.map(({ stock, ...rest }) => rest),
        subtotal,
        discount: discountAmount,
        tax: taxAmount,
        total,
        paid: paidAmt,
        dp: paidAmt,
        remaining: remainingAmt,
        paymentMethod,
        status: remainingAmt > 0 ? 'pending' : 'lunas',
        dueDate: isHutang ? dueDate : null,
      }
      const result = await addTransaction(trx)
      if (!result.ok) {
        setCheckoutError(result.error || 'Gagal memproses transaksi')
        return
      }
      setSuccessTrx(result.data)
      setCart([])
      setDiscount(0)
      setDp('')
      setCustomerName('')
      setCustomerId('')
      setPaymentMethod('cash')
      setCartOpen(false)
      setShowInvoice(false)
    } catch (err) {
      setCheckoutError(err.message || 'Terjadi kesalahan')
    } finally {
      setCheckingOut(false)
    }
  }

  const cartCount = cart.reduce((s, i) => s + i.qty, 0)

  // --- Cart UI (reused for desktop column + mobile drawer) ---
  const cartContent = (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-secondary)' }}>
      {/* Cart Header */}
      <div className="px-4 sm:px-5 py-4 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--border)' }}>
        <ShoppingCart size={16} style={{ color: 'var(--accent-light)' }} />
        <span className="font-bold text-sm"
          style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
          Keranjang
        </span>
        {cart.length > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full font-bold"
            style={{
              background: 'linear-gradient(135deg, var(--accent), #6366f1)',
              color: '#fff',
              fontFamily: 'Syne',
              boxShadow: '0 2px 8px rgba(139,92,246,0.4)',
            }}>
            {cartCount}
          </span>
        )}
        <button
          onClick={() => setCartOpen(false)}
          className="lg:hidden ml-auto w-8 h-8 flex items-center justify-center rounded-lg"
          style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Customer picker */}
      <div className="px-4 py-3 space-y-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="relative">
          <User size={13} className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-muted)' }} />
          <input
            value={customerName}
            onChange={(e) => {
              setCustomerName(e.target.value)
              setCustomerSearch(e.target.value)
              setCustomerId('')
            }}
            placeholder={paymentMethod === 'hutang' ? 'Pilih customer (wajib)' : 'Nama pelanggan (opsional)'}
            className="w-full pl-8 pr-3 py-2 rounded-xl text-xs"
            style={{
              background: 'var(--bg-card)',
              border: `1px solid ${paymentMethod === 'hutang' && !customerId ? 'rgba(245,158,11,0.4)' : 'var(--border)'}`,
              color: 'var(--text-primary)',
            }}
          />
        </div>
        {customerSearch && !customerId && customers.length > 0 && (() => {
          const q = customerSearch.toLowerCase()
          const matches = customers.filter(c =>
            c.name.toLowerCase().includes(q) || (c.phone || '').includes(q)
          ).slice(0, 5)
          if (matches.length === 0) return null
          return (
            <div className="rounded-xl overflow-hidden max-h-40 overflow-y-auto"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
              {matches.map(c => (
                <button key={c.id}
                  onClick={() => {
                    setCustomerId(c.id)
                    setCustomerName(c.name)
                    setCustomerSearch('')
                    // Capture phone+address for invoice
                    if (c.whatsapp || c.phone) {
                      // these will be passed when checkout completes
                    }
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-white/[0.03] transition-all"
                  style={{ borderBottom: '1px solid var(--border)' }}>
                  <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {c.name}
                  </p>
                  <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                    {c.phone || '-'} {c.totalDebt > 0 && <span style={{ color: '#f59e0b' }}>• Hutang {formatRupiah(c.totalDebt)}</span>}
                  </p>
                </button>
              ))}
            </div>
          )
        })()}
        {customerId && (
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs"
            style={{ background: 'rgba(16,217,138,0.08)', border: '1px solid rgba(16,217,138,0.25)', color: '#10d98a' }}>
            <CheckCircle2 size={11} />
            <span className="font-semibold truncate" style={{ fontFamily: 'Syne' }}>Customer terpilih</span>
            <button onClick={() => { setCustomerId(''); setCustomerName('') }}
              className="ml-auto" style={{ color: '#10d98a' }}>
              <X size={11} />
            </button>
          </div>
        )}
      </div>

      {/* Cart Items */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 min-h-0">
        {cart.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 py-8">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)' }}>
              <ShoppingCart size={26} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
            </div>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-secondary)', fontFamily: 'Syne' }}>
              Keranjang Kosong
            </p>
            <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
              Klik produk untuk menambahkan
            </p>
          </div>
        ) : (
          cart.map((item) => (
            <div key={item.productId}
              className="flex items-center gap-2.5 p-2.5 rounded-xl animate-slideInRight"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <ProductImage
                src={item.image}
                alt={item.name}
                className="w-10 h-10 rounded-lg object-cover flex-shrink-0"
                fallbackSize={40}
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  {item.name}
                </p>
                <p className="text-xs font-bold" style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
                  {formatRupiah(item.price * item.qty)}
                </p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => updateQty(item.productId, -1)}
                  className="w-6 h-6 rounded-lg flex items-center justify-center btn-press"
                  style={{
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <Minus size={10} />
                </button>
                <span className="w-6 text-center text-xs font-bold"
                  style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>
                  {item.qty}
                </span>
                <button
                  onClick={() => updateQty(item.productId, 1)}
                  className="w-6 h-6 rounded-lg flex items-center justify-center btn-press"
                  style={{
                    background: 'rgba(139,92,246,0.15)',
                    color: 'var(--accent-light)',
                    border: '1px solid rgba(139,92,246,0.25)',
                  }}
                >
                  <Plus size={10} />
                </button>
                <button
                  onClick={() => removeItem(item.productId)}
                  className="w-6 h-6 rounded-lg flex items-center justify-center ml-1 btn-press"
                  style={{
                    background: 'rgba(255,77,106,0.1)',
                    color: 'var(--red)',
                    border: '1px solid rgba(255,77,106,0.2)',
                  }}
                >
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Summary */}
      <div className="px-4 py-3 space-y-3 flex-shrink-0"
        style={{ borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.15)' }}>
        {/* Discount */}
        <div className="flex items-center gap-2">
          <Tag size={13} style={{ color: 'var(--text-muted)' }} />
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Diskon</span>
          <div className="flex gap-1 ml-auto">
            <button
              onClick={() => setDiscountType('nominal')}
              className="text-xs px-2 py-0.5 rounded-lg font-semibold"
              style={{
                background: discountType === 'nominal' ? 'var(--accent)' : 'var(--bg-card)',
                color: discountType === 'nominal' ? '#fff' : 'var(--text-muted)',
                fontFamily: 'Syne',
              }}
            >
              Rp
            </button>
            <button
              onClick={() => setDiscountType('persen')}
              className="text-xs px-2 py-0.5 rounded-lg font-semibold"
              style={{
                background: discountType === 'persen' ? 'var(--accent)' : 'var(--bg-card)',
                color: discountType === 'persen' ? '#fff' : 'var(--text-muted)',
                fontFamily: 'Syne',
              }}
            >
              %
            </button>
          </div>
          <input
            type="number"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            className="w-20 px-2 py-1 rounded-lg text-xs text-right"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
            min={0}
          />
        </div>

        {/* Totals */}
        <div className="space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-muted)' }}>Subtotal</span>
            <span style={{ color: 'var(--text-secondary)' }}>{formatRupiah(subtotal)}</span>
          </div>
          {discountAmount > 0 && (
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>Diskon</span>
              <span style={{ color: 'var(--red)' }}>-{formatRupiah(discountAmount)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold pt-1.5 mt-1"
            style={{ borderTop: '1px dashed var(--border)' }}>
            <span style={{ color: 'var(--text-primary)', fontFamily: 'Syne' }}>Total</span>
            <span className="text-base"
              style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}>
              {formatRupiah(total)}
            </span>
          </div>
        </div>

        {/* DP */}
        <div className="flex items-center gap-2">
          <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
            DP / Bayar
          </span>
          <input
            type="number"
            value={dp}
            onChange={(e) => setDp(e.target.value)}
            placeholder={`Bayar lunas: ${formatRupiah(total)}`}
            className="flex-1 px-2 py-1 rounded-lg text-xs text-right min-w-0"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
          />
        </div>
        {dpAmount > 0 && remaining > 0 && (
          <div className="flex justify-between text-xs px-2 py-1.5 rounded-lg"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Sisa</span>
            <span style={{ color: 'var(--amber)', fontWeight: 700, fontFamily: 'Syne' }}>
              {formatRupiah(remaining)}
            </span>
          </div>
        )}

        {/* Payment Method */}
        <div className="grid grid-cols-2 gap-1.5">
          {PAYMENT_METHODS.map((m) => {
            const isHutang = m.id === 'hutang'
            const active = paymentMethod === m.id
            return (
              <button
                key={m.id}
                onClick={() => setPaymentMethod(m.id)}
                className="flex flex-col items-center gap-1 py-2 rounded-xl text-xs font-medium transition-all"
                style={{
                  background: active
                    ? (isHutang ? 'rgba(245,158,11,0.15)' : 'rgba(139,92,246,0.15)')
                    : 'var(--bg-card)',
                  border: `1px solid ${active
                    ? (isHutang ? 'rgba(245,158,11,0.4)' : 'rgba(139,92,246,0.4)')
                    : 'var(--border)'}`,
                  color: active
                    ? (isHutang ? '#f59e0b' : 'var(--accent-light)')
                    : 'var(--text-muted)',
                  fontFamily: 'Syne',
                }}
              >
                <span className="text-sm">{m.icon}</span>
                {m.label}
              </button>
            )
          })}
        </div>

        {/* Hutang due-date picker */}
        {paymentMethod === 'hutang' && (
          <div className="rounded-xl p-3 animate-fadeIn"
            style={{
              background: 'rgba(245,158,11,0.06)',
              border: '1px solid rgba(245,158,11,0.25)',
            }}>
            <div className="flex items-center gap-2 mb-2">
              <Calendar size={12} style={{ color: '#f59e0b' }} />
              <span className="text-xs font-semibold" style={{ color: '#f59e0b', fontFamily: 'Syne' }}>
                Jatuh Tempo
              </span>
            </div>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-2 py-1.5 rounded-lg text-xs"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}
            />
            {!customerId && (
              <p className="text-xs mt-2" style={{ color: '#f59e0b' }}>
                ⚠️ Customer wajib dipilih untuk Hutang
              </p>
            )}
          </div>
        )}

        {/* Buttons */}
        {checkoutError && (
          <div className="px-3 py-2 rounded-xl text-xs font-semibold animate-fadeIn"
            style={{
              background: 'rgba(255,77,106,0.08)',
              color: '#ff4d6a',
              border: '1px solid rgba(255,77,106,0.25)',
            }}>
            ⚠️ {checkoutError}
          </div>
        )}
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="md"
            className="flex-1"
            onClick={handleCheckout}
            disabled={cart.length === 0 || checkingOut}
          >
            {checkingOut ? (
              <>
                <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Memproses...
              </>
            ) : (
              <>
                <Receipt size={15} />
                Checkout
              </>
            )}
          </Button>
          {cart.length > 0 && (
            <button
              onClick={() => setCart([])}
              disabled={checkingOut}
              className="px-3 py-2 rounded-xl btn-press disabled:opacity-50"
              style={{
                background: 'rgba(255,77,106,0.1)',
                color: 'var(--red)',
                border: '1px solid rgba(255,77,106,0.2)',
              }}
              title="Kosongkan keranjang"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
      {/* Product Area */}
      <div
        className="flex flex-col flex-1 overflow-hidden"
        style={{ borderRight: '1px solid var(--border)' }}
      >
        {/* Search & Filter */}
        <div
          className="px-4 sm:px-5 py-3 sm:py-4 flex flex-col gap-3 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
        >
          <div className="relative">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--text-muted)' }}
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari produk..."
              className="w-full pl-9 pr-9 py-2.5 rounded-xl text-sm"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2"
              >
                <X size={13} style={{ color: 'var(--text-muted)' }} />
              </button>
            )}
          </div>
          {/* Categories */}
          <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar -mx-1 px-1">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all"
                style={{
                  background: category === c.id
                    ? 'linear-gradient(135deg, var(--accent), #6366f1)'
                    : 'var(--bg-card)',
                  color: category === c.id ? '#fff' : 'var(--text-secondary)',
                  border: `1px solid ${category === c.id ? 'transparent' : 'var(--border)'}`,
                  fontFamily: 'Syne',
                  boxShadow: category === c.id ? '0 2px 12px rgba(139,92,246,0.3)' : 'none',
                }}
              >
                <span>{c.icon}</span> {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Product Grid */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4">
          {filtered.length === 0 ? (
            <EmptyState
              icon={Package}
              title="Produk tidak ditemukan"
              description="Coba ubah kata kunci atau kategori"
            />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
              {filtered.map((p) => {
                const inCart = cart.find((i) => i.productId === p.id)
                const outOfStock = p.stock === 0
                return (
                  <div
                    key={p.id}
                    onClick={() => addToCart(p)}
                    className="product-card rounded-2xl overflow-hidden cursor-pointer relative"
                    style={{
                      background: 'var(--bg-card)',
                      border: `1px solid ${inCart ? 'rgba(139,92,246,0.4)' : 'var(--border)'}`,
                      opacity: outOfStock ? 0.5 : 1,
                      cursor: outOfStock ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <div className="relative aspect-square">
                      <ProductImage
                        src={p.image}
                        alt={p.name}
                        className="w-full h-full object-cover"
                        fallbackSize={80}
                      />
                      <div className="absolute inset-0 pointer-events-none"
                        style={{
                          background: 'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.4) 100%)',
                        }} />
                      {inCart && (
                        <div
                          className="absolute top-2 right-2 min-w-6 h-6 px-1.5 rounded-full flex items-center justify-center text-xs font-bold animate-scaleIn"
                          style={{
                            background: 'linear-gradient(135deg, var(--accent), #6366f1)',
                            color: '#fff',
                            fontFamily: 'Syne',
                            boxShadow: '0 4px 12px rgba(139,92,246,0.5)',
                          }}
                        >
                          {inCart.qty}
                        </div>
                      )}
                      {outOfStock && (
                        <div
                          className="absolute inset-0 flex items-center justify-center"
                          style={{ background: 'rgba(0,0,0,0.55)' }}
                        >
                          <span
                            className="text-xs font-bold px-3 py-1 rounded-full"
                            style={{
                              background: 'rgba(255,77,106,0.2)',
                              color: 'var(--red)',
                              border: '1px solid rgba(255,77,106,0.3)',
                              fontFamily: 'Syne',
                            }}
                          >
                            Stok Habis
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <p
                        className="text-xs font-semibold leading-tight mb-1 line-clamp-2"
                        style={{ color: 'var(--text-primary)', minHeight: 32 }}
                      >
                        {p.name}
                      </p>
                      <p
                        className="text-sm font-bold"
                        style={{ color: 'var(--accent-light)', fontFamily: 'Syne' }}
                      >
                        {formatRupiah(p.price)}
                      </p>
                      <p
                        className="text-xs mt-0.5"
                        style={{ color: p.stock < 5 ? 'var(--amber)' : 'var(--text-muted)' }}
                      >
                        Stok: {p.stock}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Desktop Cart */}
      <div className="hidden lg:flex flex-col"
        style={{ width: 340, minWidth: 320 }}>
        {cartContent}
      </div>

      {/* Mobile Cart FAB */}
      <button
        onClick={() => setCartOpen(true)}
        className="lg:hidden fixed bottom-5 right-5 z-30 flex items-center gap-2 px-4 py-3 rounded-2xl font-bold text-sm btn-press"
        style={{
          background: 'linear-gradient(135deg, var(--accent), #6366f1)',
          color: '#fff',
          boxShadow: '0 8px 24px rgba(139,92,246,0.5)',
          fontFamily: 'Syne',
        }}
      >
        <ShoppingCart size={16} />
        Keranjang
        {cartCount > 0 && (
          <span className="bg-white text-purple-700 text-xs px-2 py-0.5 rounded-full font-bold">
            {cartCount}
          </span>
        )}
      </button>

      {/* Mobile Cart Drawer */}
      {cartOpen && (
        <>
          <div className="lg:hidden fixed inset-0 z-40 drawer-overlay"
            onClick={() => setCartOpen(false)} />
          <div className="lg:hidden fixed right-0 top-0 bottom-0 z-50 animate-slideInRight"
            style={{ width: 'min(360px, 90vw)' }}>
            {cartContent}
          </div>
        </>
      )}

      {/* Success Modal */}
      {successTrx && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fadeIn"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)' }}
        >
          <div
            className="animate-scaleIn rounded-2xl p-6 w-full max-w-sm text-center"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid rgba(16,217,138,0.3)',
              boxShadow: '0 24px 80px rgba(0,0,0,0.5), 0 0 40px rgba(16,217,138,0.15)',
            }}
          >
            <div className="flex justify-center mb-4">
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center animate-float"
                style={{
                  background: 'rgba(16,217,138,0.12)',
                  border: '2px solid rgba(16,217,138,0.4)',
                  boxShadow: '0 0 32px rgba(16,217,138,0.3)',
                }}
              >
                <CheckCircle2 size={36} style={{ color: '#10d98a' }} />
              </div>
            </div>
            <h3 className="font-bold text-xl mb-1"
              style={{ fontFamily: 'Syne', color: 'var(--text-primary)' }}>
              Transaksi Berhasil!
            </h3>
            <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
              {successTrx.invoiceNo}
            </p>
            <p className="text-3xl font-bold mb-4"
              style={{ fontFamily: 'Syne', color: '#10d98a' }}>
              {formatRupiah(successTrx.total)}
            </p>
            {successTrx.remaining > 0 && (
              <div className="mb-4 px-3 py-2 rounded-xl text-sm"
                style={{
                  background: 'rgba(245,158,11,0.1)',
                  color: '#f59e0b',
                  border: '1px solid rgba(245,158,11,0.2)',
                }}>
                Sisa pembayaran: <strong>{formatRupiah(successTrx.remaining)}</strong>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setShowInvoice(true)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold btn-press"
                style={{
                  background: 'var(--bg-card)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  fontFamily: 'Syne',
                }}
              >
                <Printer size={15} />
                Print
              </button>
              <button
                onClick={() => setSuccessTrx(null)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold btn-press"
                style={{
                  background: 'linear-gradient(135deg, var(--accent), #6366f1)',
                  color: '#fff',
                  fontFamily: 'Syne',
                  boxShadow: '0 4px 16px rgba(139,92,246,0.35)',
                }}
              >
                Selesai
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invoice Modal */}
      {showInvoice && successTrx && (
        <Invoice transaction={successTrx} storeInfo={storeInfo} onClose={() => setShowInvoice(false)} />
      )}
    </div>
  )
}
