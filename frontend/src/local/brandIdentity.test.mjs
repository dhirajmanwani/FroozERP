import test from "node:test";
import assert from "node:assert/strict";

import {
  BRAND_IDENTITY_STORAGE_KEY,
  BRAND_LOGO_EDGE,
  DEFAULT_BRAND_IDENTITY,
  checkBrandLogo,
  createBrandIdentityStore,
  hasUnusableLogo,
  readCachedBrandIdentity,
  resolveBrandIdentity,
  shrinkBrandLogo,
  uploadedLogo,
} from "./brandIdentity.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const memoryStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
};

test("the big line is the business name and the small line brand - by company", () => {
  assert.deepEqual(resolveBrandIdentity({ business_name: " Frooz ", brand_name: "Feel the Freakin' Frooz", company_name: "SRT Company" }), {
    title: "Frooz",
    tagline: "Feel the Freakin' Frooz - by SRT Company",
    logo: null,
  });
});

test("blank fields fall back without printing empty separators", () => {
  assert.deepEqual(resolveBrandIdentity({}), { title: "THE PEP", tagline: "", logo: null });
  assert.equal(resolveBrandIdentity({ business_name: "Frooz", company_name: "SRT" }).tagline, "SRT");
  assert.equal(resolveBrandIdentity({ business_name: "Frooz", brand_name: "Fresh" }).tagline, "Fresh");
  assert.equal(resolveBrandIdentity(null).title, "THE PEP");
});

test("a brand name that repeats the business name is not printed twice", () => {
  assert.equal(resolveBrandIdentity({ business_name: "Frooz", brand_name: "FROOZ", company_name: "SRT" }).tagline, "SRT");
});

test("only an uploaded picture is ever drawn, never a web address or a path", () => {
  assert.equal(resolveBrandIdentity({ logo_url: PNG }).logo, PNG);
  for (const value of ["https://example.com/logo.png", "C:\\logo.png", "/branding/x.png", "data:image/svg+xml;base64,PHN2Zz4=", "", null]) {
    assert.equal(resolveBrandIdentity({ logo_url: value }).logo, null, String(value));
    assert.equal(uploadedLogo(value), null, String(value));
  }
});

test("an old typed path is reported as unusable, an empty field is not", () => {
  assert.equal(hasUnusableLogo({ logo_url: "/logo.png" }), true);
  assert.equal(hasUnusableLogo({ logo_url: PNG }), false);
  assert.equal(hasUnusableLogo({ logo_url: "" }), false);
  assert.equal(hasUnusableLogo({}), false);
});

test("the store starts from what this computer remembers, else the Frooz default", () => {
  assert.equal(readCachedBrandIdentity(memoryStorage()), DEFAULT_BRAND_IDENTITY);
  assert.equal(readCachedBrandIdentity(null), DEFAULT_BRAND_IDENTITY);
  const broken = { getItem: () => { throw new Error("blocked"); } };
  assert.equal(readCachedBrandIdentity(broken), DEFAULT_BRAND_IDENTITY);
  const corrupt = memoryStorage();
  corrupt.setItem(BRAND_IDENTITY_STORAGE_KEY, "{not json");
  assert.equal(readCachedBrandIdentity(corrupt), DEFAULT_BRAND_IDENTITY);

  const storage = memoryStorage();
  storage.setItem(BRAND_IDENTITY_STORAGE_KEY, JSON.stringify({ title: "Frooz", tagline: "SRT", logo: PNG }));
  assert.deepEqual(createBrandIdentityStore(storage).getSnapshot(), { title: "Frooz", tagline: "SRT", logo: PNG });
});

test("setting a new identity notifies listeners once and remembers it", () => {
  const storage = memoryStorage();
  const store = createBrandIdentityStore(storage);
  let calls = 0;
  const unsubscribe = store.subscribe(() => { calls += 1; });
  store.set(resolveBrandIdentity({ business_name: "Frooz", logo_url: PNG }));
  store.set(resolveBrandIdentity({ business_name: "Frooz", logo_url: PNG }));
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot().title, "Frooz");
  assert.equal(JSON.parse(storage.map.get(BRAND_IDENTITY_STORAGE_KEY)).logo, PNG);
  unsubscribe();
  store.set({ title: "Other", tagline: "", logo: null });
  assert.equal(calls, 1);
});

test("a store whose storage refuses writes still updates the screen", () => {
  const store = createBrandIdentityStore({ getItem: () => null, setItem: () => { throw new Error("full"); } });
  store.set({ title: "Frooz", tagline: "", logo: null });
  assert.equal(store.getSnapshot().title, "Frooz");
});

const fakeTools = ({ width = 1000, height = 500, pngBytes = 1000, webpBytes = 1000, webpSupported = true, failOpen = false } = {}) => {
  const log = { drawn: null, asked: [] };
  const urlOf = (type, bytes) => `data:${type};base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`;
  return {
    log,
    tools: {
      createImageBitmap: async () => {
        if (failOpen) throw new Error("bad");
        return { width, height, close: () => {} };
      },
      createCanvas: (w, h) => ({
        width: w,
        height: h,
        getContext: () => ({ clearRect: () => {}, drawImage: (_bitmap, _x, _y, dw, dh) => { log.drawn = [dw, dh]; } }),
        toDataURL: (type, quality) => {
          log.asked.push([type, quality]);
          if (type === "image/webp") return webpSupported ? urlOf("image/webp", webpBytes) : urlOf("image/png", pngBytes);
          return urlOf("image/png", pngBytes);
        },
      }),
    },
  };
};

test("a logo is shrunk to the edge and kept as PNG when small enough", async () => {
  const { tools, log } = fakeTools();
  const dataUrl = await shrinkBrandLogo({}, tools);
  assert.deepEqual(log.drawn, [BRAND_LOGO_EDGE, BRAND_LOGO_EDGE / 2]);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(log.asked, [["image/png", undefined]]);
});

test("a heavy PNG falls back to WebP, which keeps transparency", async () => {
  const { tools } = fakeTools({ pngBytes: 150 * 1024, webpBytes: 20 * 1024 });
  assert.match(await shrinkBrandLogo({}, tools), /^data:image\/webp;base64,/);
});

test("without a WebP encoder the PNG is kept", async () => {
  const { tools } = fakeTools({ pngBytes: 150 * 1024, webpSupported: false });
  assert.match(await shrinkBrandLogo({}, tools), /^data:image\/png;base64,/);
});

test("an unreadable file says so in a sentence", async () => {
  const { tools } = fakeTools({ failOpen: true });
  await assert.rejects(shrinkBrandLogo({}, tools), /could not be opened as a picture/);
});

test("checkBrandLogo mirrors the server's 200 KB limit", () => {
  assert.equal(checkBrandLogo(PNG).ok, true);
  assert.equal(checkBrandLogo("").ok, false);
  assert.equal(checkBrandLogo("https://x/y.png").ok, false);
  const big = `data:image/png;base64,${"A".repeat(Math.ceil((201 * 1024) / 3) * 4)}`;
  assert.match(checkBrandLogo(big).message, /200 KB/);
});
