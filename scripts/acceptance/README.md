# Disposable Acceptance Evidence

These tools use disposable SQLite fixtures and do not install or launch FroozERP. They emit explicit evidence levels so static/model checks cannot be presented as complete UI or packaged-runtime acceptance.

## Module preflight

`run-disposable-module-matrix.mjs` performs only:

- static source registration/endpoint preflight;
- fixture-model counts and Inventory boundary calculations;
- fresh/restored persisted-state model checks;
- malformed collection rejection checks;
- input hash, rollback, and harness-process network checks.

Its report uses `releaseAcceptanceClaim: "PRECHECK_ONLY"`. Every module has separate `staticPreflight`, `fixtureModelPreflight`, `backendRuntime`, and `frontendRuntime` evidence. Runtime fields remain `executed: false` and cannot be inferred from preflight success.

```powershell
node scripts/acceptance/run-disposable-module-matrix.mjs `
  --fixture F:\disposable-froozerp-fixture\fixture.sqlite3 `
  --fixture-root F:\disposable-froozerp-fixture `
  --restored-profile F:\disposable-froozerp-fixture\restored-profile.json `
  --report F:\disposable-froozerp-fixture\evidence\module-preflight.json `
  --expect-products 25 `
  --expect-lots 70 `
  --expect-active-lots 44 `
  --expect-stock-products 17 `
  --expect-quantity 1183.550 `
  --expect-stock-value 282275
```

Reports must be inside `--fixture-root`. An alternative `--evidence-root` is accepted only inside the repository's excluded `.cache` tree. Reports are atomically created with no-overwrite semantics.

## Actual React Inventory SSR

`render-stock-inventory-ssr.mjs` executes the exported real `StockInventoryReport` component through Vite SSR. It covers fresh PRODUCT, restored PRODUCT, stale persisted mode, LOT, genuine-empty, and explicit contract-error states. For the captured fixture it requires 17 product rows and 44 lot rows. It does not claim backend, Tauri WebView, or packaged-runtime execution.

```powershell
node scripts/acceptance/render-stock-inventory-ssr.mjs `
  --fixture F:\disposable-froozerp-fixture\fixture.sqlite3 `
  --fixture-root F:\disposable-froozerp-fixture `
  --report F:\disposable-froozerp-fixture\evidence\inventory-ssr.json `
  --repo-root F:\FroozERP
```

Both runners byte-copy the input before SQLite access, verify its hash, do not create or alter input WAL/SHM sidecars, and remove temporary working copies.

Run all self-tests with:

```powershell
npm run verify:disposable-matrix
```
