-- GENERATED schema-only fixture; never execute against a real project.
-- No table records, Auth accounts, Storage records, or credentials are exported.
-- Core gen_random_uuid() suffices; unrelated platform extensions are not installed.
-- Event-trigger function is retained; no event-trigger binding was supplied.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
CREATE TABLE public."accounting_entries" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "entry_date" date DEFAULT now() NOT NULL,
  "source_type" text NOT NULL,
  "source_id" uuid,
  "invoice_no" text,
  "account_code" text NOT NULL,
  "debit" numeric DEFAULT 0 NOT NULL,
  "credit" numeric DEFAULT 0 NOT NULL,
  "description" text DEFAULT ''::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "cashier_id" uuid
);
CREATE TABLE public."accounts" (
  "code" text NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "normal" text DEFAULT 'debit'::text NOT NULL
);
CREATE TABLE public."admin_bank_accounts" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "admin_id" uuid NOT NULL,
  "bank_name" text NOT NULL,
  "account_number" text NOT NULL,
  "account_holder" text NOT NULL,
  "branch" text,
  "note" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."admin_book_access" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "admin_id" uuid NOT NULL,
  "book_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public."admin_invoice_profiles" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "admin_id" uuid NOT NULL,
  "location_id" uuid,
  "contact_id" uuid,
  "bank_account_id" uuid,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."admins" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "username" text NOT NULL,
  "password" text NOT NULL,
  "name" text DEFAULT ''::text,
  "role" text DEFAULT 'staff'::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);
CREATE TABLE public."asset_categories" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."asset_purchase_payments" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "asset_id" uuid NOT NULL,
  "payment_date" date DEFAULT (now())::date NOT NULL,
  "amount" numeric NOT NULL,
  "payment_method" text DEFAULT 'transfer'::text NOT NULL,
  "payment_type" text DEFAULT 'installment'::text NOT NULL,
  "note" text DEFAULT ''::text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."asset_sales" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "asset_id" uuid NOT NULL,
  "sale_date" date NOT NULL,
  "sale_price" numeric NOT NULL,
  "book_value" numeric DEFAULT 0 NOT NULL,
  "gain_loss" numeric DEFAULT 0 NOT NULL,
  "payment_method" text DEFAULT 'transfer'::text NOT NULL,
  "note" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."assets" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "category" text DEFAULT ''::text,
  "value" numeric DEFAULT 0 NOT NULL,
  "acquired_at" date DEFAULT now(),
  "note" text DEFAULT ''::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone,
  "category_id" uuid,
  "category_name" text,
  "created_by" uuid,
  "updated_by" uuid,
  "depreciation_method" text DEFAULT 'percentage'::text,
  "depreciation_rate" numeric DEFAULT 0,
  "useful_life_years" integer,
  "residual_value" numeric DEFAULT 0,
  "purchase_price" numeric DEFAULT 0,
  "purchase_date" date,
  "status" text DEFAULT 'active'::text,
  "notes" text,
  "photo_url" text,
  "updated_at" timestamp with time zone DEFAULT now(),
  "sold_date" date,
  "sold_price" numeric,
  "supplier_name" text DEFAULT ''::text,
  "payment_due_date" date,
  "payment_tracking" boolean DEFAULT false NOT NULL
);
CREATE TABLE public."bank_loan_payments" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "loan_id" uuid,
  "paid_at" timestamp with time zone DEFAULT now(),
  "amount" numeric DEFAULT 0 NOT NULL,
  "pokok" numeric DEFAULT 0 NOT NULL,
  "bunga" numeric DEFAULT 0 NOT NULL,
  "method" text DEFAULT 'cash'::text,
  "note" text DEFAULT ''::text,
  "cashier_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now(),
  "payment_number" integer
);
CREATE TABLE public."bank_loans" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "nama_bank" text NOT NULL,
  "jenis_pinjaman" text DEFAULT ''::text,
  "nomor_kontrak" text DEFAULT ''::text,
  "tanggal_mulai" date,
  "tanggal_jatuh_tempo" date,
  "plafon_pinjaman" numeric DEFAULT 0 NOT NULL,
  "sisa_pokok" numeric DEFAULT 0 NOT NULL,
  "bunga" numeric DEFAULT 0,
  "cicilan_bulanan" numeric DEFAULT 0,
  "keterangan" text DEFAULT ''::text,
  "status" text DEFAULT 'aktif'::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "pokok_awal" numeric,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."books" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "brand_name" text,
  "prefix" text,
  "logo_url" text,
  "description" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."cash_movements" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "moved_at" timestamp with time zone DEFAULT now(),
  "direction" text NOT NULL,
  "method" text DEFAULT 'cash'::text,
  "amount" numeric DEFAULT 0 NOT NULL,
  "source_type" text,
  "source_id" uuid,
  "invoice_no" text,
  "note" text DEFAULT ''::text,
  "cashier_id" uuid
);
CREATE TABLE public."credibook_income" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "transaction_date" date NOT NULL,
  "amount" numeric DEFAULT 0 NOT NULL,
  "payment_method" text DEFAULT 'transfer'::text NOT NULL,
  "note" text,
  "book_id" uuid,
  "created_by" uuid,
  "created_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "income_type" text DEFAULT 'other'::text NOT NULL
);
CREATE TABLE public."customer_owner_changes" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid,
  "customer_name" text,
  "old_owner_id" uuid,
  "old_owner_name" text,
  "new_owner_id" uuid,
  "new_owner_name" text,
  "changed_by" uuid,
  "changed_by_name" text,
  "changed_at" timestamp with time zone DEFAULT now()
);
CREATE TABLE public."customers" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "phone" text DEFAULT ''::text,
  "whatsapp" text DEFAULT ''::text,
  "address" text DEFAULT ''::text,
  "email" text DEFAULT ''::text,
  "notes" text DEFAULT ''::text,
  "total_transactions" integer DEFAULT 0,
  "total_spent" numeric DEFAULT 0,
  "total_debt" numeric DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "created_by" uuid,
  "created_by_name" text,
  "created_by_role" text,
  "deleted_at" timestamp with time zone,
  "owner_user_id" uuid,
  "owner_username" text,
  "owner_name" text,
  "book_id" uuid
);
CREATE TABLE public."debt_payments" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "debt_id" uuid NOT NULL,
  "amount" numeric NOT NULL,
  "payment_method" text DEFAULT 'cash'::text,
  "notes" text DEFAULT ''::text,
  "paid_at" timestamp with time zone DEFAULT now(),
  "cashier" text DEFAULT ''::text,
  "cashier_id" uuid,
  "invoice_no" text,
  "cashier_name" text,
  "deleted_at" timestamp with time zone,
  "customer_id" uuid,
  "customer_name" text,
  "book_id" uuid
);
CREATE TABLE public."debts" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL,
  "transaction_id" uuid,
  "invoice_no" text,
  "total_debt" numeric DEFAULT 0 NOT NULL,
  "paid" numeric DEFAULT 0,
  "remaining" numeric DEFAULT 0,
  "due_date" date,
  "status" text DEFAULT 'aktif'::text,
  "notes" text DEFAULT ''::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "cashier_id" uuid,
  "cashier_name" text,
  "deleted_at" timestamp with time zone,
  "is_opening" boolean DEFAULT false,
  "customer_name" text,
  "customer_phone" text,
  "book_id" uuid
);
CREATE TABLE public."employee_cash_advance_payments" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "cash_advance_id" uuid,
  "payment_date" date DEFAULT (now())::date NOT NULL,
  "amount" numeric DEFAULT 0 NOT NULL,
  "payment_method" text DEFAULT 'cash'::text,
  "notes" text DEFAULT ''::text,
  "cashier_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."employee_cash_advances" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "employee_name" text NOT NULL,
  "amount" numeric DEFAULT 0 NOT NULL,
  "paid" numeric DEFAULT 0 NOT NULL,
  "remaining" numeric DEFAULT 0 NOT NULL,
  "advance_date" date DEFAULT (now())::date NOT NULL,
  "due_date" date,
  "payment_method" text DEFAULT 'cash'::text,
  "notes" text DEFAULT ''::text,
  "status" text DEFAULT 'aktif'::text,
  "cashier_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone,
  "employee_id" uuid,
  "is_opening" boolean DEFAULT false
);
CREATE TABLE public."employees" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "phone" text DEFAULT ''::text,
  "position" text DEFAULT ''::text,
  "notes" text DEFAULT ''::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."expense_categories" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."expenses" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "expense_date" date DEFAULT now() NOT NULL,
  "category" text DEFAULT 'Operasional'::text,
  "amount" numeric DEFAULT 0 NOT NULL,
  "method" text DEFAULT 'cash'::text,
  "note" text DEFAULT ''::text,
  "cashier_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."liabilities" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "amount" numeric DEFAULT 0 NOT NULL,
  "due_date" date,
  "note" text DEFAULT ''::text,
  "created_at" timestamp with time zone DEFAULT now()
);
CREATE TABLE public."migration_details" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "type" text NOT NULL,
  "trx_date" date DEFAULT (now())::date NOT NULL,
  "name" text DEFAULT ''::text NOT NULL,
  "customer" text DEFAULT ''::text,
  "amount" numeric DEFAULT 0 NOT NULL,
  "method" text DEFAULT 'cash'::text,
  "notes" text DEFAULT ''::text,
  "cashier_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."order_customer_changes" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "invoice_no" text,
  "order_id" uuid,
  "old_customer_id" uuid,
  "old_customer_name" text,
  "new_customer_id" uuid,
  "new_customer_name" text,
  "changed_by" uuid,
  "changed_by_name" text,
  "changed_at" timestamp with time zone DEFAULT now(),
  "notes" text DEFAULT ''::text
);
CREATE TABLE public."prepaid_rent_schedules" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "prepaid_rent_id" uuid,
  "period_month" date NOT NULL,
  "expense_amount" numeric DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'pending'::text,
  "expense_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."prepaid_rents" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "location" text,
  "landlord_name" text,
  "payment_date" date NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "duration_months" integer DEFAULT 1 NOT NULL,
  "total_amount" numeric DEFAULT 0 NOT NULL,
  "monthly_expense" numeric DEFAULT 0 NOT NULL,
  "payment_method" text DEFAULT 'transfer'::text,
  "proof_url" text,
  "notes" text,
  "status" text DEFAULT 'active'::text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."product_categories" (
  "id" text NOT NULL,
  "label" text NOT NULL,
  "icon" text DEFAULT '📦'::text,
  "sort_order" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone,
  "color" text,
  "thumbnail_url" text,
  "is_active" boolean DEFAULT true
);
CREATE TABLE public."products" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "category" text DEFAULT ''::text,
  "price" numeric DEFAULT 0,
  "modal" numeric DEFAULT 0,
  "stock" numeric DEFAULT 0,
  "description" text DEFAULT ''::text,
  "image" text DEFAULT ''::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "unit" text DEFAULT 'pcs'::text,
  "is_favorite" boolean DEFAULT false
);
CREATE TABLE public."purchases" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "purchase_date" date DEFAULT now() NOT NULL,
  "supplier" text DEFAULT ''::text,
  "item" text DEFAULT ''::text,
  "qty" numeric DEFAULT 0,
  "amount" numeric DEFAULT 0 NOT NULL,
  "method" text DEFAULT 'cash'::text,
  "is_credit" boolean DEFAULT false,
  "note" text DEFAULT ''::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."receivable_customer_changes" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "old_customer_id" uuid,
  "old_customer_name" text,
  "new_customer_id" uuid,
  "new_customer_name" text,
  "affected_invoice_count" integer DEFAULT 0,
  "affected_debt_count" integer DEFAULT 0,
  "changed_by" uuid,
  "changed_by_name" text,
  "changed_at" timestamp with time zone DEFAULT now(),
  "notes" text DEFAULT ''::text
);
CREATE TABLE public."settings" (
  "id" integer DEFAULT 1 NOT NULL,
  "name" text DEFAULT 'Skupy Printing'::text,
  "tagline" text DEFAULT 'Cetak Impian, Wujudkan Karya'::text,
  "address" text DEFAULT ''::text,
  "phone" text DEFAULT ''::text,
  "email" text DEFAULT ''::text,
  "bank_name" text DEFAULT ''::text,
  "bank_number" text DEFAULT ''::text,
  "bank_holder" text DEFAULT ''::text,
  "front_logo" text DEFAULT ''::text,
  "invoice_logo" text DEFAULT ''::text,
  "tax_rate" integer DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now()
);
CREATE TABLE public."store_bank_accounts" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "bank_name" text NOT NULL,
  "account_number" text NOT NULL,
  "account_holder" text NOT NULL,
  "note" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."store_contacts" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "contact_name" text NOT NULL,
  "phone" text,
  "whatsapp" text,
  "note" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."store_locations" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "location_name" text NOT NULL,
  "store_name" text,
  "address" text NOT NULL,
  "city" text,
  "note" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."supplier_debt_payments" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "supplier_debt_id" uuid,
  "amount" numeric DEFAULT 0 NOT NULL,
  "method" text DEFAULT 'cash'::text,
  "paid_at" timestamp with time zone DEFAULT now(),
  "note" text DEFAULT ''::text,
  "cashier_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now(),
  "fifo_group" uuid
);
CREATE TABLE public."supplier_debts" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "supplier_id" uuid,
  "supplier" text DEFAULT ''::text,
  "item" text DEFAULT ''::text,
  "total" numeric DEFAULT 0 NOT NULL,
  "paid" numeric DEFAULT 0 NOT NULL,
  "remaining" numeric DEFAULT 0 NOT NULL,
  "due_date" date,
  "status" text DEFAULT 'aktif'::text,
  "note" text DEFAULT ''::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone,
  "payment_method" text DEFAULT 'transfer'::text,
  "purchase_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now()
);
CREATE TABLE public."suppliers" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "phone" text DEFAULT ''::text,
  "note" text DEFAULT ''::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "address" text DEFAULT ''::text,
  "updated_at" timestamp with time zone DEFAULT now(),
  "deleted_at" timestamp with time zone
);
CREATE TABLE public."transactions" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "invoice_no" text NOT NULL,
  "customer_id" uuid,
  "customer" text DEFAULT 'Umum'::text,
  "items" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "subtotal" numeric DEFAULT 0,
  "discount" numeric DEFAULT 0,
  "tax" numeric DEFAULT 0,
  "total" numeric DEFAULT 0,
  "paid" numeric DEFAULT 0,
  "dp" numeric DEFAULT 0,
  "remaining" numeric DEFAULT 0,
  "payment_method" text DEFAULT 'cash'::text,
  "status" text DEFAULT 'pending'::text,
  "cashier" text DEFAULT ''::text,
  "cashier_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "customer_address" text,
  "customer_name" text,
  "customer_phone" text,
  "customer_email" text,
  "notes" text,
  "order_no" text,
  "order_status" text DEFAULT 'baru'::text,
  "status_history" jsonb DEFAULT '[]'::jsonb,
  "due_date" date,
  "cashier_name" text,
  "cashier_role" text,
  "deleted_at" timestamp with time zone,
  "owner_user_id" uuid,
  "owner_name" text,
  "book_id" uuid,
  "bank_account_id" uuid,
  "bank_name" text,
  "bank_account_number" text,
  "bank_account_holder" text,
  "created_by_admin_id" uuid,
  "store_name_snapshot" text,
  "address_snapshot" text,
  "phone_snapshot" text
);
ALTER TABLE public."accounting_entries" ADD CONSTRAINT "accounting_entries_pkey" PRIMARY KEY (id);
ALTER TABLE public."accounts" ADD CONSTRAINT "accounts_pkey" PRIMARY KEY (code);
ALTER TABLE public."admin_bank_accounts" ADD CONSTRAINT "admin_bank_accounts_pkey" PRIMARY KEY (id);
ALTER TABLE public."admin_book_access" ADD CONSTRAINT "admin_book_access_admin_id_book_id_key" UNIQUE (admin_id, book_id);
ALTER TABLE public."admin_book_access" ADD CONSTRAINT "admin_book_access_pkey" PRIMARY KEY (id);
ALTER TABLE public."admin_invoice_profiles" ADD CONSTRAINT "admin_invoice_profiles_pkey" PRIMARY KEY (id);
ALTER TABLE public."admins" ADD CONSTRAINT "admins_pkey" PRIMARY KEY (id);
ALTER TABLE public."admins" ADD CONSTRAINT "admins_username_key" UNIQUE (username);
ALTER TABLE public."asset_categories" ADD CONSTRAINT "asset_categories_name_key" UNIQUE (name);
ALTER TABLE public."asset_categories" ADD CONSTRAINT "asset_categories_pkey" PRIMARY KEY (id);
ALTER TABLE public."asset_purchase_payments" ADD CONSTRAINT "asset_purchase_payments_amount_check" CHECK ((amount > (0)::numeric));
ALTER TABLE public."asset_purchase_payments" ADD CONSTRAINT "asset_purchase_payments_payment_method_check" CHECK ((payment_method = ANY (ARRAY['cash'::text, 'transfer'::text, 'qris'::text])));
ALTER TABLE public."asset_purchase_payments" ADD CONSTRAINT "asset_purchase_payments_payment_type_check" CHECK ((payment_type = ANY (ARRAY['dp'::text, 'installment'::text, 'full'::text])));
ALTER TABLE public."asset_purchase_payments" ADD CONSTRAINT "asset_purchase_payments_pkey" PRIMARY KEY (id);
ALTER TABLE public."asset_sales" ADD CONSTRAINT "asset_sales_pkey" PRIMARY KEY (id);
ALTER TABLE public."assets" ADD CONSTRAINT "assets_pkey" PRIMARY KEY (id);
ALTER TABLE public."bank_loan_payments" ADD CONSTRAINT "bank_loan_payments_pkey" PRIMARY KEY (id);
ALTER TABLE public."bank_loans" ADD CONSTRAINT "bank_loans_pkey" PRIMARY KEY (id);
ALTER TABLE public."books" ADD CONSTRAINT "books_pkey" PRIMARY KEY (id);
ALTER TABLE public."cash_movements" ADD CONSTRAINT "cash_movements_pkey" PRIMARY KEY (id);
ALTER TABLE public."credibook_income" ADD CONSTRAINT "credibook_income_pkey" PRIMARY KEY (id);
ALTER TABLE public."customer_owner_changes" ADD CONSTRAINT "customer_owner_changes_pkey" PRIMARY KEY (id);
ALTER TABLE public."customers" ADD CONSTRAINT "customers_pkey" PRIMARY KEY (id);
ALTER TABLE public."debt_payments" ADD CONSTRAINT "debt_payments_pkey" PRIMARY KEY (id);
ALTER TABLE public."debts" ADD CONSTRAINT "debts_pkey" PRIMARY KEY (id);
ALTER TABLE public."employee_cash_advance_payments" ADD CONSTRAINT "employee_cash_advance_payments_pkey" PRIMARY KEY (id);
ALTER TABLE public."employee_cash_advances" ADD CONSTRAINT "employee_cash_advances_pkey" PRIMARY KEY (id);
ALTER TABLE public."employees" ADD CONSTRAINT "employees_pkey" PRIMARY KEY (id);
ALTER TABLE public."expense_categories" ADD CONSTRAINT "expense_categories_pkey" PRIMARY KEY (id);
ALTER TABLE public."expenses" ADD CONSTRAINT "expenses_pkey" PRIMARY KEY (id);
ALTER TABLE public."liabilities" ADD CONSTRAINT "liabilities_pkey" PRIMARY KEY (id);
ALTER TABLE public."migration_details" ADD CONSTRAINT "migration_details_pkey" PRIMARY KEY (id);
ALTER TABLE public."migration_details" ADD CONSTRAINT "migration_details_type_check" CHECK ((type = ANY (ARRAY['old_income'::text, 'old_expense'::text, 'modal'::text, 'loan_cash'::text])));
ALTER TABLE public."order_customer_changes" ADD CONSTRAINT "order_customer_changes_pkey" PRIMARY KEY (id);
ALTER TABLE public."prepaid_rent_schedules" ADD CONSTRAINT "prepaid_rent_schedules_pkey" PRIMARY KEY (id);
ALTER TABLE public."prepaid_rents" ADD CONSTRAINT "prepaid_rents_pkey" PRIMARY KEY (id);
ALTER TABLE public."product_categories" ADD CONSTRAINT "product_categories_pkey" PRIMARY KEY (id);
ALTER TABLE public."products" ADD CONSTRAINT "products_pkey" PRIMARY KEY (id);
ALTER TABLE public."products" ADD CONSTRAINT "products_unit_check" CHECK ((unit = ANY (ARRAY['pcs'::text, 'meter'::text, 'yard'::text])));
ALTER TABLE public."purchases" ADD CONSTRAINT "purchases_pkey" PRIMARY KEY (id);
ALTER TABLE public."receivable_customer_changes" ADD CONSTRAINT "receivable_customer_changes_pkey" PRIMARY KEY (id);
ALTER TABLE public."settings" ADD CONSTRAINT "settings_pkey" PRIMARY KEY (id);
ALTER TABLE public."settings" ADD CONSTRAINT "settings_single_row" CHECK ((id = 1));
ALTER TABLE public."store_bank_accounts" ADD CONSTRAINT "store_bank_accounts_pkey" PRIMARY KEY (id);
ALTER TABLE public."store_contacts" ADD CONSTRAINT "store_contacts_pkey" PRIMARY KEY (id);
ALTER TABLE public."store_locations" ADD CONSTRAINT "store_locations_pkey" PRIMARY KEY (id);
ALTER TABLE public."supplier_debt_payments" ADD CONSTRAINT "supplier_debt_payments_pkey" PRIMARY KEY (id);
ALTER TABLE public."supplier_debts" ADD CONSTRAINT "supplier_debts_pkey" PRIMARY KEY (id);
ALTER TABLE public."suppliers" ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY (id);
ALTER TABLE public."transactions" ADD CONSTRAINT "transactions_invoice_no_key" UNIQUE (invoice_no);
ALTER TABLE public."transactions" ADD CONSTRAINT "transactions_pkey" PRIMARY KEY (id);
ALTER TABLE public."accounting_entries" ADD CONSTRAINT "accounting_entries_account_code_fkey" FOREIGN KEY (account_code) REFERENCES accounts(code);
ALTER TABLE public."admin_invoice_profiles" ADD CONSTRAINT "admin_invoice_profiles_bank_account_id_fkey" FOREIGN KEY (bank_account_id) REFERENCES store_bank_accounts(id);
ALTER TABLE public."admin_invoice_profiles" ADD CONSTRAINT "admin_invoice_profiles_contact_id_fkey" FOREIGN KEY (contact_id) REFERENCES store_contacts(id);
ALTER TABLE public."admin_invoice_profiles" ADD CONSTRAINT "admin_invoice_profiles_location_id_fkey" FOREIGN KEY (location_id) REFERENCES store_locations(id);
ALTER TABLE public."asset_purchase_payments" ADD CONSTRAINT "asset_purchase_payments_asset_id_fkey" FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
ALTER TABLE public."bank_loan_payments" ADD CONSTRAINT "bank_loan_payments_loan_id_fkey" FOREIGN KEY (loan_id) REFERENCES bank_loans(id) ON DELETE CASCADE;
ALTER TABLE public."debt_payments" ADD CONSTRAINT "debt_payments_cashier_id_fkey" FOREIGN KEY (cashier_id) REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE public."debt_payments" ADD CONSTRAINT "debt_payments_debt_id_fkey" FOREIGN KEY (debt_id) REFERENCES debts(id) ON DELETE CASCADE;
ALTER TABLE public."debts" ADD CONSTRAINT "debts_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public."debts" ADD CONSTRAINT "debts_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE;
ALTER TABLE public."employee_cash_advance_payments" ADD CONSTRAINT "employee_cash_advance_payments_cash_advance_id_fkey" FOREIGN KEY (cash_advance_id) REFERENCES employee_cash_advances(id) ON DELETE CASCADE;
ALTER TABLE public."employee_cash_advances" ADD CONSTRAINT "employee_cash_advances_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE public."expenses" ADD CONSTRAINT "expenses_cashier_id_fkey" FOREIGN KEY (cashier_id) REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE public."prepaid_rent_schedules" ADD CONSTRAINT "prepaid_rent_schedules_prepaid_rent_id_fkey" FOREIGN KEY (prepaid_rent_id) REFERENCES prepaid_rents(id) ON DELETE CASCADE;
ALTER TABLE public."supplier_debt_payments" ADD CONSTRAINT "supplier_debt_payments_supplier_debt_id_fkey" FOREIGN KEY (supplier_debt_id) REFERENCES supplier_debts(id) ON DELETE CASCADE;
ALTER TABLE public."supplier_debts" ADD CONSTRAINT "supplier_debts_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE public."transactions" ADD CONSTRAINT "transactions_cashier_id_fkey" FOREIGN KEY (cashier_id) REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE public."transactions" ADD CONSTRAINT "transactions_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX idx_acc_entries_account ON public.accounting_entries USING btree (account_code);
CREATE INDEX idx_acc_entries_cashier ON public.accounting_entries USING btree (cashier_id);
CREATE INDEX idx_acc_entries_date ON public.accounting_entries USING btree (entry_date DESC);
CREATE INDEX idx_acc_entries_invoice ON public.accounting_entries USING btree (invoice_no);
CREATE INDEX idx_acc_entries_source ON public.accounting_entries USING btree (source_type, source_id);
CREATE INDEX idx_aba_admin ON public.admin_bank_accounts USING btree (admin_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX uq_aba_default_per_admin ON public.admin_bank_accounts USING btree (admin_id) WHERE ((is_default = true) AND (deleted_at IS NULL));
CREATE UNIQUE INDEX uq_aip_admin ON public.admin_invoice_profiles USING btree (admin_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_asset_cat_del ON public.asset_categories USING btree (deleted_at);
CREATE INDEX idx_asset_purchase_payments_asset ON public.asset_purchase_payments USING btree (asset_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_asset_purchase_payments_date ON public.asset_purchase_payments USING btree (payment_date) WHERE (deleted_at IS NULL);
CREATE INDEX idx_asset_sales_asset ON public.asset_sales USING btree (asset_id) WHERE (deleted_at IS NULL);
CREATE INDEX idx_assets_del ON public.assets USING btree (deleted_at);
CREATE INDEX idx_assets_deleted ON public.assets USING btree (deleted_at);
CREATE INDEX idx_assets_status ON public.assets USING btree (status);
CREATE INDEX idx_bank_loan_pay_loan ON public.bank_loan_payments USING btree (loan_id);
CREATE INDEX idx_bank_loans_jt ON public.bank_loans USING btree (tanggal_jatuh_tempo);
CREATE INDEX idx_bank_loans_status ON public.bank_loans USING btree (status);
CREATE INDEX idx_cash_mov_date ON public.cash_movements USING btree (moved_at DESC);
CREATE INDEX idx_cash_mov_source ON public.cash_movements USING btree (source_type, source_id);
CREATE INDEX idx_credibook_income_book ON public.credibook_income USING btree (book_id);
CREATE INDEX idx_credibook_income_date ON public.credibook_income USING btree (transaction_date);
CREATE INDEX idx_credibook_income_deleted ON public.credibook_income USING btree (deleted_at);
CREATE INDEX idx_credibook_income_type ON public.credibook_income USING btree (income_type);
CREATE INDEX idx_customers_book ON public.customers USING btree (book_id);
CREATE INDEX idx_customers_created_by ON public.customers USING btree (created_by);
CREATE INDEX idx_customers_deleted_at ON public.customers USING btree (deleted_at);
CREATE INDEX idx_customers_name ON public.customers USING btree (name);
CREATE INDEX idx_customers_owner_user_id ON public.customers USING btree (owner_user_id);
CREATE INDEX idx_customers_phone ON public.customers USING btree (phone);
CREATE INDEX idx_debt_payments_book ON public.debt_payments USING btree (book_id);
CREATE INDEX idx_debt_payments_cashier_id ON public.debt_payments USING btree (cashier_id);
CREATE INDEX idx_debt_payments_customer_id ON public.debt_payments USING btree (customer_id);
CREATE INDEX idx_debt_payments_debt ON public.debt_payments USING btree (debt_id);
CREATE INDEX idx_debt_payments_debt_id ON public.debt_payments USING btree (debt_id);
CREATE INDEX idx_debt_payments_debt_id_amount ON public.debt_payments USING btree (debt_id, amount);
CREATE INDEX idx_debt_payments_invoice_no ON public.debt_payments USING btree (invoice_no);
CREATE INDEX idx_debt_payments_paid_at ON public.debt_payments USING btree (paid_at DESC);
CREATE INDEX idx_debt_payments_paid_at_desc ON public.debt_payments USING btree (paid_at DESC);
CREATE INDEX idx_debts_book ON public.debts USING btree (book_id);
CREATE INDEX idx_debts_cashier_id ON public.debts USING btree (cashier_id);
CREATE INDEX idx_debts_customer ON public.debts USING btree (customer_id);
CREATE INDEX idx_debts_customer_id ON public.debts USING btree (customer_id);
CREATE INDEX idx_debts_customer_id2 ON public.debts USING btree (customer_id);
CREATE INDEX idx_debts_due_date ON public.debts USING btree (due_date);
CREATE INDEX idx_debts_invoice_no ON public.debts USING btree (invoice_no);
CREATE INDEX idx_debts_invoice_no_unique_lookup ON public.debts USING btree (invoice_no);
CREATE INDEX idx_debts_opening ON public.debts USING btree (is_opening);
CREATE INDEX idx_debts_status ON public.debts USING btree (status);
CREATE INDEX idx_debts_transaction_id ON public.debts USING btree (transaction_id);
CREATE INDEX idx_debts_transaction_id_lookup ON public.debts USING btree (transaction_id);
CREATE INDEX idx_ecap_adv ON public.employee_cash_advance_payments USING btree (cash_advance_id);
CREATE INDEX idx_ecap_deleted ON public.employee_cash_advance_payments USING btree (deleted_at);
CREATE INDEX idx_eca_date ON public.employee_cash_advances USING btree (advance_date);
CREATE INDEX idx_eca_deleted ON public.employee_cash_advances USING btree (deleted_at);
CREATE INDEX idx_eca_employee ON public.employee_cash_advances USING btree (employee_id);
CREATE INDEX idx_eca_opening ON public.employee_cash_advances USING btree (is_opening);
CREATE INDEX idx_eca_status ON public.employee_cash_advances USING btree (status);
CREATE INDEX idx_employees_deleted ON public.employees USING btree (deleted_at);
CREATE INDEX idx_employees_name ON public.employees USING btree (name);
CREATE INDEX idx_expense_categories_deleted ON public.expense_categories USING btree (deleted_at);
CREATE INDEX idx_expenses_date ON public.expenses USING btree (expense_date DESC);
CREATE INDEX idx_expenses_deleted ON public.expenses USING btree (deleted_at);
CREATE INDEX idx_migdet_date ON public.migration_details USING btree (trx_date);
CREATE INDEX idx_migdet_deleted ON public.migration_details USING btree (deleted_at);
CREATE INDEX idx_migdet_type ON public.migration_details USING btree (type);
CREATE INDEX idx_prepaid_sched_deleted ON public.prepaid_rent_schedules USING btree (deleted_at);
CREATE INDEX idx_prepaid_sched_rent ON public.prepaid_rent_schedules USING btree (prepaid_rent_id);
CREATE INDEX idx_prepaid_rents_deleted ON public.prepaid_rents USING btree (deleted_at);
CREATE INDEX idx_prodcat_active ON public.product_categories USING btree (is_active);
CREATE INDEX idx_prodcat_deleted ON public.product_categories USING btree (deleted_at);
CREATE INDEX idx_products_category ON public.products USING btree (category);
CREATE INDEX idx_products_is_favorite ON public.products USING btree (is_favorite);
CREATE INDEX idx_products_unit ON public.products USING btree (unit);
CREATE INDEX idx_purchases_date ON public.purchases USING btree (purchase_date DESC);
CREATE INDEX idx_purchases_deleted ON public.purchases USING btree (deleted_at);
CREATE INDEX idx_sdp_fifo_group ON public.supplier_debt_payments USING btree (fifo_group);
CREATE INDEX idx_supplier_debt_pay_debt ON public.supplier_debt_payments USING btree (supplier_debt_id);
CREATE INDEX idx_supplier_debts_deleted ON public.supplier_debts USING btree (deleted_at);
CREATE INDEX idx_supplier_debts_status ON public.supplier_debts USING btree (status);
CREATE INDEX idx_supplier_debts_supplier ON public.supplier_debts USING btree (supplier_id);
CREATE INDEX idx_suppliers_deleted ON public.suppliers USING btree (deleted_at);
CREATE INDEX idx_transactions_book ON public.transactions USING btree (book_id);
CREATE INDEX idx_transactions_cashier_id ON public.transactions USING btree (cashier_id);
CREATE INDEX idx_transactions_created_at ON public.transactions USING btree (created_at DESC);
CREATE INDEX idx_transactions_created_at_desc ON public.transactions USING btree (created_at DESC);
CREATE INDEX idx_transactions_customer ON public.transactions USING btree (customer_id);
CREATE INDEX idx_transactions_customer_id ON public.transactions USING btree (customer_id);
CREATE INDEX idx_transactions_customer_status ON public.transactions USING btree (customer_id, status);
CREATE INDEX idx_transactions_due_date ON public.transactions USING btree (due_date);
CREATE INDEX idx_transactions_invoice_no ON public.transactions USING btree (invoice_no);
CREATE INDEX idx_transactions_invoice_no_lookup ON public.transactions USING btree (invoice_no);
CREATE INDEX idx_transactions_order_no ON public.transactions USING btree (order_no);
CREATE INDEX idx_transactions_order_status ON public.transactions USING btree (order_status);
CREATE INDEX idx_transactions_owner_user_id ON public.transactions USING btree (owner_user_id);
CREATE INDEX idx_transactions_status ON public.transactions USING btree (status);
CREATE OR REPLACE FUNCTION public.acc_asset_master_changed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM public.acc_repost_asset_purchase(COALESCE(NEW.id,OLD.id));
  RETURN COALESCE(NEW,OLD);
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_asset_payment_changed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM public.acc_repost_asset_purchase(COALESCE(NEW.asset_id,OLD.asset_id));
  RETURN COALESCE(NEW,OLD);
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_bootstrap_migration_details()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  CREATE TABLE IF NOT EXISTS public.migration_details (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type text NOT NULL CHECK (type IN ('old_income','old_expense')),
    trx_date date NOT NULL DEFAULT now()::date,
    name text NOT NULL DEFAULT '',
    customer text DEFAULT '',
    amount numeric NOT NULL DEFAULT 0,
    method text DEFAULT 'cash',
    notes text DEFAULT '',
    cashier_id uuid,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    deleted_at timestamptz
  );
  ALTER TABLE public.migration_details ADD COLUMN IF NOT EXISTS customer text DEFAULT '';
  CREATE INDEX IF NOT EXISTS idx_migdet_type    ON public.migration_details (type);
  CREATE INDEX IF NOT EXISTS idx_migdet_date    ON public.migration_details (trx_date);
  CREATE INDEX IF NOT EXISTS idx_migdet_deleted ON public.migration_details (deleted_at);
  ALTER TABLE public.migration_details ENABLE ROW LEVEL SECURITY;
  BEGIN
    CREATE POLICY "anon all migration_details" ON public.migration_details FOR ALL USING (true) WITH CHECK (true);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.migration_details TO anon, authenticated;
  NOTIFY pgrst, 'reload schema';
  RETURN json_build_object('ok', true);
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_cash_code(method text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN method IN ('transfer','qris') THEN '1100' ELSE '1000' END;
$function$;
CREATE OR REPLACE FUNCTION public.acc_dashboard(p_from date, p_to date)
 RETURNS json
 LANGUAGE sql
 STABLE
AS $function$
  WITH cic_all AS (
    SELECT invoice_no, sum(round(amount)) AS cic
    FROM public.debt_payments WHERE deleted_at IS NULL AND invoice_no IS NOT NULL GROUP BY invoice_no
  ),
  txp AS (
    SELECT t.payment_method, round(t.total) AS total,
           GREATEST(0, round(t.paid) - COALESCE(ca.cic,0)) AS init_paid
    FROM public.transactions t LEFT JOIN cic_all ca ON ca.invoice_no = t.invoice_no
    WHERE COALESCE(t.order_status,'') <> 'dibatalkan' AND t.deleted_at IS NULL
      AND t.created_at::date BETWEEN p_from AND p_to
  ),
  txall AS (
    SELECT t.payment_method, GREATEST(0, round(t.paid) - COALESCE(ca.cic,0)) AS init_paid
    FROM public.transactions t LEFT JOIN cic_all ca ON ca.invoice_no = t.invoice_no
    WHERE COALESCE(t.order_status,'') <> 'dibatalkan' AND t.deleted_at IS NULL
      AND t.created_at::date <= p_to
  ),
  dpp    AS (SELECT * FROM public.debt_payments WHERE deleted_at IS NULL AND paid_at::date BETWEEN p_from AND p_to),
  dpall  AS (SELECT * FROM public.debt_payments WHERE deleted_at IS NULL AND paid_at::date <= p_to),
  sdp    AS (SELECT * FROM public.supplier_debt_payments WHERE deleted_at IS NULL AND paid_at::date BETWEEN p_from AND p_to),
  sdpall AS (SELECT * FROM public.supplier_debt_payments WHERE deleted_at IS NULL AND paid_at::date <= p_to),
  blp    AS (SELECT * FROM public.bank_loan_payments WHERE deleted_at IS NULL AND paid_at::date BETWEEN p_from AND p_to),
  blpall AS (SELECT * FROM public.bank_loan_payments WHERE deleted_at IS NULL AND paid_at::date <= p_to),
  exp    AS (SELECT * FROM public.expenses  WHERE deleted_at IS NULL),
  pur    AS (SELECT * FROM public.purchases WHERE deleted_at IS NULL),
  eca    AS (SELECT * FROM public.employee_cash_advances WHERE deleted_at IS NULL AND COALESCE(is_opening,false)=false AND advance_date BETWEEN p_from AND p_to),
  ecaall AS (SELECT * FROM public.employee_cash_advances WHERE deleted_at IS NULL AND COALESCE(is_opening,false)=false AND advance_date <= p_to),
  ecp    AS (SELECT * FROM public.employee_cash_advance_payments WHERE deleted_at IS NULL AND payment_date BETWEEN p_from AND p_to),
  ecpall AS (SELECT * FROM public.employee_cash_advance_payments WHERE deleted_at IS NULL AND payment_date <= p_to),
  oi     AS (SELECT * FROM public.migration_details WHERE type='old_income'  AND deleted_at IS NULL AND trx_date BETWEEN p_from AND p_to),
  oiall  AS (SELECT * FROM public.migration_details WHERE type='old_income'  AND deleted_at IS NULL AND trx_date <= p_to),
  oe     AS (SELECT * FROM public.migration_details WHERE type='old_expense' AND deleted_at IS NULL AND trx_date BETWEEN p_from AND p_to),
  oeall  AS (SELECT * FROM public.migration_details WHERE type='old_expense' AND deleted_at IS NULL AND trx_date <= p_to),
  prall  AS (SELECT * FROM public.prepaid_rents WHERE deleted_at IS NULL AND COALESCE(status,'') <> 'cancelled' AND payment_date <= p_to),
  modall AS (SELECT * FROM public.migration_details WHERE type='modal'     AND deleted_at IS NULL AND trx_date <= p_to),
  lcall  AS (SELECT * FROM public.migration_details WHERE type='loan_cash' AND deleted_at IS NULL AND trx_date <= p_to),
  cbi    AS (SELECT * FROM public.credibook_income WHERE deleted_at IS NULL AND transaction_date BETWEEN p_from AND p_to),
  cbiall AS (SELECT * FROM public.credibook_income WHERE deleted_at IS NULL AND transaction_date <= p_to),
  -- PENJUALAN ASET: harga jual = kas masuk (bukan omset)
  asl    AS (SELECT * FROM public.asset_sales WHERE deleted_at IS NULL AND sale_date BETWEEN p_from AND p_to),
  aslall AS (SELECT * FROM public.asset_sales WHERE deleted_at IS NULL AND sale_date <= p_to),
  bd AS (
    SELECT
      (SELECT COALESCE(sum(round(amount)),0) FROM modall) + (SELECT COALESCE(sum(round(amount)),0) FROM lcall) AS saldo_awal,
      (SELECT COALESCE(sum(round(amount)),0) FROM modall WHERE method='cash') + (SELECT COALESCE(sum(round(amount)),0) FROM lcall WHERE method='cash') AS awal_cash,
      (SELECT COALESCE(sum(round(amount)),0) FROM modall WHERE method IN ('transfer','qris')) + (SELECT COALESCE(sum(round(amount)),0) FROM lcall WHERE method IN ('transfer','qris')) AS awal_bank,
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method IN ('cash','hutang')) + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method='cash') + (SELECT COALESCE(sum(round(amount)),0) FROM ecpall WHERE payment_method='cash') + (SELECT COALESCE(sum(round(amount)),0) FROM oiall WHERE method='cash') + (SELECT COALESCE(sum(round(amount)),0) FROM cbiall WHERE payment_method='cash') + (SELECT COALESCE(sum(round(sale_price)),0) FROM aslall WHERE payment_method='cash') AS masuk_cash,
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM ecpall WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM oiall WHERE method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM cbiall WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(sale_price)),0) FROM aslall WHERE payment_method='transfer') AS masuk_transfer,
      (SELECT COALESCE(sum(init_paid),0) FROM txall WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM dpall WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM oiall WHERE method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM cbiall WHERE payment_method='qris') + (SELECT COALESCE(sum(round(sale_price)),0) FROM aslall WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM ecpall WHERE payment_method='qris') AS masuk_qris,
      (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE method='cash' AND expense_date <= p_to) + (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE method='cash' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to) + (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method='cash') + (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method='cash') + (SELECT COALESCE(sum(round(amount)),0) FROM ecaall WHERE payment_method='cash') + (SELECT COALESCE(sum(round(amount)),0) FROM oeall WHERE method='cash') + (SELECT COALESCE(sum(round(total_amount)),0) FROM prall WHERE payment_method='cash') AS keluar_cash,
      (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE method='transfer' AND expense_date <= p_to) + (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE method='transfer' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to) + (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM ecaall WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM oeall WHERE method='transfer') + (SELECT COALESCE(sum(round(total_amount)),0) FROM prall WHERE payment_method='transfer') AS keluar_transfer,
      (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE method='qris' AND expense_date <= p_to) + (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE method='qris' AND COALESCE(is_credit,false)=false AND purchase_date <= p_to) + (SELECT COALESCE(sum(round(amount)),0) FROM sdpall WHERE method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM blpall WHERE method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM oeall WHERE method='qris') + (SELECT COALESCE(sum(round(total_amount)),0) FROM prall WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM ecaall WHERE payment_method='qris') AS keluar_qris
  )
  SELECT json_build_object(
    'penjualan',        (SELECT COALESCE(sum(total),0) FROM txp) + (SELECT COALESCE(sum(round(amount)),0) FROM oi)
                        + (SELECT COALESCE(sum(round(amount)),0) FROM cbi WHERE income_type='omzet'),
    'uang_masuk_total', (SELECT COALESCE(sum(init_paid),0) FROM txp) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp)
                        + (SELECT COALESCE(sum(round(amount)),0) FROM ecp) + (SELECT COALESCE(sum(round(amount)),0) FROM oi)
                        + (SELECT COALESCE(sum(round(amount)),0) FROM cbi)
                        + (SELECT COALESCE(sum(round(sale_price)),0) FROM asl),
    'cash',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method IN ('cash','hutang')) + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='cash') + (SELECT COALESCE(sum(round(amount)),0) FROM ecp WHERE payment_method='cash') + (SELECT COALESCE(sum(round(amount)),0) FROM oi WHERE method='cash') + (SELECT COALESCE(sum(round(amount)),0) FROM cbi WHERE payment_method='cash') + (SELECT COALESCE(sum(round(sale_price)),0) FROM asl WHERE payment_method='cash'),
    'transfer', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM ecp WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM oi WHERE method='transfer') + (SELECT COALESCE(sum(round(amount)),0) FROM cbi WHERE payment_method='transfer') + (SELECT COALESCE(sum(round(sale_price)),0) FROM asl WHERE payment_method='transfer'),
    'qris',     (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM oi WHERE method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM cbi WHERE payment_method='qris') + (SELECT COALESCE(sum(round(sale_price)),0) FROM asl WHERE payment_method='qris') + (SELECT COALESCE(sum(round(amount)),0) FROM ecp WHERE payment_method='qris'),
    'pemasukan_manual', (SELECT COALESCE(sum(round(amount)),0) FROM cbi),
    'pemasukan_omzet',  (SELECT COALESCE(sum(round(amount)),0) FROM cbi WHERE income_type='omzet'),
    'penjualan_aset',   (SELECT COALESCE(sum(round(sale_price)),0) FROM asl),
    'laba_rugi_aset',   (SELECT COALESCE(sum(round(gain_loss)),0) FROM asl),
    'cicilan',  (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'penerimaan_piutang', (SELECT COALESCE(sum(init_paid),0) FROM txp WHERE payment_method='hutang') + (SELECT COALESCE(sum(round(amount)),0) FROM dpp),
    'pengeluaran_total', (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE expense_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE COALESCE(is_credit,false)=false AND purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM sdp) + (SELECT COALESCE(sum(round(amount)),0) FROM blp)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM eca) + (SELECT COALESCE(sum(round(amount)),0) FROM oe),
    'pembelian_bahan',   (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE purchase_date BETWEEN p_from AND p_to)
                         + (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to),
    'gaji',        (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category IN ('Gaji','Gaji Karyawan') AND expense_date BETWEEN p_from AND p_to),
    'operasional', (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category NOT IN ('Gaji','Gaji Karyawan','Pembelian Bahan') AND expense_date BETWEEN p_from AND p_to),
    'beban_bunga', (SELECT COALESCE(sum(round(bunga)),0) FROM blp),
    'piutang_aktif', (SELECT COALESCE(sum(greatest(0, round(total_debt)-round(paid))),0) FROM public.debts WHERE deleted_at IS NULL),
    'sudah_bayar',   (SELECT COALESCE(sum(round(paid)),0) FROM public.debts WHERE deleted_at IS NULL),
    'hutang_supplier', (SELECT COALESCE(sum(greatest(0, round(total)-round(paid))),0) FROM public.supplier_debts WHERE status='aktif' AND deleted_at IS NULL),
    'hutang_bank',     (SELECT COALESCE(sum(round(sisa_pokok)),0) FROM public.bank_loans WHERE status='aktif' AND deleted_at IS NULL),
    'cicilan_bank',    (SELECT COALESCE(sum(round(amount)),0) FROM blp),
    'pinjaman_aktif',  (SELECT COUNT(*) FROM public.bank_loans WHERE status='aktif' AND deleted_at IS NULL),
    'persediaan',      (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE purchase_date <= p_to),
    'piutang_karyawan', (SELECT COALESCE(sum(greatest(0, round(amount)-round(paid))),0) FROM public.employee_cash_advances WHERE status='aktif' AND deleted_at IS NULL),
    'kasbon_keluar',    (SELECT COALESCE(sum(round(amount)),0) FROM eca),
    'kasbon_masuk',     (SELECT COALESCE(sum(round(amount)),0) FROM ecp),
    'omset_migrasi',       (SELECT COALESCE(sum(round(amount)),0) FROM oi),
    'pengeluaran_migrasi', (SELECT COALESCE(sum(round(amount)),0) FROM oe),
    'saldo_kas',      (SELECT awal_cash + masuk_cash - keluar_cash FROM bd),
    'saldo_rekening', (SELECT awal_bank + masuk_transfer + masuk_qris - keluar_transfer - keluar_qris FROM bd),
    'saldo_awal',      (SELECT saldo_awal FROM bd),
    'masuk_cash',      (SELECT masuk_cash FROM bd),
    'masuk_transfer',  (SELECT masuk_transfer FROM bd),
    'masuk_qris',      (SELECT masuk_qris FROM bd),
    'keluar_cash',     (SELECT keluar_cash FROM bd),
    'keluar_transfer', (SELECT keluar_transfer FROM bd),
    'keluar_qris',     (SELECT keluar_qris FROM bd),
    'modal_disetor', (SELECT COALESCE(sum(round(amount)),0) FROM modall),
    'modal_barang', (SELECT COALESCE(sum(round(amount)),0) FROM pur WHERE purchase_date BETWEEN p_from AND p_to)
                    + (SELECT COALESCE(sum(round(amount)),0) FROM exp WHERE category='Pembelian Bahan' AND expense_date BETWEEN p_from AND p_to)
  );
$function$;
CREATE OR REPLACE FUNCTION public.acc_delete_employee_advance(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_now timestamptz := now();
BEGIN
  UPDATE public.employee_cash_advance_payments
    SET deleted_at = v_now
    WHERE cash_advance_id = p_id AND deleted_at IS NULL;
  UPDATE public.employee_cash_advances
    SET deleted_at = v_now
    WHERE id = p_id AND deleted_at IS NULL;
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_delete_supplier_debt(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_now timestamptz := now();
BEGIN
  UPDATE public.supplier_debt_payments
    SET deleted_at = v_now
    WHERE supplier_debt_id = p_id AND deleted_at IS NULL;
  UPDATE public.supplier_debts
    SET deleted_at = v_now
    WHERE id = p_id AND deleted_at IS NULL;
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_fn_post_bank_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_amt numeric; v_cash text; v_loan uuid; v_pid uuid;
BEGIN
  v_pid  := COALESCE(NEW.id, OLD.id);
  v_loan := COALESCE(NEW.loan_id, OLD.loan_id);
  DELETE FROM public.accounting_entries WHERE source_type='bank_payment' AND source_id=v_pid;
  DELETE FROM public.cash_movements     WHERE source_type='bank_payment' AND source_id=v_pid;
  IF (TG_OP <> 'DELETE') AND NEW.deleted_at IS NULL THEN
    v_amt := round(coalesce(NEW.amount,0));
    IF v_amt > 0 THEN
      v_cash := public.acc_cash_code(NEW.method);
      -- Dr 2100 Hutang Bank / Cr Kas-Bank (seluruh nominal = pokok)
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'bank_payment',NEW.id,'2100',v_amt,0,'Pembayaran pokok hutang bank',NEW.cashier_id);
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'bank_payment',NEW.id,v_cash,0,v_amt,'Pembayaran hutang bank',NEW.cashier_id);
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
      VALUES (NEW.paid_at,'out',coalesce(NEW.method,'transfer'),v_amt,'bank_payment',NEW.id,'Cicilan bank',NEW.cashier_id);
    END IF;
  END IF;
  PERFORM public.acc_recalc_bank_loan(v_loan);
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'bank_payment: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_fn_post_employee_advance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='employee_advance' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='employee_advance' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  NEW.remaining := greatest(0, round(coalesce(NEW.amount,0)) - round(coalesce(NEW.paid,0)));
  NEW.status := CASE WHEN NEW.remaining <= 0 THEN 'lunas' ELSE 'aktif' END;
  NEW.updated_at := now();
  BEGIN
    DELETE FROM public.accounting_entries WHERE source_type='employee_advance' AND source_id=NEW.id;
    DELETE FROM public.cash_movements     WHERE source_type='employee_advance' AND source_id=NEW.id;
    v_amt := round(coalesce(NEW.amount,0));
    v_cash := public.acc_cash_code(NEW.payment_method);
    IF v_amt > 0 AND NEW.deleted_at IS NULL AND COALESCE(NEW.is_opening,false)=false THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (coalesce(NEW.advance_date, now()::date),'employee_advance',NEW.id,'1250',v_amt,0,'Kasbon '||coalesce(NEW.employee_name,''),NEW.cashier_id);
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (coalesce(NEW.advance_date, now()::date),'employee_advance',NEW.id,v_cash,0,v_amt,'Kas/Bank keluar (kasbon)',NEW.cashier_id);
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
      VALUES (coalesce(NEW.advance_date::timestamptz, now()),'out',coalesce(NEW.payment_method,'cash'),v_amt,'employee_advance',NEW.id,'Kasbon '||coalesce(NEW.employee_name,''),NEW.cashier_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'employee_advance journal: %', SQLERRM; END;
  RETURN NEW;
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_fn_post_employee_advance_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_amt numeric; v_cash text; v_adv uuid; v_pid uuid;
BEGIN
  v_pid := COALESCE(NEW.id, OLD.id);
  v_adv := COALESCE(NEW.cash_advance_id, OLD.cash_advance_id);
  DELETE FROM public.accounting_entries WHERE source_type='employee_advance_payment' AND source_id=v_pid;
  DELETE FROM public.cash_movements     WHERE source_type='employee_advance_payment' AND source_id=v_pid;
  IF (TG_OP <> 'DELETE') AND NEW.deleted_at IS NULL THEN
    v_amt := round(coalesce(NEW.amount,0));
    v_cash := public.acc_cash_code(NEW.payment_method);
    IF v_amt > 0 THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (coalesce(NEW.payment_date, now()::date),'employee_advance_payment',NEW.id,v_cash,v_amt,0,'Pembayaran kasbon',NEW.cashier_id);
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (coalesce(NEW.payment_date, now()::date),'employee_advance_payment',NEW.id,'1250',0,v_amt,'Pelunasan piutang karyawan',NEW.cashier_id);
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
      VALUES (coalesce(NEW.payment_date::timestamptz, now()),'in',coalesce(NEW.payment_method,'cash'),v_amt,'employee_advance_payment',NEW.id,'Pembayaran kasbon',NEW.cashier_id);
    END IF;
  END IF;
  -- recompute paid parent dari SUM pembayaran non-deleted (idempotent)
  UPDATE public.employee_cash_advances
    SET paid = (SELECT COALESCE(sum(round(amount)),0) FROM public.employee_cash_advance_payments WHERE cash_advance_id=v_adv AND deleted_at IS NULL)
    WHERE id = v_adv;
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'employee_advance_payment: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_fn_post_expense()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='expense' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='expense' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  -- selalu bersihkan dulu (untuk UPDATE/edit/soft-delete)
  DELETE FROM public.accounting_entries WHERE source_type='expense' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='expense' AND source_id=NEW.id;
  -- jika sudah dihapus (soft delete) → berhenti, tidak ada jurnal
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  v_amt := round(COALESCE(NEW.amount,0));
  v_cash := public.acc_cash_code(NEW.method);
  IF v_amt <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
  VALUES (NEW.expense_date,'expense',NEW.id,'6000',v_amt,0,COALESCE(NEW.category,'Beban')||' '||COALESCE(NEW.note,''));
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
  VALUES (NEW.expense_date,'expense',NEW.id,v_cash,0,v_amt,'Pembayaran beban');
  INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note)
  VALUES (NEW.expense_date,'out',COALESCE(NEW.method,'cash'),v_amt,'expense',NEW.id,COALESCE(NEW.category,'Beban'));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_expense dilewati: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_fn_post_purchase()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_amt numeric; v_cash text;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='purchase' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='purchase' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='purchase' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='purchase' AND source_id=NEW.id;
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  v_amt := round(COALESCE(NEW.amount,0));
  v_cash := public.acc_cash_code(NEW.method);
  IF v_amt <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
  VALUES (NEW.purchase_date,'purchase',NEW.id,'1300',v_amt,0,'Pembelian '||COALESCE(NEW.item,''));
  IF COALESCE(NEW.is_credit,false) THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
    VALUES (NEW.purchase_date,'purchase',NEW.id,'2000',0,v_amt,'Pembelian kredit '||COALESCE(NEW.supplier,''));
  ELSE
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
    VALUES (NEW.purchase_date,'purchase',NEW.id,v_cash,0,v_amt,'Pembayaran pembelian');
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note)
    VALUES (NEW.purchase_date,'out',COALESCE(NEW.method,'cash'),v_amt,'purchase',NEW.id,COALESCE(NEW.item,'Pembelian'));
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_purchase dilewati: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_fn_post_supplier_debt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_total numeric;
BEGIN
  IF (TG_OP='DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='supplier_debt' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  NEW.remaining := greatest(0, round(coalesce(NEW.total,0)) - round(coalesce(NEW.paid,0)));
  NEW.status := CASE WHEN NEW.remaining <= 0 THEN 'lunas' ELSE 'aktif' END;
  BEGIN
    DELETE FROM public.accounting_entries WHERE source_type='supplier_debt' AND source_id=NEW.id;
    v_total := round(coalesce(NEW.total,0));
    IF v_total > 0 AND NEW.deleted_at IS NULL THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
      VALUES (coalesce(NEW.created_at::date, now()::date),'supplier_debt',NEW.id,'1300',v_total,0,'Pembelian kredit '||coalesce(NEW.supplier,''));
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description)
      VALUES (coalesce(NEW.created_at::date, now()::date),'supplier_debt',NEW.id,'2000',0,v_total,'Hutang ke '||coalesce(NEW.supplier,''));
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'supplier_debt journal: %', SQLERRM; END;
  RETURN NEW;
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_fn_post_supplier_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_amt numeric; v_cash text; v_debt uuid; v_pid uuid;
BEGIN
  v_pid  := COALESCE(NEW.id, OLD.id);
  v_debt := COALESCE(NEW.supplier_debt_id, OLD.supplier_debt_id);
  -- bersihkan jurnal lama untuk payment ini
  DELETE FROM public.accounting_entries WHERE source_type='supplier_payment' AND source_id=v_pid;
  DELETE FROM public.cash_movements     WHERE source_type='supplier_payment' AND source_id=v_pid;
  -- repost hanya kalau aktif (bukan delete, bukan soft-deleted)
  IF (TG_OP <> 'DELETE') AND NEW.deleted_at IS NULL THEN
    v_amt := round(coalesce(NEW.amount,0));
    v_cash := public.acc_cash_code(NEW.method);
    IF v_amt > 0 THEN
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'supplier_payment',NEW.id,'2000',v_amt,0,'Bayar hutang supplier',NEW.cashier_id);
      INSERT INTO public.accounting_entries(entry_date,source_type,source_id,account_code,debit,credit,description,cashier_id)
      VALUES (NEW.paid_at::date,'supplier_payment',NEW.id,v_cash,0,v_amt,'Kas/Bank keluar (hutang supplier)',NEW.cashier_id);
      INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,note,cashier_id)
      VALUES (NEW.paid_at,'out',coalesce(NEW.method,'transfer'),v_amt,'supplier_payment',NEW.id,'Bayar hutang supplier',NEW.cashier_id);
    END IF;
  END IF;
  -- recompute paid parent dari SUM payment non-deleted
  UPDATE public.supplier_debts
    SET paid = (SELECT COALESCE(sum(round(amount)),0) FROM public.supplier_debt_payments WHERE supplier_debt_id=v_debt AND deleted_at IS NULL)
    WHERE id = v_debt;
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'supplier_payment: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_fn_post_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_total numeric; v_paid numeric; v_rem numeric; v_cash text; v_date date;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=OLD.id;
    DELETE FROM public.cash_movements     WHERE source_type='sale' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM public.accounting_entries WHERE source_type='sale' AND source_id=NEW.id;
  DELETE FROM public.cash_movements     WHERE source_type='sale' AND source_id=NEW.id;
  IF (COALESCE(NEW.order_status,'') = 'dibatalkan') THEN RETURN NEW; END IF;
  v_total := round(COALESCE(NEW.total,0));
  v_paid  := round(COALESCE(NEW.paid,0));
  v_rem   := greatest(0, v_total - v_paid);
  v_cash  := public.acc_cash_code(NEW.payment_method);
  v_date  := COALESCE(NEW.created_at::date, now()::date);
  IF v_total <= 0 THEN RETURN NEW; END IF;
  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
  VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'4000',0,v_total,'Penjualan '||COALESCE(NEW.invoice_no,''),NEW.cashier_id);
  IF v_paid > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,v_cash,v_paid,0,'Penerimaan penjualan',NEW.cashier_id);
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note,cashier_id)
    VALUES (COALESCE(NEW.created_at,now()),'in',COALESCE(NEW.payment_method,'cash'),v_paid,'sale',NEW.id,NEW.invoice_no,'Penjualan',NEW.cashier_id);
  END IF;
  IF v_rem > 0 THEN
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description,cashier_id)
    VALUES (v_date,'sale',NEW.id,NEW.invoice_no,'1200',v_rem,0,'Piutang penjualan',NEW.cashier_id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'acc_fn_post_transaction dilewati: %', SQLERRM;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_recalc_bank_loan(p_loan uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_awal numeric; v_paid numeric; v_sisa numeric;
BEGIN
  SELECT COALESCE(pokok_awal, sisa_pokok, 0) INTO v_awal FROM public.bank_loans WHERE id = p_loan;
  SELECT COALESCE(sum(round(amount)),0) INTO v_paid
    FROM public.bank_loan_payments WHERE loan_id = p_loan AND deleted_at IS NULL;
  v_sisa := greatest(0, COALESCE(v_awal,0) - v_paid);
  UPDATE public.bank_loans
     SET sisa_pokok = v_sisa,
         status = CASE WHEN v_sisa <= 0 THEN 'lunas' ELSE 'aktif' END
   WHERE id = p_loan;
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_recap_admin(p_from date, p_to date)
 RETURNS TABLE(cashier_id uuid, revenue numeric, cash_in numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT e.cashier_id,
         COALESCE(sum(CASE WHEN e.account_code='4000' THEN e.credit - e.debit ELSE 0 END),0) AS revenue,
         COALESCE(sum(CASE WHEN e.account_code IN ('1000','1100') THEN e.debit - e.credit ELSE 0 END),0) AS cash_in
  FROM public.accounting_entries e
  WHERE e.source_type='sale' AND e.entry_date BETWEEN p_from AND p_to
  GROUP BY e.cashier_id;
$function$;
CREATE OR REPLACE FUNCTION public.acc_repost_asset_purchase(p_asset_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE a public.assets%ROWTYPE; p record; v_cash text;
BEGIN
  DELETE FROM public.accounting_entries
   WHERE (source_type='asset_purchase' AND source_id=p_asset_id)
      OR (source_type='asset_purchase_payment' AND invoice_no=p_asset_id::text);
  DELETE FROM public.cash_movements
   WHERE source_type='asset_purchase_payment' AND invoice_no=p_asset_id::text;

  SELECT * INTO a FROM public.assets WHERE id=p_asset_id;
  IF NOT FOUND OR a.deleted_at IS NOT NULL OR NOT COALESCE(a.payment_tracking,false) THEN RETURN; END IF;

  INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description)
  VALUES
    (a.purchase_date,'asset_purchase',a.id,a.id::text,'1400',round(a.purchase_price),0,'Perolehan aset '||COALESCE(a.name,'')),
    (a.purchase_date,'asset_purchase',a.id,a.id::text,'2100',0,round(a.purchase_price),'Utang perolehan aset '||COALESCE(a.name,''));

  FOR p IN SELECT * FROM public.asset_purchase_payments
            WHERE asset_id=a.id AND deleted_at IS NULL ORDER BY payment_date,created_at
  LOOP
    v_cash := CASE WHEN p.payment_method IN ('transfer','qris') THEN '1100' ELSE '1000' END;
    INSERT INTO public.accounting_entries(entry_date,source_type,source_id,invoice_no,account_code,debit,credit,description)
    VALUES
      (p.payment_date,'asset_purchase_payment',p.id,a.id::text,'2100',round(p.amount),0,'Pembayaran aset '||COALESCE(a.name,'')),
      (p.payment_date,'asset_purchase_payment',p.id,a.id::text,v_cash,0,round(p.amount),'Kas keluar pembelian aset '||COALESCE(a.name,''));
    INSERT INTO public.cash_movements(moved_at,direction,method,amount,source_type,source_id,invoice_no,note)
    VALUES ((p.payment_date::text||' 12:00:00+07')::timestamptz,'out',p.payment_method,round(p.amount),'asset_purchase_payment',p.id,a.id::text,'Pembelian aset '||COALESCE(a.name,''));
  END LOOP;
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_resync()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- sentuh ulang baris valid → trigger repost; baris deleted ikut tersentuh
  -- tetapi trigger akan menghapus jurnalnya (karena deleted_at IS NOT NULL).
  UPDATE public.transactions SET total = total WHERE TRUE;
  BEGIN UPDATE public.expenses  SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE public.purchases SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE public.supplier_debt_payments SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE public.bank_loan_payments     SET amount = amount WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN UPDATE public.supplier_debts SET total = total WHERE TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
  -- buang jurnal/arus kas yatim dari expenses/purchases yang sudah soft-deleted
  BEGIN
    DELETE FROM public.accounting_entries ae
      WHERE ae.source_type='expense' AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id=ae.source_id AND e.deleted_at IS NOT NULL);
    DELETE FROM public.cash_movements cm
      WHERE cm.source_type='expense' AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id=cm.source_id AND e.deleted_at IS NOT NULL);
    DELETE FROM public.accounting_entries ae
      WHERE ae.source_type='purchase' AND EXISTS (SELECT 1 FROM public.purchases p WHERE p.id=ae.source_id AND p.deleted_at IS NOT NULL);
    DELETE FROM public.cash_movements cm
      WHERE cm.source_type='purchase' AND EXISTS (SELECT 1 FROM public.purchases p WHERE p.id=cm.source_id AND p.deleted_at IS NOT NULL);
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END; $function$;
CREATE OR REPLACE FUNCTION public.acc_summary(p_from date, p_to date)
 RETURNS json
 LANGUAGE sql
 STABLE
AS $function$
  SELECT json_build_object(
    'revenue',    COALESCE((SELECT sum(credit-debit) FROM public.accounting_entries WHERE account_code='4000' AND entry_date BETWEEN p_from AND p_to),0),
    'hpp',        COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='5000' AND entry_date BETWEEN p_from AND p_to),0),
    'expense',    COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='6000' AND entry_date BETWEEN p_from AND p_to),0),
    'cash_in',    COALESCE((SELECT sum(amount) FROM public.cash_movements WHERE direction='in'  AND moved_at::date BETWEEN p_from AND p_to),0),
    'cash_out',   COALESCE((SELECT sum(amount) FROM public.cash_movements WHERE direction='out' AND moved_at::date BETWEEN p_from AND p_to),0),
    'kas',        COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='1000' AND entry_date <= p_to),0),
    'bank',       COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='1100' AND entry_date <= p_to),0),
    'piutang',    COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='1200' AND entry_date <= p_to),0),
    'persediaan', COALESCE((SELECT sum(debit-credit) FROM public.accounting_entries WHERE account_code='1300' AND entry_date <= p_to),0),
    'hutang',     COALESCE((SELECT sum(credit-debit) FROM public.accounting_entries WHERE account_code='2000' AND entry_date <= p_to),0)
  );
$function$;
CREATE OR REPLACE FUNCTION public.acc_validate_asset_purchase_payment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_price numeric; v_paid numeric;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT round(purchase_price) INTO v_price FROM public.assets WHERE id=NEW.asset_id;
  SELECT COALESCE(sum(round(amount)),0) INTO v_paid
    FROM public.asset_purchase_payments
   WHERE asset_id=NEW.asset_id AND deleted_at IS NULL AND id<>NEW.id;
  IF round(NEW.amount)+v_paid > COALESCE(v_price,0) THEN
    RAISE EXCEPTION 'Pembayaran aset melebihi sisa utang';
  END IF;
  RETURN NEW;
END; $function$;
CREATE OR REPLACE FUNCTION public.recalculate_customer_summary(p_customer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_trx_count   integer;
  v_total_spent numeric;
  v_total_debt  numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(total), 0)
    INTO v_trx_count, v_total_spent
    FROM public.transactions
   WHERE customer_id = p_customer_id;

  SELECT COALESCE(SUM(remaining), 0)
    INTO v_total_debt
    FROM public.debts
   WHERE customer_id = p_customer_id
     AND status = 'aktif';

  UPDATE public.customers
     SET total_transactions = v_trx_count,
         total_spent        = v_total_spent,
         total_debt         = v_total_debt
   WHERE id = p_customer_id;
END $function$;
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;
CREATE OR REPLACE FUNCTION public.tg_bump_customer_stats()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    UPDATE public.customers
      SET total_transactions = total_transactions + 1,
          total_spent = total_spent + NEW.total,
          total_debt  = total_debt + NEW.remaining
      WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.tg_recalc_customer_after_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.customer_id IS NOT NULL THEN
    PERFORM public.recalculate_customer_summary(OLD.customer_id);
  END IF;
  RETURN OLD;
END $function$;
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $function$;
CREATE TRIGGER acc_trg_asset_payment AFTER INSERT OR DELETE OR UPDATE ON public.asset_purchase_payments FOR EACH ROW EXECUTE FUNCTION acc_asset_payment_changed();
CREATE TRIGGER acc_validate_asset_purchase_payment BEFORE INSERT OR UPDATE ON public.asset_purchase_payments FOR EACH ROW EXECUTE FUNCTION acc_validate_asset_purchase_payment();
CREATE TRIGGER acc_trg_asset_master_purchase AFTER INSERT OR UPDATE OF purchase_date, purchase_price, name, payment_tracking, deleted_at ON public.assets FOR EACH ROW EXECUTE FUNCTION acc_asset_master_changed();
CREATE TRIGGER acc_trg_bank_payment AFTER INSERT OR DELETE OR UPDATE ON public.bank_loan_payments FOR EACH ROW EXECUTE FUNCTION acc_fn_post_bank_payment();
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
CREATE TRIGGER debts_recalc_customer AFTER DELETE ON public.debts FOR EACH ROW EXECUTE FUNCTION tg_recalc_customer_after_delete();
CREATE TRIGGER debts_updated_at BEFORE UPDATE ON public.debts FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
CREATE TRIGGER acc_trg_employee_advance_payment AFTER INSERT OR DELETE OR UPDATE ON public.employee_cash_advance_payments FOR EACH ROW EXECUTE FUNCTION acc_fn_post_employee_advance_payment();
CREATE TRIGGER acc_trg_employee_advance BEFORE INSERT OR DELETE OR UPDATE OF amount, paid, advance_date, payment_method, deleted_at, is_opening ON public.employee_cash_advances FOR EACH ROW EXECUTE FUNCTION acc_fn_post_employee_advance();
CREATE TRIGGER acc_trg_expense AFTER INSERT OR DELETE OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION acc_fn_post_expense();
CREATE TRIGGER acc_trg_purchase AFTER INSERT OR DELETE OR UPDATE ON public.purchases FOR EACH ROW EXECUTE FUNCTION acc_fn_post_purchase();
CREATE TRIGGER settings_updated_at BEFORE UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
CREATE TRIGGER acc_trg_supplier_payment AFTER INSERT OR DELETE OR UPDATE ON public.supplier_debt_payments FOR EACH ROW EXECUTE FUNCTION acc_fn_post_supplier_payment();
CREATE TRIGGER acc_trg_supplier_debt BEFORE INSERT OR DELETE OR UPDATE OF total, paid, deleted_at ON public.supplier_debts FOR EACH ROW EXECUTE FUNCTION acc_fn_post_supplier_debt();
CREATE TRIGGER acc_trg_transaction AFTER INSERT OR DELETE OR UPDATE OF total, paid, remaining, payment_method, order_status ON public.transactions FOR EACH ROW EXECUTE FUNCTION acc_fn_post_transaction();
CREATE TRIGGER transactions_bump_customer AFTER INSERT ON public.transactions FOR EACH ROW EXECUTE FUNCTION tg_bump_customer_stats();
CREATE TRIGGER transactions_recalc_customer AFTER DELETE ON public.transactions FOR EACH ROW EXECUTE FUNCTION tg_recalc_customer_after_delete();
ALTER TABLE public."accounting_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."admin_bank_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."admin_book_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."admin_invoice_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."admins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."asset_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."asset_purchase_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."asset_sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."bank_loan_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."bank_loans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."books" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."cash_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."credibook_income" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."customer_owner_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."debt_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."debts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."employee_cash_advance_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."employee_cash_advances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."expense_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."liabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."migration_details" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."order_customer_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."prepaid_rent_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."prepaid_rents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."product_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."purchases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."receivable_customer_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."store_bank_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."store_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."store_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."supplier_debt_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."supplier_debts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."transactions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon all accounting_entries" ON public."accounting_entries" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all accounts" ON public."accounts" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all admin_bank_accounts" ON public."admin_bank_accounts" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all admin_book_access" ON public."admin_book_access" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all admin_invoice_profiles" ON public."admin_invoice_profiles" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon admins" ON public."admins" AS PERMISSIVE FOR ALL TO "anon" USING (true) WITH CHECK (true);
CREATE POLICY "anon all admins" ON public."admins" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all asset_categories" ON public."asset_categories" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all asset_purchase_payments" ON public."asset_purchase_payments" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all asset_sales" ON public."asset_sales" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all assets" ON public."assets" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all bank_loan_payments" ON public."bank_loan_payments" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all bank_loans" ON public."bank_loans" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all books" ON public."books" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all cash_movements" ON public."cash_movements" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all credibook_income" ON public."credibook_income" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all customer_owner_changes" ON public."customer_owner_changes" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all customers" ON public."customers" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon customers" ON public."customers" AS PERMISSIVE FOR ALL TO "anon" USING (true) WITH CHECK (true);
CREATE POLICY "Allow all debt_payments" ON public."debt_payments" AS PERMISSIVE FOR ALL TO "anon", "authenticated" USING (true) WITH CHECK (true);
CREATE POLICY "anon all debt_payments" ON public."debt_payments" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "Allow all debts" ON public."debts" AS PERMISSIVE FOR ALL TO "anon", "authenticated" USING (true) WITH CHECK (true);
CREATE POLICY "anon all debts" ON public."debts" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon debts" ON public."debts" AS PERMISSIVE FOR ALL TO "anon" USING (true) WITH CHECK (true);
CREATE POLICY "anon all employee_cash_advance_payments" ON public."employee_cash_advance_payments" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all employee_cash_advances" ON public."employee_cash_advances" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all employees" ON public."employees" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all expense_categories" ON public."expense_categories" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all expenses" ON public."expenses" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all liabilities" ON public."liabilities" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all migration_details" ON public."migration_details" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all order_customer_changes" ON public."order_customer_changes" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all prepaid_sched" ON public."prepaid_rent_schedules" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all prepaid_rents" ON public."prepaid_rents" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all product_categories" ON public."product_categories" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all products" ON public."products" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon products" ON public."products" AS PERMISSIVE FOR ALL TO "anon" USING (true) WITH CHECK (true);
CREATE POLICY "anon all purchases" ON public."purchases" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all receivable_customer_changes" ON public."receivable_customer_changes" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "Allow public read settings" ON public."settings" AS PERMISSIVE FOR SELECT TO "anon" USING (true);
CREATE POLICY "anon all settings" ON public."settings" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon settings" ON public."settings" AS PERMISSIVE FOR ALL TO "anon" USING (true) WITH CHECK (true);
CREATE POLICY "anon all store_bank_accounts" ON public."store_bank_accounts" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all store_contacts" ON public."store_contacts" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all store_locations" ON public."store_locations" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all supplier_debt_payments" ON public."supplier_debt_payments" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all supplier_debts" ON public."supplier_debts" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all suppliers" ON public."suppliers" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon all transactions" ON public."transactions" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY "anon transactions" ON public."transactions" AS PERMISSIVE FOR ALL TO "anon" USING (true) WITH CHECK (true);
COMMIT;
