import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PRODUCT_PHOTO_EDGE,
  PRODUCT_PHOTO_MAX_BYTES,
  checkProductPhoto,
  fitWithin,
  imageFromTransfer,
  indexProductPhotos,
  photoDataUrlBytes,
  photoForProduct,
  shrinkProductPhoto,
  withProductPhoto,
} from "./productPhotos.js";

const jpeg = (bytes) => `data:image/jpeg;base64,${Buffer.alloc(bytes, 7).toString("base64")}`;

test("a photo keeps its shape and never grows", () => {
  assert.deepEqual(fitWithin(1200, 800), { width: PRODUCT_PHOTO_EDGE, height: 213 });
  assert.deepEqual(fitWithin(600, 1800), { width: 107, height: PRODUCT_PHOTO_EDGE });
  assert.deepEqual(fitWithin(100, 80), { width: 100, height: 80 });
  assert.equal(fitWithin(0, 50), null);
  assert.equal(fitWithin("x", 50), null);
});

test("data URL sizes are read without decoding", () => {
  assert.equal(photoDataUrlBytes(jpeg(1)), 1);
  assert.equal(photoDataUrlBytes(jpeg(2)), 2);
  assert.equal(photoDataUrlBytes(jpeg(3000)), 3000);
  assert.equal(photoDataUrlBytes("data:image/gif;base64,R0lGOD"), null);
  assert.equal(photoDataUrlBytes("https://example.com/mango.jpg"), null);
  assert.equal(photoDataUrlBytes(null), null);
});

test("the owner hears why a photo cannot be used before anything is sent", () => {
  assert.deepEqual(checkProductPhoto(jpeg(5000)), { ok: true, bytes: 5000 });
  assert.equal(checkProductPhoto("").ok, false);
  assert.match(checkProductPhoto("https://i.pinimg.com/x.jpg").message, /not a JPEG, PNG or WebP/);
  const big = checkProductPhoto(jpeg(PRODUCT_PHOTO_MAX_BYTES + 1));
  assert.equal(big.ok, false);
  assert.match(big.message, /over the 200 KB limit/);
});

test("a pasted image is found, and a pasted address is explained", () => {
  const file = { type: "image/png", name: "image.png" };
  const copied = { items: [{ kind: "string", type: "text/html" }, { kind: "file", type: "image/png", getAsFile: () => file }] };
  assert.equal(imageFromTransfer(copied).file, file);
  const dropped = { items: [], files: [{ type: "image/jpeg" }] };
  assert.equal(imageFromTransfer(dropped).file.type, "image/jpeg");
  const linkOnly = imageFromTransfer({ items: [{ kind: "string", type: "text/uri-list" }] });
  assert.equal(linkOnly.file, null);
  assert.match(linkOnly.message, /web address, not the photo/);
  assert.match(imageFromTransfer(null).message, /Copy image/);
});

test("a photo is shrunk to JPEG on a white ground, stepping quality down until small", async () => {
  const qualities = [];
  const drawn = [];
  const canvas = {
    getContext: () => ({ fillRect: (...a) => drawn.push(["fill", ...a]), drawImage: (_b, ...a) => drawn.push(["draw", ...a]), set fillStyle(v) { drawn.push(["style", v]); } }),
    toDataURL: (type, quality) => { qualities.push([type, quality]); return jpeg(quality > 0.7 ? 60000 : 30000); },
  };
  let madeWith = null;
  const url = await shrinkProductPhoto({}, {
    createImageBitmap: async () => ({ width: 1600, height: 1200, close() {} }),
    createCanvas: (w, h) => { madeWith = [w, h]; return canvas; },
  });
  assert.deepEqual(madeWith, [320, 240]);
  assert.deepEqual(drawn[0], ["style", "#ffffff"]);
  assert.deepEqual(qualities.map(([type]) => type), ["image/jpeg", "image/jpeg", "image/jpeg"]);
  assert.equal(photoDataUrlBytes(url), 30000);
  await assert.rejects(
    shrinkProductPhoto({}, { createImageBitmap: async () => { throw new Error("bad"); }, createCanvas: () => canvas }),
    /could not be opened as a photo/,
  );
});

test("photos are matched to products the canonical way", () => {
  const index = indexProductPhotos([
    { product_id: 12, photo: jpeg(10) },
    { product_id: "004", photo: jpeg(11) },
    { product_id: 9, photo: "https://not-a-data-url" },
    { product_id: null, photo: jpeg(12) },
  ]);
  assert.equal(index.size, 2);
  assert.equal(photoForProduct(index, { id: "12" }), jpeg(10));
  assert.equal(photoForProduct(index, { id: "004" }), jpeg(11));
  assert.equal(photoForProduct(index, { id: 4 }), null, "\"004\" and 4 are different products");
  assert.equal(photoForProduct(index, { id: "local-7", cloud_id: 12 }), jpeg(10));
  assert.equal(photoForProduct(index, { id: 9 }), null);
  assert.equal(photoForProduct(new Map(), { id: 12 }), null);
});

test("saving or removing one photo updates the list in place", () => {
  const list = [{ product_id: 1, photo: jpeg(1) }, { product_id: 2, photo: jpeg(2) }];
  const replaced = withProductPhoto(list, "2", jpeg(3), "t");
  assert.deepEqual(replaced.map((row) => row.product_id), [1, "2"]);
  assert.equal(replaced[1].photo, jpeg(3));
  assert.deepEqual(withProductPhoto(list, 1, null).map((row) => row.product_id), [2]);
});

test("App wires photos into Product Master and POS, and the drawings are gone", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /from "\.\/local\/productPhotos"/);
  assert.match(app, /\/api\/v3\/product-photos/);
  assert.match(app, /\/api\/v3\/products\/\$\{[^}]+\}\/photo/);
  assert.match(app, /onPaste=\{/);
  assert.match(app, /const photo = photoForProduct\(productPhotoIndex, product\);/);
  assert.doesNotMatch(app, /posFruitArt/);
  // Edit takes the owner to the form it just filled.
  assert.match(app, /<ModuleCard id="product-item-form"/);
  assert.match(app, /getElementById\("product-item-form"\)\?\.scrollIntoView/);
});
