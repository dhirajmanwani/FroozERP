# FroozERP Project Status

Last updated: June 4, 2026

## Architecture

FroozERP is a local-first fruit retail ERP built with:

- Frontend: React 19, Vite, Axios, QRCode
- Backend: Node.js, Express, PostgreSQL `pg` pool
- Database: PostgreSQL
- Styling: custom CSS premium dark ERP theme

The current application is structured as a single React shell with module-based views rendered from `frontend/src/App.jsx`. The backend is a single Express server in `backend/server.js` with API routes, database initialization, schema upgrades, business calculations, and reporting queries.

Core architecture decisions:

- PostgreSQL is the source of truth for products, purchases, sales, inventory, accounts, settings, reports, users, returns, and waste.
- Database schema initialization is handled on backend startup using `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- Inventory costing uses landed cost and FIFO batch deduction.
- Settings are database-backed where business rules must be owner-editable.
- Reports are generated from actual operational records, not mock data.
- The UI uses one left sidebar with consolidated modules to avoid navigation clutter.

## Completed Modules

### Authentication and User Access

- Login
- Role-based permissions
- User Management inside Settings
- Password reset/change support
- Password hash support with backward-compatible login migration
- User profile panel from sidebar
- Active/inactive user status
- Safe delete behavior for users with transaction history

Roles:

- Owner
- Admin
- Cashier
- Purchase Manager
- Inventory Manager

### Dashboard

- Owner-level dashboard analytics
- KPI cards
- Sales trend
- Profit trend
- Expense trend
- Net profit trend
- Purchase vs sales comparison
- Top selling products
- Low stock panel
- Business insight cards
- Supplier/customer outstanding metrics
- Returns and waste dashboard metrics

### Product Management

- Add product
- Edit product
- Deactivate/cancel product
- Duplicate product prevention
- Product origin type: Local / Imported
- Category, unit, barcode, minimum stock, selling rate
- Product audit trail
- Safe handling of products with transactions

### Purchase Entry

- Supplier account dropdown requirement
- Cash purchase / credit purchase support
- Mandi tax calculation
- Freight charges
- Labour charges
- Other charges
- Supplier rebate calculation
- Gross amount and net payable calculation
- Effective landed cost per unit
- Inventory batch creation
- Supplier outstanding impact
- Purchase edit
- Purchase cancel with inventory protection
- Purchase audit trail

### Inventory

- Batch-wise inventory
- FIFO deduction
- Remaining quantity tracking
- Batch cancellation/reversal support
- Landed cost valuation
- Stock movement reporting
- Low stock support

### POS Billing

- Product search
- Barcode entry
- Keyboard-friendly billing flow
- Cart with quantity editing
- Item discount
- Invoice-level discount slabs
- Cash / UPI / Card / Mixed payment
- Customer details
- Walk-in customer support
- Save Bill
- Print Bill
- Save and Print
- Thermal and A4 invoice modes
- WhatsApp message workflow
- UPI QR invoice support
- Weighing scale mode foundation with manual fallback

### Sales History

- Sales list
- Invoice view
- Sale edit
- Sale cancellation
- Inventory restoration on cancel/edit
- Audit trail
- Edited/cancelled bill reporting

### Sale Returns / Refunds

- Return entry without editing original invoice
- Select invoice
- Select return products
- Return quantity
- Return reason
- Refund types:
  - Cash Refund
  - UPI Refund
  - Credit Note
  - Adjustment Against Future Sale
- Inventory restoration on return
- Return reports

### Waste Management

- Waste entry
- Waste types:
  - Daagi
  - Sampling
  - Personal Use
  - Other
- Inventory reduction
- Waste cost calculation
- Waste reports
- Most wasted product analytics

### Accounts

The separate customer/supplier/payment/ledger areas were consolidated into one Accounts module.

Tabs/sections:

- Account Master
- Ledger
- Payments
- Outstanding

Supported account types:

- Customer
- Supplier
- Transport Vendor
- Commission Agent
- Staff
- Other

Payment workflows:

- Receive customer payment
- Pay supplier
- Add supplier rebate received
- Cash / UPI / Bank / Cheque support where applicable
- Payment edit
- Payment cancel
- Payment audit trail

### Expenses

- Add expenses
- Edit expenses
- Payment mode tracking
- Expense reports
- Dashboard expense trends

### Sale Rate Update

- Owner/Admin sale rate controls
- Suggested sale rate based on latest landed cost and desired margin
- Select suggested rate per product
- Select all visible suggested rates
- Manual new rate editing
- Bulk save selected rates
- Confirmation modal before saving
- Sale rate history

### Report Center

Reports are organized by category and open one report at a time.

Categories:

- Sales Reports
- Purchase Reports
- Accounts & Ledger
- Sale Returns
- Waste Management
- Inventory
- Financial Reports

Reports include:

- Sales by Date
- Sales by Product
- Sales by Customer
- Sales History
- Edited Bills
- Cancelled Bills
- Discount Report
- Purchases by Date
- Purchases by Product
- Purchases by Supplier
- Purchase Outstanding
- Purchase Edit/Cancel Report
- Customer Ledger
- Supplier Ledger
- Account Statement
- Payment Report
- Payment Mode Summary
- Receivable Report
- Payable Report
- Sale Return History
- Return Value Report
- Return Reason Analysis
- Daily Waste
- Monthly Waste
- Product Wise Waste
- Most Wasted Products
- Waste Cost Report
- Current Stock
- Low Stock
- Stock Movement
- Stock Valuation
- Profit & Loss
- Balance Sheet
- Day-to-Day Transaction Report
- Expense Report

### Settings

Completed settings sections:

- Business Settings
- Print Settings
- POS Weighing Scale Settings
- Payment / UPI QR Settings
- Mandi Tax Settings
- Supplier Rebate Settings
- Sale Rate Settings
- Discount Settings
- Role Permission Settings
- User Management
- Update Center
- Sync Settings
- Backup readiness

## Pending Modules / Future Work

The following areas are prepared but not fully production-complete:

- Real weighing scale hardware bridge
- Cloud sync delivery
- Online update download/install system
- Full backup export/import workflow
- GST billing engine
- Multi-branch operations
- Customer loyalty program
- Advanced staff attendance/payroll
- Full balance sheet-grade accounting with journal entries
- Production audit log viewer for all entities
- Automated tests
- Component/file-level frontend refactor
- Versioned migration system outside `server.js`

## Known Bugs / Issues / Risks

- Frontend is concentrated in one large `App.jsx`, which makes long-term maintenance harder.
- Backend is concentrated in one large `server.js`; route separation and service layering are pending.
- Database migrations are startup-based and should eventually move to versioned migration files.
- Some legacy APIs remain for customers, suppliers, supplier payments, and supplier ledger for compatibility with earlier modules.
- Real hardware scale reading is not implemented; the system only stores settings and provides manual fallback messaging.
- Thermal print output depends on browser and POS printer driver configuration.
- Cloud sync status is local/future-ready only; no remote service exists yet.
- Update Center buttons are UI/database readiness only; no online release channel exists.
- There is no automated test suite yet.

## Database Tables

Main tables initialized or upgraded by the backend:

- `branches`
- `roles`
- `users`
- `products`
- `suppliers`
- `customers`
- `accounts`
- `sales`
- `sale_items`
- `sale_payments`
- `sale_batch_allocations`
- `sale_audit_trail`
- `customer_ledger`
- `sale_permission_settings`
- `purchases`
- `purchase_items`
- `purchase_audit_trail`
- `inventory_batches`
- `stock_transactions`
- `mandi_tax_rules`
- `rebate_rules`
- `sale_rate_settings`
- `sale_rate_history`
- `sale_discount_rules`
- `product_audit_trail`
- `supplier_payments`
- `supplier_payment_audit`
- `customer_payments`
- `customer_payment_audit`
- `sale_returns`
- `sale_return_items`
- `waste_entries`
- `expenses`
- `business_settings`
- `pos_settings`
- `payment_settings`
- `role_permission_settings`
- `update_center`
- `sync_settings`
- `sync_queue`

Important cost/accounting fields:

- Purchase landed cost:
  - `basic_amount`
  - `mandi_tax_amount`
  - `freight_charges`
  - `labour_charges`
  - `other_charges`
  - `gross_amount`
  - `rebate_amount`
  - `net_payable`
  - `effective_cost_per_unit`

- Sales/profit:
  - `gross_amount`
  - `item_discount_amount`
  - `invoice_discount_amount`
  - `total_amount`
  - `total_cost`
  - `profit`

- Inventory batch valuation:
  - `purchase_rate`
  - `effective_cost_per_unit`
  - `remaining_qty`
  - `batch_status`

## API Summary

### Core

- `GET /`
- `POST /login`

### Dashboard

- `GET /dashboard-metrics`
- `GET /dashboard-analytics`
- `GET /dashboard-sales-trend`
- `GET /dashboard-profit-trend`
- `GET /dashboard-expense-trend`

### Products and Inventory

- `GET /products`
- `POST /products`
- `PUT /products/:id`
- `POST /products/:id/cancel`
- `GET /inventory`
- `GET /stock`

### Purchase

- `GET /purchase-rules`
- `GET /purchases`
- `POST /purchase`
- `PUT /purchase/:id`
- `POST /purchase/:id/cancel`

### Sales / POS

- `POST /sales`
- `GET /sales`
- `GET /sales/:id`
- `PUT /sales/:id`
- `POST /sales/:id/cancel`
- `GET /sales/:id/audit`
- `GET /sales-report/changes`

### Sale Returns

- `GET /sale-returns`
- `GET /sale-returns/options/:saleId`
- `POST /sale-returns`

### Waste

- `GET /waste-entries`
- `POST /waste-entries`

### Accounts

- `GET /accounts`
- `POST /accounts`
- `PUT /accounts/:accountKey`
- `GET /accounts/outstanding`
- `GET /accounts/ledger`
- `GET /accounts/payments`
- `POST /accounts/payments`
- `PUT /accounts/payments/:paymentKey`
- `POST /accounts/payments/:paymentKey/cancel`
- `GET /accounts/payments/:paymentKey/audit`

### Compatibility APIs

- `GET /suppliers`
- `POST /suppliers`
- `GET /suppliers/:id`
- `PUT /suppliers/:id`
- `DELETE /suppliers/:id`
- `GET /supplier-summary`
- `GET /supplier-payments`
- `POST /supplier-payments`
- `PUT /supplier-payments/:id`
- `POST /supplier-payments/:id/cancel`
- `GET /supplier-ledger`
- `GET /customers`
- `POST /customers`
- `PUT /customers/:id`
- `GET /customer-summary`
- `POST /customer-payments`
- `GET /customer-ledger`

### Settings

- `GET /settings`
- `GET /settings/purchase-rules`
- `GET /settings/role-permissions`
- `PUT /settings/role-permissions/:roleName`
- `GET /settings/update-center`
- `PUT /settings/update-center`
- `GET /settings/sync-status`
- `PUT /settings/sync-status`
- `PUT /settings/pos`
- `PUT /settings/payment`
- `PUT /settings/business`
- `PUT /settings/sale-rate`
- `GET /settings/discount-rules`
- `POST /settings/discount-rules`
- `PUT /settings/discount-rules/:id`
- `DELETE /settings/discount-rules/:id`
- `POST /settings/mandi-tax-rules`
- `PUT /settings/mandi-tax-rules/:id`
- `DELETE /settings/mandi-tax-rules/:id`
- `POST /settings/rebate-rules`
- `PUT /settings/rebate-rules/:id`
- `DELETE /settings/rebate-rules/:id`

### Users

- `GET /users`
- `POST /users`
- `PUT /users/:id`
- `PUT /users/:id/password`
- `POST /users/:id/deactivate`
- `POST /users/:id/reactivate`
- `DELETE /users/:id`

### Reports and Finance

- `GET /reports/summary`
- `GET /expenses`
- `POST /expenses`
- `PUT /expenses/:id`
- `GET /sale-rates`
- `POST /sale-rates/bulk`
- `GET /sale-rate-history`

## UI Design Decisions

- Premium dark retail-tech theme.
- Professional enterprise-grade branding:
  - `FEEL THE FREAKIN' FROOZ`
  - `by SRT Company`
- Left sidebar navigation instead of top buttons.
- Accounts module consolidates customers, suppliers, payments, ledger, and outstanding.
- Report Center opens category cards first, then report list, then one report view.
- POS is optimized for retail-counter speed:
  - keyboard search
  - barcode entry
  - quantity autofocus
  - Enter-to-continue flow
- Print behavior is separated:
  - Save
  - Print
  - Save & Print
- Thermal and A4 print modes are separated.
- UPI QR appears only when payment settings and payment mode support it.
- Settings are grouped into business, rules, access, hardware, payment, sync, updates, and backup.

## Integrations

- PostgreSQL database integration.
- FIFO inventory integration between purchases, inventory batches, sales, returns, and waste.
- POS integrates with:
  - Products
  - Inventory
  - Sales History
  - Dashboard
  - Discount Settings
  - Payment Settings
  - Customer accounts
- Purchase integrates with:
  - Supplier accounts
  - Inventory batches
  - Mandi tax settings
  - Rebate settings
  - Supplier outstanding
- Reports integrate with:
  - Sales
  - Purchases
  - Expenses
  - Payments
  - Returns
  - Waste
  - Inventory
  - Accounts
- WhatsApp invoice workflow opens WhatsApp with invoice message.
- UPI QR generation uses the `qrcode` frontend package.

## Future Roadmap

Recommended next engineering steps:

1. Split `frontend/src/App.jsx` into module components.
2. Split `backend/server.js` into route, service, repository, and migration layers.
3. Add automated backend tests for:
   - FIFO deduction
   - purchase edit/cancel
   - sale edit/cancel
   - returns
   - waste
   - ledgers
   - discounts
4. Add frontend tests for core POS and settings flows.
5. Move database migrations into a versioned migration system.
6. Add GST billing rules and tax reports.
7. Implement real local hardware bridge for weighing scales and printers.
8. Implement backup export/import.
9. Implement cloud sync service and conflict handling.
10. Add multi-branch inventory and accounting workflows.
11. Add customer loyalty and credit-note redemption workflows.
12. Add full accounting ledger/journal system for formal financial statements.

## Setup Instructions

### Prerequisites

- Node.js installed
- PostgreSQL installed and running
- Database named `froozerp`

Default backend database configuration:

```text
DB_USER=postgres
DB_HOST=localhost
DB_NAME=froozerp
DB_PASSWORD=8386
DB_PORT=5432
PORT=5000
```

Environment variables can override these values.

### Backend Setup

```powershell
cd C:\Users\DellPc\FroozERP\backend
npm install
node server.js
```

Backend URL:

```text
http://localhost:5000
```

On startup, the backend initializes and upgrades required database tables.

### Frontend Setup

```powershell
cd C:\Users\DellPc\FroozERP\frontend
npm install
npm.cmd run dev
```

Frontend usually runs on:

```text
http://localhost:5173
```

### Build Verification

Frontend lint:

```powershell
cd C:\Users\DellPc\FroozERP\frontend
npm.cmd run lint
```

Frontend production build:

```powershell
cd C:\Users\DellPc\FroozERP\frontend
npm.cmd run build
```

Backend syntax check:

```powershell
cd C:\Users\DellPc\FroozERP
node --check backend/server.js
```

### Default Login

If the database is empty, backend initialization creates a default owner user:

```text
Username: owner
Password: owner123
```

Change this password after first login in production use.

